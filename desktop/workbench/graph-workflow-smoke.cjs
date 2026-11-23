const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function eventually(check) {
  for (let i=0; i<100; i++) {
    if (await check()) return;
    await wait(40);
  }
  assert.fail('Workflow condition did not become true');
}

async function run({window,store,directory,services,fixture,js}) {
  const [role]=fixture.roles;
  const open = `document.querySelector('[data-filter="workflow"]').click();$('chat-new').click();$('wf-graph-open').click();`;
  await js(open);
  assert.equal(await js(`$('graph-template-save').parentElement===document.querySelector('.dialog-header')`),true);
  await js(`$('graph-starter').click()`);
  assert.equal(await js(`document.querySelectorAll('.graph-role').length`),4);
  assert.equal(await js(`document.querySelectorAll('.graph-canvas .connection').length`),8);
  await js(`(() => {
    const canvas=document.querySelector('.graph-canvas');
    const nodes=canvas.querySelectorAll('.graph-role');
    const out=nodes[2].querySelector('.output_2');
    const input=nodes[0].querySelector('.input_1');
    out.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
    input.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
    nodes[2].querySelector('.graph-card-title').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
  })()`);
  assert.equal(await js(`document.querySelector('[data-exit-target="1"]').value`),'n1');
  await js(`const target=document.querySelector('[data-exit-target="1"]');target.value='n2';target.dispatchEvent(new Event('change'));`);
  await js(`(() => {
    const nodes=document.querySelectorAll('.graph-role');
    for (const node of nodes) {
      node.querySelector('.graph-card-title').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
      const role=document.querySelector('[data-field="roleId"]');
      role.value=${JSON.stringify(role.id)};
      role.dispatchEvent(new Event('input'));
    }
    $('graph-template-save').click();
  })()`);
  await eventually(()=>store.state.workflowTemplates?.length===1);
  assert(await js(`$('graph-feedback').textContent.includes('修复与真机验收')`));
  const persisted=store.persisted().workflowTemplates[0];
  assert.equal(persisted.nodes[2].exits[1].to,'n2');
  assert.equal(persisted.nodes[3].localOnly,true);
  fs.writeFileSync(path.join(directory,'graph-workflow-editor.png'),(await window.webContents.capturePage()).toPNG());
  await js(`$('dialog').close()`);
  await wait(80);
  await js(`$('chat-new').click();$('wf-graph-open').click();
    $('graph-template-select').value=${JSON.stringify(persisted.id)};
    $('graph-template-select').dispatchEvent(new Event('change'));$('graph-template-load').click()`);
  assert.equal(await js(`$('graph-goal').value`),'');
  assert.equal(await js(`document.querySelectorAll('.graph-canvas .connection').length`),8);

  const outcomes = [1,1,2,1,1,2,1,1,1,1,1,1,0,1];
  const attention=[];
  const {notifications}=services;
  notifications.attention=()=>attention.push(true);
  let releaseRetry;
  const retry=new Promise(resolve=>{releaseRetry=resolve;});
  services.agents.run=async (chatId,role,_project,_signal,_summary,context)=>{
    const chat=store.get('chats',chatId);
    const number=outcomes.shift() ?? 1;
    const message=store.message(chatId,{kind:'assistant',roleId:role.id,workflowAttemptId:context.workflowAttemptId,status:'running',text:'Checking'});
    services.agents.emit({chatId,message});
    if (!outcomes.length) await retry;
    message.status='complete';
    message.text='Evidence for '+chat.workflow.nodes[chat.workflow.nodeIndex].id+'\nWORKFLOW: '+(number?'EXIT '+number:'NEEDS_USER');
    services.agents.emit({chatId,message});
    assert.equal(notifications.complete(chatId),false);
    return message;
  };
  const launch=goal=>js(`$('graph-goal').value=${JSON.stringify(goal)};$('dialog-form').requestSubmit()`);
  await launch('First fixture task');
  const flows=()=>store.state.chats.filter(chat=>chat.workflow?.type==='graph');
  await eventually(()=>attention.length===1);
  assert.equal(flows()[0]?.workflow.status,'complete');
  assert.deepEqual(flows()[0].workflow.attempts.map(a=>a.nodeIndex),[0,1,2,1,2,3,1,2,3]);
  await eventually(()=>js(`!$('dialog').open && $('workflow-status')?.textContent.includes('本地真机测试')`));
  await js(`[...$('workflow-status').querySelectorAll('button')].find(b=>b.textContent==='打开流程副本').click()`);
  await launch('Second fixture task');
  await eventually(()=>attention.length===2);
  const blocked=flows()[0];
  assert.equal(blocked.workflow.status,'needs_check');
  await eventually(()=>js(`!$('dialog').open`));
  notifications.read(flows()[1].id);
  const other=store.saveProject({name:'Other project fixture',directories:[{locationId:'local',path:directory}]});
  await js(`(async()=>{
    state=await api.snapshot();
    projectId=${JSON.stringify(other.id)};
    chatId=undefined;
    renderSidebar();
    activateChat();
  })()`);
  // Start with an unread workflow and ensure the background project's dot clears on resume.
  blocked.unread=true;
  await js(`(async()=>{state=await api.snapshot();renderProjectNotifications();})()`);
  assert.equal(await js(`$('project-unread').hidden`),false);
  await js(`api['workflow-resume'](${JSON.stringify(blocked.id)},'retry')`);
  await eventually(()=>blocked.workflow.status==='running' && !outcomes.length);
  await eventually(()=>js(`$('project-unread').hidden`));
  assert.equal(blocked.unread,false);
  assert.equal(attention.length,2);
  releaseRetry();
  await eventually(()=>attention.length===3);
  await eventually(()=>js(`!$('project-unread').hidden`));
  assert.equal(blocked.workflow.status,'complete');
  assert.deepEqual(flows().map(chat=>[chat.workflow.goal,chat.workflow.attempts.length]),[['Second fixture task',5],['First fixture task',9]]);
  assert.deepEqual(store.state.workflowTemplates,[persisted]);
}
module.exports={run};
