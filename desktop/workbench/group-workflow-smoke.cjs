const assert = require('node:assert/strict');
const {historyFor} = require('./conversations.cjs');
const {prepare} = require('./chat-context.cjs');
const {buildPrompt} = require('./agents.cjs');

async function eventually(check) {
  for (let i=0;i<150;i++) {
    if (await check()) return;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  assert.fail('Group workflow condition did not become true');
}

async function run({store,services,fixture,js}) {
  const [role,backup,another]=fixture.roles;
  const a=store.createChat({name:'Source fixture',projectId:fixture.project.id,roleIds:[role.id]});
  const b=store.createChat({name:'Receiver fixture',projectId:fixture.project.id,roleIds:[role.id]});
  const c=store.createChat({name:'Second source fixture',projectId:fixture.project.id,roleIds:[role.id]});
  const invoke=(command,...args)=>js(`api[${JSON.stringify('workflow-'+command)}](...${JSON.stringify(args)})`);
  const open=chat=>js(`(async()=>{await openConversationResult(${JSON.stringify(chat)});await openTools('workflow');})()`);
  const publicText=chat=>historyFor(chat,{},true).map(message=>message.text).join('\n');
  const roleNode=(id,title,exits)=>({id,kind:'role',roleId:role.id,title,instruction:'Verify the fixture',exits,x:245,y:74});
  store.message(a.id,{kind:'user',text:'Source before launch',status:'accepted'});
  store.message(c.id,{kind:'user',text:'Second source context',status:'accepted'});
  await open({id:a.id,projectId:a.projectId});
  await js(`$('group-workflow-title').value='Source workflow';
    document.querySelector('[data-field="roleId"]').value=${JSON.stringify(role.id)};
    document.querySelector('[data-field="roleId"]').dispatchEvent(new Event('input'));
    document.querySelector('[data-field="instruction"]').value='Verify the source';
    document.querySelector('[data-field="instruction"]').dispatchEvent(new Event('input'));
    $('group-workflow-save').click();`);
  await eventually(()=>a.workflowDefinitions?.length===1);
  assert.equal(a.workflowRuns,undefined);
  const sourceDefinition=a.workflowDefinitions[0];
  await invoke('group-save',a.id,sourceDefinition.id,{...sourceDefinition,nodes:[
    {...sourceDefinition.nodes[0],exits:[{label:'Next',to:'n2'}]},
    roleNode('n3','Finish source',[{label:'Finished',to:'complete'}]),
    {id:'n2',kind:'context',title:'Read receiver',sourceChatId:b.id,x:450,y:74,exits:[{label:'Read source',to:'n3'}]},
  ]});

  const inner={id:'n1',kind:'loop',title:'Inner loop',rounds:2,mode:'until',x:245,y:74,
    exits:[{label:'Passed',to:'iteration_end'},{label:'Exhausted',to:'loop_break'}],
    body:{entry:'n1',nodes:[roleNode('n1','Check',[
      {label:'Retry',to:'iteration_end'},{label:'Pass',to:'loop_break'},
    ])]}};
  const outer={id:'n2',kind:'loop',title:'Outer loop',rounds:2,mode:'fixed',x:450,y:74,
    exits:[{label:'Finished',to:'complete'}],body:{entry:'n1',nodes:[inner]}};
  const bDefinition=await invoke('group-save',b.id,null,{title:'Receiver workflow',structured:true,entry:'n1',nodes:[
    {id:'n1',kind:'context',title:'Source context',sourceChatId:a.id,x:245,y:74,exits:[{label:'Read source',to:'n3'}]},
    outer,
    {id:'n3',kind:'context',title:'More context',sourceChatId:c.id,x:450,y:220,exits:[{label:'Read source',to:'n2'}]},
  ]});
  assert.equal(bDefinition.maxSteps,9);
  const other=await invoke('group-save',b.id,null,{title:'Second workflow',structured:true,entry:'n1',
    nodes:[roleNode('n1','Second check',[{label:'Finished',to:'complete'}])]});
  assert.equal(b.workflowDefinitions.length,2);
  await invoke('template-save',bDefinition);
  assert.equal(store.persisted().workflowTemplates[0].nodes[1].body.nodes[0].body.entry,'n1');
  await open({id:b.id,projectId:b.projectId});
  await js(`document.querySelector('#group-workflow-board .graph-loop .graph-loop-open').click();
    document.querySelector('#group-workflow-board .graph-loop .graph-loop-open').click();`);
  assert.match(await js(`document.querySelector('#group-workflow-board .graph-breadcrumb').textContent`),/Outer loop.*Inner loop/);
  await js(`document.querySelector('#group-workflow-board .graph-back').click();`);
  assert.match(await js(`document.querySelector('#group-workflow-board .graph-breadcrumb').textContent`),/Outer loop/);
  assert.doesNotMatch(await js(`document.querySelector('#group-workflow-board .graph-breadcrumb').textContent`),/Inner loop/);
  await js(`document.querySelector('#group-workflow-board .graph-back').click();`);
  assert.equal(await js(`Boolean(document.querySelector('#group-workflow-board .graph-back'))`),false);

  let releaseSource, sourceAttempts=0, firstReceiverAttempts=0, blockInitialReceiver=true;
  const sourceGate=new Promise(resolve=>{releaseSource=resolve;});
  const transfers=[];
  services.agents.run=async (id,participant,project,signal,_summary,context)=>{
    const chat=store.get('chats',id);
    const transfer=prepare(participant,project,{...chat,...context},false,buildPrompt);
    const message=store.message(id,{kind:'assistant',roleId:participant.id,roleName:participant.name,
      workflowRunId:context.workflowContextRunId,workflowTitle:context.workflowTitle,
      workflowPath:context.workflowPath,workflowAttemptId:context.workflowAttemptId,status:'running',text:''});
    if (id===a.id) {
      sourceAttempts++;
      if (sourceAttempts===1) Object.assign(message,{status:'complete',text:'Source still private\nWORKFLOW: EXIT 1'});
      else {
        await sourceGate;
        Object.assign(message,{status:'complete',text:'Source finalized\nWORKFLOW: EXIT 1'});
      }
    } else if (context.workflowTitle==='Fixture teams') {
      const verb=context.workflowPath[0].title;
      Object.assign(message,{status:'complete',text:verb==='验收'?'Review evidence\nVERDICT: PASS':'Implementation evidence'});
    } else if (context.workflowTitle==='Fixture generated') {
      if (participant.id===role.id) {
        Object.assign(message,{status:'failed',text:'Partial maintenance evidence',workflowSubmitted:true,
          stopConfirmed:false,errorCode:'REMOTE_CHANNEL_CLOSED',note:'Lost remote connection'});
      } else {
        assert.equal(participant.id,backup.id);
        assert.match(transfer.prompt,/Partial maintenance evidence/);
        assert.match(transfer.prompt,/still have work in progress/);
        Object.assign(message,{status:'complete',text:'Generated evidence\nWORKFLOW: DONE'});
      }
    } else if (context.workflowTitle==='Loop created on the canvas') {
      if (context.workflowPath.length===1) {
        Object.assign(message,{status:'complete',text:'Canvas evidence\nWORKFLOW: BLOCKED'});
      } else if (participant.id===role.id) {
        Object.assign(message,{status:'failed',errorCode:'CODEX_CAPACITY',note:'At capacity',stopConfirmed:true});
      } else {
        Object.assign(message,{status:'complete',text:'Canvas evidence'});
      }
    } else {
      transfers.push(transfer.prompt);
      firstReceiverAttempts++;
      if (firstReceiverAttempts===2&&blockInitialReceiver) {
        await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
        Object.assign(message,{status:'cancelled',text:'Interrupted intermediate evidence',stopConfirmed:true});
      } else {
        const exit=firstReceiverAttempts===1||firstReceiverAttempts===4?1:2;
        Object.assign(message,{status:'complete',text:'Receiver evidence '+firstReceiverAttempts+'\nWORKFLOW: EXIT '+exit});
      }
    }
    services.agents.emit({chatId:id,message});
    return message;
  };
  store.state.settings.maxJobs=2;
  await invoke('group-start',a.id,a.workflowDefinitions[0].id);
  await eventually(()=>sourceAttempts===2);
  assert.doesNotMatch(publicText(a),/Source still private/);
  const runId=await invoke('group-start',b.id,bDefinition.id,'Receiver launch goal');
  await eventually(()=>firstReceiverAttempts===2);
  await assert.rejects(invoke('group-start',b.id,other.id));
  assert.match(transfers[1],/Source before launch/);
  assert.match(transfers[1],/Second source context/);
  assert.match(transfers[1],/Receiver evidence 1/);
  assert.doesNotMatch(transfers[1],/Source still private|Source finalized/);
  assert.doesNotMatch(publicText(b),/Receiver evidence 1|Receiver launch goal/);
  await eventually(()=>js(`document.querySelector('#messages').textContent.includes('Receiver evidence 1')`));
  await invoke('group-stop',b.id,runId);
  await eventually(()=>b.workflowRuns[0].status==='paused');
  assert.doesNotMatch(publicText(b),/Interrupted intermediate evidence/);
  releaseSource();
  await eventually(()=>a.workflowRuns[0].publishedAt);
  assert.match(publicText(a),/Source finalized/);
  const changed=structuredClone(bDefinition);
  changed.nodes[1].rounds=1;
  await invoke('group-save',b.id,bDefinition.id,changed);
  blockInitialReceiver=false;
  await invoke('group-resume',b.id,runId,'Resume fixture guidance');
  await eventually(()=>b.workflowRuns[0].publishedAt);
  assert.equal(b.workflowRuns[0].status,'complete');
  assert.equal(b.workflowRuns[0].nodes[1].rounds,2);
  assert.deepEqual(b.workflowRuns[0].attempts.map(attempt=>attempt.path.slice(1).map(step=>step.round)),
    [[1,1],[1,2],[1,2],[2,1],[2,2]]);
  assert.match(transfers[2],/Interrupted intermediate evidence/);
  assert.doesNotMatch(transfers[2],/Source finalized/);
  assert.match(publicText(b),/Receiver launch goal/);
  assert.match(publicText(b),/Receiver evidence 1/);
  assert.match(publicText(b),/Interrupted intermediate evidence/);
  assert.equal(b.messages.filter(message=>message.workflowResult).length,1);
  assert.equal(store.persisted().chats.find(chat=>chat.id===b.id).workflowRuns[0].status,'complete');

  await invoke('group-start',b.id,bDefinition.id);
  await eventually(()=>b.workflowRuns[1]?.publishedAt);
  assert.match(transfers.at(-1),/Source finalized/);

  await js(`$('group-workflow-teams').click();$('wf-title').value='Fixture teams';$('wf-criteria').value='Record the verifier outcome';$('dialog-form').requestSubmit();`);
  await eventually(()=>b.workflowDefinitions.some(item=>item.type==='teams'));
  assert.equal(b.workflowRuns.length,2);
  const teams=b.workflowDefinitions.find(item=>item.type==='teams');
  await invoke('group-start',b.id,teams.id);
  await eventually(()=>b.workflowRuns[2]?.publishedAt);
  assert.match(publicText(b),/Implementation evidence.*Review evidence/s);

  const generated=await invoke('group-save',b.id,null,{type:'generated',title:'Fixture generated',reworkLimit:1,nodes:[
    {title:'Verify',instruction:'Collect test evidence',domain:'General',duty:'Review',mode:'ordered',roleIds:[role.id,backup.id]},
  ]});
  await invoke('group-start',b.id,generated.id);
  await eventually(()=>b.workflowRuns[3]?.publishedAt);
  assert.match(publicText(b),/Generated evidence/);
  assert.equal(b.workflowRuns[3].stopUnconfirmed,undefined);
  await eventually(()=>js(`api.snapshot().then(snapshot=>!snapshot.inputBusy[${JSON.stringify(b.id)}])`));

  await js(`(() => {
    $('group-workflow-new').click();
    $('group-workflow-title').value='Loop created on the canvas';
    const set=(selector,value,event='input')=>{
      const control=document.querySelector('#group-workflow-board '+selector);
      control.value=value;control.dispatchEvent(new Event(event));
    };
    const configureRole=()=>{
      set('[data-field="roleId"]',${JSON.stringify(role.id)});
      set('[data-field="instruction"]','Capture fixture evidence');
    };
    configureRole();
    document.querySelector('#group-workflow-board .graph-toolbar button:nth-child(2)').click();
    set('[data-exit-target="0"]','complete','change');
    document.querySelector('#group-workflow-board .graph-role').onkeydown(new KeyboardEvent('keydown',{key:'Enter'}));
    set('[data-exit-target="0"]','n2','change');
    document.querySelector('#group-workflow-board .graph-loop-open').click();
    configureRole();
    document.querySelector('#group-workflow-board [data-add-backup]').click();
    set('[data-backup-role="0"]',${JSON.stringify(backup.id)},'change');
    document.querySelector('#group-workflow-board [data-add-backup]').click();
    document.querySelector('#group-workflow-board [data-backup-up="1"]').click();
    document.querySelector('#group-workflow-board .graph-back').click();
    $('group-workflow-save').click();
  })()`);
  await eventually(()=>b.workflowDefinitions.some(item=>item.title==='Loop created on the canvas'));
  const savedLoop=b.workflowDefinitions.find(item=>item.title==='Loop created on the canvas');
  assert.deepEqual(savedLoop.nodes[1].body.nodes[0].backupRoleIds,[another.id,backup.id]);
  const canvasRunId=await invoke('group-start',b.id,savedLoop.id);
  const canvasRun=b.workflowRuns.find(run=>run.id===canvasRunId);
  await eventually(()=>canvasRun.status==='needs_check' && canvasRun.attempts.length===1);
  await eventually(()=>js(`api.snapshot().then(snapshot=>!snapshot.inputBusy[${JSON.stringify(b.id)}])`));
  const priorReport=b.messages.find(message=>message.kind==='assistant' && message.workflowAttemptId===canvasRun.attempts[0].id);
  priorReport.text='Canvas evidence\nWORKFLOW: NEEDS_USER';
  store.save();
  await invoke('group-resume',b.id,canvasRunId);
  await eventually(()=>canvasRun.publishedAt);
  assert.equal(canvasRun.status,'complete');
  assert.deepEqual(canvasRun.attempts.map(attempt=>attempt.roleId),
    [role.id,role.id,another.id,role.id,another.id,role.id,another.id]);
}

module.exports={run};
