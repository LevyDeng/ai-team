const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(window,store,app,directory,services) {
  const fixture=require('./fixtures.cjs').seed(store,path.resolve(__dirname,'../..'));
  const modelCalls=[];let modelFailure=false;
  services.modelCatalogs.request=async (draft,options={})=>{
    if (!options.cacheOnly) modelCalls.push({ ...draft, force: options.force === true });
    if(modelFailure)throw new Error(modelFailure==='network'?'Could not connect to the model provider. Check the system proxy or network connection.':'Fixture catalog failure');
    return {models:[{id:'fixture-standard-model',label:'Standard Model'},{id:'rare-long-tail-model-alpha',label:'Rare Long-tail Model'},{id:'special-preview-model',label:'Special Preview Model'}],updatedAt:Date.now(),cached:!options.force};
  };
  const errors=[];window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await new Promise((resolve,reject)=>{window.webContents.once('did-finish-load',resolve);window.webContents.once('did-fail-load',(_event,code,description)=>reject(new Error('Fixture page failed to load: '+code+' '+description)));window.webContents.once('render-process-gone',(_event,details)=>reject(new Error('Fixture renderer exited: '+JSON.stringify(details))));});
  window.setContentSize(1488,1056);window.showInactive();await wait(700);
  const js=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(error){throw new Error('Smoke renderer step failed: '+code+'; '+error.message+'; '+errors.join('; '));}};
  fs.writeFileSync(path.join(directory,'init.json'),JSON.stringify(await js('({api:Boolean(window.desk),toast:document.querySelector("#toast").textContent,rows:document.querySelectorAll("[data-chat]").length,body:document.body.innerText.slice(0,1000)})'),null,2));
  fs.writeFileSync(path.join(directory,'initial.png'),(await window.webContents.capturePage()).toPNG());
  assert.equal(await js('Boolean(window.desk && document.querySelector("[data-chat]"))'),true);
  assert.equal(await js('document.querySelectorAll("#messages .message").length'),4);
  assert.equal(await js('document.querySelector("#messages").scrollHeight-document.querySelector("#messages").scrollTop-document.querySelector("#messages").clientHeight<50'),true);
  const status=await js('(async()=> (await window.desk.snapshot()).connectionStatus)()');
  assert(!Object.entries(status).some(([id,state])=>id!=='local'&&state==='ready'));
  if (process.argv.includes('--cli-updates-only')) {
    const updates = services.cliUpdates;
    const executable = path.join(directory, 'fixture-codex.exe');
    fs.writeFileSync(executable, 'Fixture CLI entry');
    const role = store.state.roles.find(item => item.engine === 'codex' && item.locationId === 'local');
    role.executable = executable;
    role.enabled = true;
    for (const peer of store.state.roles) if (peer !== role) peer.enabled = false;
    let installed = '1.9.0';
    const calls = [];
    updates.fetchLocal = async () => () => { throw new Error('Unexpected network'); };
    updates.npmEnvironment = async () => ({});
    updates.local = {
      codex: {
        managed: () => executable,
        installed: () => installed,
        latest: async () => { calls.push('check'); return '1.10.0'; },
        install: async ({ expected }) => { calls.push('install'); installed = expected; return { version: installed, executable }; },
      },
    };
    await updates.startup();
    const expect = async (expression, value) => {
      for (let i = 0; i < 40; i++) {
        if (await js(expression) === value) return;
        await wait(25);
      }
      assert.equal(await js(expression), value);
    };
    await expect('document.querySelector("#cli-nav-badge").textContent', '1');
    await js('document.querySelector("[data-page=settings]").click();document.querySelector("[data-settings-section=updates]").click()');
    await expect('document.querySelector(".cli-update-notice").textContent', '1 个 CLI 有可用更新。');
    await js('document.querySelector("[data-cli-preference=reminders]").click()');
    await expect('window.desk.snapshot().then(value => value.cliUpdates.reminders)', false);
    await expect('document.querySelector("#cli-nav-badge").hidden', true);
    await expect('document.querySelector(".cli-update-notice").hidden', true);
    await js('document.querySelector("[data-cli-preference=autoCheck]").click()');
    await expect('window.desk.snapshot().then(value => value.cliUpdates.autoCheck)', false);
    await js('document.querySelector("[data-cli-action=check]").click()');
    await expect('document.querySelector(".cli-update-batch-status").textContent', '1 项已检查');
    await js('document.querySelector("[data-cli-action=install]").click()');
    await expect('document.querySelector(".cli-update-batch-status").textContent', '1 项已更新');
    assert.deepEqual(calls, ['check', 'check', 'install']);
    assert.deepEqual(errors, []);
    console.log('CLI update center smoke checks passed.');
    app.exit(0);
    return;
  }
  if(process.argv.includes('--workspace-only')){await require('./workspace-smoke.cjs').run({window,store,app,fixture,js,errors,services});return;}
  if (process.argv.includes('--cursor-model-only')) {
    const role = store.saveRole({ ...fixture.roles[0], id:undefined, engine:'cursor', provider:'native', name:'Cursor fixture',
      model:'grok-4.7[context=256k,reasoning_effort=low,fast=true]' });
    services.modelCatalogs.request = async () => ({ updatedAt:Date.now(), models:[{
      id:'grok-4.7', label:'Grok 4.7', parameters:[
        {id:'context',category:'model_config',defaultValue:'256k',values:['256k','500k']},
        {id:'reasoning_effort',category:'thought_level',defaultValue:'high',values:['low','medium','high','xhigh']},
        {id:'fast',category:'model_config',defaultValue:'true',values:['false','true']},
      ],
    }] });
    await js(`(async()=>{state=await api.snapshot();showPage('roles');editRole(state.roles.find(r=>r.id===${JSON.stringify(role.id)}));await roleModelPicker.update();})()`);
    assert.deepEqual(await js(`[$('r-model').value,$('r-effort').disabled,$('r-effort').value]`), ['grok-4.7',false,'low']);
    await js(`$('r-effort').value='medium';$('r-effort').dispatchEvent(new Event('change'));$('role-form').requestSubmit();`);
    for(let i=0;i<30 && !store.get('roles',role.id).model.includes('reasoning_effort=medium');i++)await wait(30);
    assert.equal(store.get('roles',role.id).model,'grok-4.7[context=256k,reasoning_effort=medium,fast=true]');
    const chat = store.createChat({ projectId:fixture.chat.projectId, roleIds:[role.id], name:'Cursor model fixture' });
    store.saveChatRole(chat.id, role.id, {model:'',effort:''});
    await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(chat.id)};showPage('projects');activateChat();openChatRole(${JSON.stringify(role.id)});await chatModelPicker.update();})()`);
    assert.deepEqual(await js(`[$('chat-model-picker').querySelector('input').value,$('chat-effort').disabled,$('chat-effort').value]`), ['',false,'']);
    await js(`$('chat-effort').value='xhigh';$('chat-effort').dispatchEvent(new Event('change'));$('dialog-form').requestSubmit();`);
    for(let i=0;i<30 && !chat.roleSettings[role.id].model.includes('reasoning_effort=xhigh');i++)await wait(30);
    assert.equal(chat.roleSettings[role.id].model,'grok-4.7[context=256k,reasoning_effort=xhigh,fast=true]');
    assert.equal(store.get('roles',role.id).model,'grok-4.7[context=256k,reasoning_effort=medium,fast=true]');
    assert.deepEqual(errors, []);
    console.log('Cursor model settings smoke checks passed.');
    app.exit(0);
    return;
  }
  if (process.argv.includes('--role-enabled-only')) {
    const id = fixture.chat.roleIds[0], projectId = fixture.chat.projectId;
    const direct = store.createChat({ projectId, roleIds:[id], name:'Disabled-role fixture' });
    await js(`(async()=>{state=await api.snapshot();showPage('roles');editRole(role(${JSON.stringify(id)}));})()`);
    await js(`$('role-enabled').onclick()`);
    assert.equal(store.get('roles',id).enabled,false);
    assert.equal(await js(`$('role-enabled').textContent`),'启用角色');
    assert.equal(await js(`$('role-try').disabled`),true);
    await assert.rejects(js(`api.send({chatId:${JSON.stringify(direct.id)},roleIds:[${JSON.stringify(id)}],text:'Fixture message'})`),/已禁用/);
    assert.equal(direct.messages.length,0);
    await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(direct.id)};showPage('projects');activateChat();})()`);
    assert.equal(await js(`$('send').disabled`),true);
    await js(`openChat(null)`);
    assert.equal(await js(`[...$('chat-role-picker').querySelectorAll('input[type=checkbox]')].some(input=>input.value===${JSON.stringify(id)})`),false);
    await js(`$('dialog').close();showPage('roles');editRole(role(${JSON.stringify(id)}));`);
    await js(`$('role-enabled').onclick()`);
    assert.equal(store.get('roles',id).enabled,true);
    assert.deepEqual(direct.roleIds,[id]);
    assert.deepEqual(errors,[]);
    app.exit(0);
    return;
  }
  if (process.argv.includes('--remote-antigravity-only')) {
    const location = store.saveLocation({name:'Fixture VPS',host:'vps.invalid',username:'fixture',port:22,os:'linux',control:'ssh'});
    const calls = [];
    require('./remote-antigravity.cjs').configure = async (_locations, target, role) => {
      calls.push({ locationId: target.id, roleId: role.id });
      return true;
    };
    await js(`(async()=>{
      state=await api.snapshot();
      showPage('roles');
      editRole();
      $('r-name').value='Remote Antigravity fixture';
      $('r-engine').value='antigravity';
      $('r-engine').dispatchEvent(new Event('change'));
      $('r-location').value=${JSON.stringify(location.id)};
      $('r-location').dispatchEvent(new Event('change'));
    })()`);
    assert.equal(await js(`$('r-location').selectedOptions[0].disabled`), false);
    assert.equal(await js(`$('role-login').parentElement.className`), 'agent-runtime-actions');
    assert.equal(await js(`$('exe-pick').hidden`), true);
    await js(`$('role-login').onclick()`);
    await js(`$('role-login').onclick()`);
    const matching = store.state.roles.filter(role => role.name === 'Remote Antigravity fixture');
    assert.equal(matching.length, 1);
    assert.deepEqual(calls, Array(2).fill({ locationId: location.id, roleId: matching[0].id }));
    assert.deepEqual(errors, []);
    app.exit(0);
    return;
  }
  if (process.argv.includes('--files-only')) {
    const project = store.get('projects', fixture.chat.projectId);
    const root = path.join(directory, 'file explorer fixture');
    const folder = path.join(root, 'nested folder');
    fs.mkdirSync(folder, {recursive:true});
    const file = path.join(root, 'notes %23.txt');
    fs.writeFileSync(file, 'Explorer preview fixture');
    project.directories = [{locationId:'local', path:root}];
    const opened = [];
    services.shell.openPath = async target => { opened.push(['open', target]); return ''; };
    services.shell.showItemInFolder = target => opened.push(['select', target]);
    await js('(async()=>{state=await api.snapshot();await openTools("files");})()');
    assert.deepEqual(await js('Array.from(document.querySelectorAll(".file-row"), row => [row.title,getComputedStyle(row).justifyContent])'),
      [['nested folder','flex-start'],['notes %23.txt','flex-start']]);
    await js('document.querySelectorAll("[data-reveal-file]")[0].onclick()');
    await js('document.querySelectorAll("[data-reveal-file]")[1].onclick()');
    await js('document.querySelector("#file-explorer").onclick()');
    assert.deepEqual(opened, [['open',fs.realpathSync(folder)],['select',fs.realpathSync(file)],['open',fs.realpathSync(root)]]);
    await js('document.querySelectorAll("[data-file]")[1].onclick()');
    assert.equal(await js('document.querySelector("#file-preview").textContent'), 'Explorer preview fixture');
    await js('document.querySelector("#file-explorer").onclick()');
    assert.deepEqual(opened.at(-1), ['select',fs.realpathSync(file)]);
    await js('document.querySelector("#file-back").onclick()');
    await js('document.querySelectorAll("[data-file]")[0].onclick()');
    assert.equal(await js('document.querySelector("#file-path").textContent'), fs.realpathSync(folder));
    assert.deepEqual(errors, []);
    app.exit(0);
    return;
  }
  if(process.argv.includes('--links-only')){await require('./links-smoke.cjs').run({window,store,app,directory,services,fixture,js,errors});return;}
  if(process.argv.includes('--images-only')){await require('./message-images-smoke.cjs').run({window,store,app,directory,services,fixture,js,errors});return;}
  if(process.argv.includes('--skills-only')){await require('./skills-smoke.cjs').run({window,store,app,directory,services,fixture,js,errors});return;}
  const quitMode = ['idle', 'active', 'timeout', 'restart'].find(mode => process.argv.includes(`--quit-${mode}-only`));
  if (quitMode) { await require('./quit-smoke.cjs').run({window,store,app,services,fixture,js,mode:quitMode}); return; }
  if(process.argv.includes('--graph-workflow-only')){
    await require('./graph-workflow-smoke.cjs').run({window,store,directory,services,fixture,js});
    assert.deepEqual(errors,[]);
    console.log('Graph workflow smoke checks passed.');
    app.exit(0);return;
  }
  if(process.argv.includes('--group-workflow-only')){
    await require('./group-workflow-smoke.cjs').run({store,services,fixture,js});
    assert.deepEqual(errors,[]);
    console.log('Group workflow smoke passed.');
    app.exit(0);return;
  }
  if(process.argv.includes('--workflow-only')){
    const [primary,backup]=fixture.roles;
    const planner=store.saveRole({...primary,id:undefined,name:'Antigravity planner fixture',engine:'antigravity'});
    let releaseFirst;
    const gate=new Promise(resolve=>{releaseFirst=resolve;});
    const calls=[],routingCalls=[];
    const node={title:'Improve the viewer',instruction:'Update the view and verify the result',domain:'Frontend',duty:'Implementation'};
    services.agents.run=async(chatId,role,_project,_signal,_summary,context)=>{
      if(context.moderatorTask?.kind==='workflow-plan'){
        assert.equal(chatId,null);
        assert.equal(role.id,planner.id);
        assert.match(context.moderatorTask.prompt,/Preserve the existing behavior/);
        return {status:'complete',text:JSON.stringify({token:context.moderatorTask.token,title:'Generated viewer workflow',nodes:[node,{...node,title:'Verify the viewer'}]})};
      }
      const flow=store.get('chats',chatId).workflow;
      if(context.moderatorTask){
        routingCalls.push([flow.goal,flow.stage,role.id]);
        const choice = {token:context.moderatorTask.token,roleId:backup.id};
        if (flow.type==='generated') choice.reason='The backup has a matching rating.';
        return store.message(chatId,{kind:'assistant',roleId:role.id,roleName:role.name,moderatorTask:context.moderatorTask.kind,status:'complete',text:JSON.stringify(choice)});
      }
      if(flow.type==='generated'){
        const text = flow.nodeIndex===1 && !flow.reworkCount ? 'Fix the viewer width\nWORKFLOW: REWORK' : 'Verified result\nWORKFLOW: DONE';
        return store.message(chatId,{kind:'assistant',roleId:role.id,roleName:role.name,workflowAttemptId:context.workflowAttemptId,status:'complete',text});
      }
      calls.push([flow.goal,flow.stage,role.id]);
      if(calls.length===1)await gate;
      const result=flow.goal==='Blocked'||flow.stage==='implement'&&role.id===primary.id
        ?{status:'failed',note:'HTTP 429 quota exhausted'}:{status:'complete',text:flow.stage==='review'?'Checked\nVERDICT: PASS':'Patch saved'};
      return store.message(chatId,{kind:'assistant',roleId:role.id,roleName:role.name,workflowAttemptId:context.workflowAttemptId,...result});
    };
    assert.equal(await js(`document.querySelector('[data-filter="workflow"]').textContent`),'\u5de5\u4f5c\u6d41');
    await js(`document.querySelector('[data-filter="workflow"]').click();openWorkflow();$('wf-goal').value='Blocked';$('wf-criteria').value='Pass tests';[...$('wf-implement').querySelectorAll('button')].at(-1).click();$('dialog-form').requestSubmit()`);
    for(let i=0;i<80&&!calls.length;i++)await wait(50);
    assert.equal(calls.length,1);
    const chineseGoal='\u9a8c\u8bc1\u5de5\u4f5c\u6d41';
    const chineseCriteria='\u6d4b\u8bd5\u901a\u8fc7';
    const result=await js(`api['workflow-create']({projectId,goal:${JSON.stringify(chineseGoal)},criteria:${JSON.stringify(chineseCriteria)},teams:{implement:${JSON.stringify([primary.id,backup.id])},review:${JSON.stringify([primary.id])}},limit:2})`);
    releaseFirst();
    for(let i=0;i<120&&store.get('chats',result.id).workflow.status!=='complete';i++)await wait(50);
    const blocked=store.state.chats.find(c=>c.workflow?.goal==='Blocked');
    assert.equal(blocked.workflow.status,'unavailable');
    assert.equal(blocked.workflow.attempts.length,2);
    const completed=store.get('chats',result.id);
    assert.equal(completed.workflow.status,'complete');
    assert.equal(completed.workflow.goal,chineseGoal);
    assert.equal(completed.workflow.criteria,chineseCriteria);
    assert.ok(completed.messages.some(message=>message.kind==='user'&&message.text.includes(chineseGoal)&&message.text.includes(chineseCriteria)));
    assert.match(await js(`$('workflow-status').textContent`),/\u6267\u884c\u9636\u6bb5\u7684\u5019\u9009\u89d2\u8272\u5747\u4e0d\u53ef\u7528/);

    await js(`openWorkflow();$('wf-goal').value='AI routing fixture';$('wf-criteria').value='Pass tests';$('wf-moderator').value=${JSON.stringify(primary.id)};$('wf-moderator').dispatchEvent(new Event('change'));$('wf-implement').querySelector(':scope > button').click();$('dialog-form').requestSubmit()`);
    const routedWorkflow=()=>store.state.chats.find(chat=>chat.workflow?.goal==='AI routing fixture')?.workflow;
    for(let i=0;i<100&&routedWorkflow()?.status!=='complete';i++)await wait(50);
    for(let i=0;i<100&&await js(`!$('workflow-status')?.textContent.includes('AI \u4e3b\u6301') || !document.querySelector('#messages .moderator-message')`);i++)await wait(50);
    const routed=routedWorkflow();
    assert.equal(routed?.status,'complete');
    assert.deepEqual(routingCalls,[['AI routing fixture','implement',primary.id]]);
    assert.deepEqual(routed.attempts.map(attempt=>attempt.roleId),[backup.id,backup.id]);
    assert.match(await js(`document.querySelector('#messages .moderator-message summary')?.textContent`),/\u5df2\u9009\u62e9/);

    await js(`showPage('roles');$('role-priorities-open').click();$('priority-new').click();$('priority-domain').value='Frontend';$('priority-duty').value='Implementation';
      const first=$('priority-candidates').firstElementChild;
      first.querySelector('select').value=${JSON.stringify(primary.id)};
      first.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}));
      first.querySelector('.priority-weight-input').value='3';
      $('priority-add-candidate').click();
      const last=$('priority-candidates').lastElementChild;
      last.querySelector('select').value=${JSON.stringify(backup.id)};
      last.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}));`);
    assert.deepEqual(await js(`[...$('priority-candidates').querySelectorAll('output')].map(output=>output.textContent)`),['75%','25%']);
    await wait(150);
    fs.writeFileSync(path.join(directory,'workflow-priority-editor.png'),(await window.webContents.capturePage()).toPNG());
    await js(`$('dialog-form').requestSubmit()`);
    for(let i=0;i<80&&await js(`$('dialog').open`);i++)await wait(50);
    const savedRule = store.state.workflowPriorities[0];
    assert.deepEqual(savedRule.candidates.map(item=>[item.roleId,item.tier,item.weight]),[[primary.id,1,3],[backup.id,1,1]]);
    assert.equal(await js(`document.querySelectorAll('.priority-table tbody tr').length`),1);
    assert.match(await js(`document.querySelector('.priority-table tbody').textContent`),/Frontend/);
    fs.writeFileSync(path.join(directory,'workflow-priority-table.png'),(await window.webContents.capturePage()).toPNG());
    await js(`$('priority-search').value='no-matching-rule';$('priority-search').dispatchEvent(new Event('input'));`);
    assert.equal(await js(`$('priority-empty').hidden`),false);
    const beforePlan=store.state.chats.length;
    await js(`(async()=>{state=await api.snapshot();showPage('projects');openWorkflow();$('wf-goal').value='Generate a viewer workflow';$('wf-criteria').value='Preserve the existing behavior';$('wf-ai-plan').click();$('wf-plan-planner').value=${JSON.stringify(planner.id)};$('dialog-form').requestSubmit();})()`);
    for(let i=0;i<100&&await js(`$('wf-plan-preview').hidden`);i++)await wait(50);
    assert.equal(store.state.chats.length,beforePlan);
    assert.equal(store.get('projects',fixture.chat.projectId).roleIds.includes(planner.id),false);
    assert.equal(await js(`$('wf-plan-moderator').value`),planner.id);
    assert.deepEqual(await js(`[...document.querySelectorAll('.node-mode')].map(select=>select.value)`),['auto','auto']);
    assert.match(await js(`document.querySelector('.node-recommendation').textContent`),/×3/);
    await js(`document.querySelector('.node-rework').value='1';$('wf-rework-limit').value='1';`);
    await js(`const secondMode=document.querySelectorAll('.node-mode')[1];secondMode.value='ordered';secondMode.dispatchEvent(new Event('change'));`);
    store.updateWorkflowPriority(savedRule.id,{...savedRule,candidates:savedRule.candidates.map(item=>({...item,tier:item.roleId===backup.id?1:2}))});
    await js(`$('dialog-form').requestSubmit()`);
    const generatedWorkflow=()=>store.state.chats.find(chat=>chat.workflow?.type==='generated')?.workflow;
    for(let i=0;i<100&&generatedWorkflow()?.status!=='complete';i++)await wait(50);
    const generated=generatedWorkflow();
    assert.equal(generated?.status,'complete');
    assert.equal(generated.reworkLimit,1);
    assert.equal(generated.reworkCount,1);
    assert.deepEqual(generated.attempts.map(attempt=>[attempt.roleId,attempt.via]),[[backup.id,'priority'],[primary.id,'ordered'],[backup.id,'priority'],[primary.id,'ordered']]);
    assert.deepEqual(generated.attempts[0].priority,{domain:'Frontend',duty:'Implementation',tier:1,weight:1});
    assert.equal(store.get('projects',fixture.chat.projectId).roleIds.includes(planner.id),true);
    for(let i=0;i<80&&await js(`$('dialog').open || !$('workflow-status')?.textContent.includes('Improve the viewer')`);i++)await wait(50);

    const timedOutChat=store.state.chats.find(chat=>chat.workflow===generated);
    const savedAttempt=generated.attempts[0];
    const savedReply=timedOutChat.messages.find(message=>message.kind==='assistant'&&message.workflowAttemptId===savedAttempt.id);
    const warning='failed to refresh available models: request timed out';
    Object.assign(savedReply,{status:'cancelled',note:warning,terminal:'[cancelled] '+warning});
    Object.assign(savedAttempt,{status:'interrupted',reason:'The workflow step timed out. Inspect the workspace and task output before retrying.'});
    await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(timedOutChat.id)};activateChat();})()`);
    const replySelector=JSON.stringify('#msg-'+savedReply.id);
    assert.equal(await js(`document.querySelector(${replySelector}+' .message-state').textContent`),'\u8d85\u65f6\u4e2d\u65ad');
    assert.match(await js(`document.querySelector(${replySelector}+' .message-note').textContent`),/30/);

    require('electron').ipcMain.removeHandler('desk:workflow-create');
    await js(`openWorkflow();$('wf-goal').value='Keep this goal';$('wf-criteria').value='Keep these criteria';$('dialog-form').requestSubmit()`);
    for(let i=0;i<80&&await js(`$('wf-error').hidden`);i++)await wait(50);
    assert.match(await js(`$('wf-error').textContent`),/\u5b8c\u5168\u9000\u51fa AI \u5c0f\u961f/);
    assert.deepEqual(await js(`[$('dialog').open,$('wf-goal').value,$('wf-criteria').value]`),[true,'Keep this goal','Keep these criteria']);
    assert.equal(errors.length,0,errors.join('\n'));app.exit(0);return;
  }
  if(process.argv.includes('--interactive-only')){await require('./interactive-smoke.cjs').run({window,store,app,directory,services,fixture,js,errors});return;}
  if(process.argv.includes('--quota-only')||process.argv.includes('--quota-live-only')){await require('./quota-smoke.cjs').run({window,store,app,directory,services,js,errors});return;}
  if(process.argv.includes('--dialogs-only')){await require('./dialogs-smoke.cjs').run({window,store,app,directory,services,js,errors});return;}
  if(process.argv.includes('--default-replies-only')){await require('./default-replies-smoke.cjs').run({window,store,app,directory,services,fixture,js,errors});return;}
  if(process.argv.includes('--moderator-only')){await require('./moderator-smoke.cjs').run({window,store,app,directory,services,js,errors});return;}
  if(process.argv.includes('--sessions-only')){await require('./native-sessions-smoke.cjs').run({window,store,app,directory,services,js,errors});return;}
  if(process.argv.includes('--recovery-only')){await require('./codex-recovery-smoke.cjs').run({window,store,app,directory,services,js,errors});return;}
  if(process.argv.includes('--queue-only')){await require('./input-queue-smoke.cjs').run({window,store,app,directory,services,js,errors});return;}
  if(process.argv.includes('--desktop-tools-only')){await require('./desktop-tools-smoke.cjs').run({window,store,app,directory,services,js,errors});return;}
  if(process.argv.includes('--notifications-only')){await require('./notifications-smoke.cjs').run({window,store,app,directory,services,fixture,js,errors});return;}
  if(process.argv.includes('--gemini-web-only')){await require('./gemini-web-smoke.cjs').run({store,app,services,fixture,js,errors});return;}
  if(process.argv.includes('--chat-options-only')){await require('./chat-options-smoke.cjs').run({store,app,services,fixture,js,errors});return;}
  if(process.argv.includes('--chat-branch-only')){await require('./chat-branch-smoke.cjs').run({store,app,services,fixture,js});return;}
  const pickerRoot=path.join(directory,'directory-picker-fixture'),folderA=path.join(pickerRoot,'first'),folderB=path.join(pickerRoot,'second');fs.mkdirSync(folderA,{recursive:true});fs.mkdirSync(folderB,{recursive:true});
  let pickerRemote=store.state.locations.find(l=>l.type==='ssh');
  if(!pickerRemote){pickerRemote={id:'picker-fixture-ssh',name:'Fixture SSH',type:'ssh',os:'linux',control:'ssh',host:'example.invalid',username:'fixture',port:22};store.state.locations.push(pickerRemote);}
  const originalPickerDialog=services.dialog.showOpenDialog,pickerCalls=[];
  let pickerResult={canceled:false,filePaths:[folderA]};services.dialog.showOpenDialog=async options=>{pickerCalls.push(options);return pickerResult;};
  try{
    await js('(async()=>{state=await api.snapshot();openProject();document.querySelector("#p-name").value="Directory Picker Fixture";})()');
    assert.equal(await js('document.querySelector(".directory-browse").hidden'),false);
    await js('document.querySelector(".directory-browse").click()');await wait(80);
    assert.equal(await js('document.querySelector(".dir-path").value'),folderA);assert.deepEqual(pickerCalls[0].properties,['openDirectory']);
    await js('document.querySelector("#directory-add").click()');
    pickerResult={canceled:true,filePaths:[]};await js(`document.querySelectorAll('.dir-path')[1].value=${JSON.stringify(folderB)};document.querySelectorAll('.directory-browse')[1].click()`);await wait(80);
    assert.equal(await js('document.querySelectorAll(".dir-path")[1].value'),folderB);assert.equal(pickerCalls[1].defaultPath,folderB);assert.equal(await js('document.querySelectorAll(".dir-path")[0].value'),folderA);
    await js(`document.querySelectorAll('.dir-location')[1].value=${JSON.stringify(pickerRemote.id)};document.querySelectorAll('.dir-location')[1].dispatchEvent(new Event('change'));document.querySelectorAll('.dir-path')[1].value='~/keep-this-directory';document.querySelectorAll('.directory-browse')[1].click()`);await wait(60);
    assert.equal(await js('document.querySelectorAll(".directory-browse")[1].hidden'),true);assert.equal(pickerCalls.length,2);assert.equal(await js('document.querySelectorAll(".dir-path")[1].value'),'~/keep-this-directory');
    await wait(180);fs.writeFileSync(path.join(directory,'project-directory-picker.png'),(await window.webContents.capturePage()).toPNG());
    await js('document.querySelector("#dialog-form").requestSubmit()');await wait(100);
    const saved=store.state.projects.find(p=>p.name==='Directory Picker Fixture');assert(saved);assert.deepEqual(saved.directories,[{locationId:'local',path:folderA},{locationId:pickerRemote.id,path:'~/keep-this-directory'}]);
    await js('openProject(project());document.querySelectorAll(".dir-location")[1].value="local";document.querySelectorAll(".dir-location")[1].dispatchEvent(new Event("change"))');assert.equal(await js('document.querySelectorAll(".directory-browse")[1].hidden'),false);await js('document.querySelector("#dialog-cancel").click()');
    store.state.projects=store.state.projects.filter(p=>p.id!==saved.id);store.save();
    await js(`(async()=>{state=await api.snapshot();projectId=${JSON.stringify(fixture.project.id)};chatId=${JSON.stringify(fixture.chat.id)};renderSidebar();activateChat();})()`);
    fs.writeFileSync(path.join(directory,'project-picker-checks.json'),JSON.stringify({passed:true,checks:['new and added local rows expose folder picker','native dialog selects directories','selected path fills its own row','cancel preserves manual path','existing local path seeds native dialog','remote rows retain manual entry with no picker call','location switching updates browse visibility','project save preserves local and remote paths'],consoleErrors:errors},null,2));
  }finally{services.dialog.showOpenDialog=originalPickerDialog;}
  const http=require('node:http');let fixtureAuthorized=false;
  const networkFixture=http.createServer((request,response)=>{
    fixtureAuthorized=request.headers.authorization==='Bearer fixture-network-token';
    request.resume();request.on('end',()=>{response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: {"text":"STREAM_ONE"}\n\n');setTimeout(()=>response.end('data: {"text":"STREAM_TWO"}\n\n'),20);});
  });
  await new Promise(resolve=>networkFixture.listen(0,'127.0.0.1',resolve));
  try {
    const response=await services.providerFetch('http://127.0.0.1:'+networkFixture.address().port,{method:'POST',headers:{Authorization:'Bearer fixture-network-token','Content-Type':'application/json'},body:'{"model":"fixture"}',signal:AbortSignal.timeout(5000)});
    let stream='';for await(const chunk of response.body)stream+=Buffer.from(chunk).toString('utf8');
    assert(fixtureAuthorized);assert(stream.includes('STREAM_ONE'));assert(stream.includes('STREAM_TWO'));
  } finally {networkFixture.closeAllConnections();await new Promise(resolve=>networkFixture.close(resolve));}
  const originalLocationProxy=store.get('locations','local').proxy;
  const proxyFixture=http.createServer((request,response)=>{assert(request.url.includes('relay-proxy-fixture.invalid'));response.end('CUSTOM_PROXY_OK');});
  await new Promise(resolve=>proxyFixture.listen(0,'127.0.0.1',resolve));
  try {
    store.get('locations','local').proxy={mode:'custom',url:'http://127.0.0.1:'+proxyFixture.address().port};
    const request=await services.network.fetchFor({locationId:'local',proxyMode:'inherit'});
    const response=await request('http://relay-proxy-fixture.invalid/models',{signal:AbortSignal.timeout(5000)});
    assert.equal(await response.text(),'CUSTOM_PROXY_OK');
  } finally {store.get('locations','local').proxy=originalLocationProxy;proxyFixture.closeAllConnections();await new Promise(resolve=>proxyFixture.close(resolve));}
  services.running.set(fixture.chat.id,{roleId:fixture.roles[0].id,roleIds:fixture.roles.map(r=>r.id),round:1,rounds:3,controller:new AbortController()});
  await js('(async()=>{state=await api.snapshot();renderMessages();})()');await wait(100);
  fs.writeFileSync(path.join(directory,'main.png'),(await window.webContents.capturePage()).toPNG());
  services.running.clear();await js('(async()=>{state=await api.snapshot();renderMessages();})()');
  fixture.roles[0].name='铃音';fixture.roles[0].persona='你叫铃音，是我的开发搭档。擅长发现代码中的边界条件和逻辑问题。回答使用中文，说明依据和不确定性，不编造验证结果。';fixture.roles[0].examples='我：这个方案靠谱吗？\n铃音：我先检查边界条件喵，还没验证的地方会单独标出来。\n\n我：发现问题怎么办？\n铃音：先列出证据，再给出最小修改建议。';store.save();
  await js('(async()=>{state=await api.snapshot();document.querySelector("[data-page=roles]").click();})()');await wait(350);
  assert.equal(await js('[...document.querySelectorAll("#editor-view textarea")].filter(field => !field.closest("label").hidden).length'),2);
  assert.equal(await js('document.querySelector("#role-connection").open'),true);
  assert.equal(await js('document.querySelector("#role-persona").open'),false);
  assert.equal(await js('document.querySelector("#role-persona").contains(document.querySelector(".role-preview"))'),true);
  assert.equal(await js('Boolean(document.querySelector("#role-connection").compareDocumentPosition(document.querySelector("#role-persona")) & Node.DOCUMENT_POSITION_FOLLOWING)'),true);
  assert(modelCalls.length>0);
  fs.writeFileSync(path.join(directory,'roles.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#role-persona").open=true;document.querySelector("#role-persona").scrollIntoView({block:"start"})');await wait(180);
  assert((await js('document.querySelector("#r-persona").getBoundingClientRect().height'))>100);
  fs.writeFileSync(path.join(directory,'role-persona-expanded.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#r-name").value="Smoke Role"; document.querySelector("#r-persona").value="Review code carefully."; document.querySelector("#role-form").requestSubmit()');await wait(220);
  assert.equal(store.state.roles.find(r=>r.id===fixture.roles[0].id).name,'Smoke Role');
  await js('document.querySelector("#role-connection").open=true;document.querySelector("#r-proxy").value="direct";document.querySelector("#r-proxy").dispatchEvent(new Event("change"));document.querySelector("#role-form").requestSubmit()');
  for(let attempt=0;attempt<50&&store.get('roles',fixture.roles[0].id).proxyMode!=='direct';attempt++)await wait(40);
  assert.equal(store.get('roles',fixture.roles[0].id).proxyMode,'direct');
  await js('document.querySelector("#role-connection").open=true;document.querySelector("#r-proxy").scrollIntoView({block:"center"})');await wait(120);
  fs.writeFileSync(path.join(directory,'role-proxy.png'),(await window.webContents.capturePage()).toPNG());
  assert.equal(modelCalls.at(-1).proxyMode,'direct');
  await js('document.querySelector("#r-proxy").value="inherit";document.querySelector("#role-form").requestSubmit()');await wait(140);
  await js('document.querySelector("#role-connection").open=true;document.querySelector("#r-permission").value="danger-full-access";document.querySelector("#r-permission").dispatchEvent(new Event("change"));document.querySelector("#role-form").requestSubmit()');await wait(160);
  assert.equal(store.get('roles',fixture.roles[0].id).permission,'danger-full-access');
  await js('document.querySelector("#role-connection").open=true;document.querySelector("#r-permission").scrollIntoView({block:"center"})');await wait(120);
  assert.equal(await js('document.querySelector("#r-permission").value'),'danger-full-access');
  assert((await js('document.querySelector("#permission-hint").textContent')).includes('系统权限'));
  fs.writeFileSync(path.join(directory,'role-full-access.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#r-permission").value="workspace-write";document.querySelector("#role-form").requestSubmit()');await wait(150);
  await js('document.querySelector("#role-connection").open=true');await wait(120);
  assert(modelCalls.length>0);
  await js('document.querySelector("#r-model").focus();document.querySelector("#r-model").value="rare";document.querySelector("#r-model").dispatchEvent(new Event("input"))');
  assert.equal(await js('document.querySelectorAll(".model-picker-option").length'),1);
  await js('document.querySelector(".model-picker-option").click()');
  assert.equal(await js('document.querySelector("#r-model").value'),'rare-long-tail-model-alpha');
  const refreshBefore=modelCalls.length;
  await js('document.querySelector(".model-picker-refresh").click()');await wait(120);
  assert.equal(modelCalls.length,refreshBefore+1);assert.equal(modelCalls.at(-1).force,true);
  modelFailure=true;
  await js('document.querySelector(".model-picker-refresh").click()');await wait(120);
  assert.equal(await js('document.querySelector("#r-model").value'),'rare-long-tail-model-alpha');
  assert((await js('document.querySelector(".model-picker-status").textContent')).includes('保留已有'));
  modelFailure='network';
  await js('document.querySelector(".model-picker-refresh").click()');await wait(100);
  assert((await js('document.querySelector(".model-picker-status").textContent')).includes('代理'));
  modelFailure=false;
  const savedProvider=store.get('roles',fixture.roles[0].id).provider;
  await js('document.querySelector("#r-provider").value="deepseek";document.querySelector("#r-key").value="unsaved-fixture-key";document.querySelector("#r-provider").dispatchEvent(new Event("change"))');await wait(120);
  assert.equal(modelCalls.at(-1).provider,'deepseek');assert.equal(modelCalls.at(-1).apiKey,'unsaved-fixture-key');
  assert.equal(store.get('roles',fixture.roles[0].id).provider,savedProvider);
  await js('document.querySelector("#r-key").value="";document.querySelector("#r-provider").value="native";document.querySelector("#r-provider").dispatchEvent(new Event("change"));document.querySelector("#r-model").scrollIntoView({block:"center"})');await wait(120);
  await js('document.querySelector(".model-picker-toggle").click()');await wait(120);
  assert.equal(await js('document.querySelector("#role-form").scrollWidth<=document.querySelector("#role-form").clientWidth+2'),true);
  fs.writeFileSync(path.join(directory,'role-model-list.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#r-model").value="custom-manual-model";document.querySelector("#role-form").requestSubmit()');await wait(150);
  assert.equal(store.get('roles',fixture.roles[0].id).model,'custom-manual-model');
  const originalDesktopHome=services.agents.desktopHome;
  const sharedHome=path.join(directory,'fixture-desktop-home');fs.mkdirSync(sharedHome,{recursive:true});
  fs.writeFileSync(path.join(sharedHome,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-desktop-key'}));
  services.agents.desktopHome=()=>sharedHome;
  try {
    await js('document.querySelector("#role-connection").open=true;document.querySelector("#r-login-source").value="desktop";document.querySelector("#r-login-source").dispatchEvent(new Event("change"))');await wait(100);
    assert.equal(modelCalls.at(-1).codexLoginSource,'desktop');
    assert.equal(await js('document.querySelector("#r-login-source-field").hidden'),false);
    assert((await js('document.querySelector("#r-login-source-hint").textContent')).includes('共用桌面版账号'));
    await js('document.querySelector("#role-form").requestSubmit()');await wait(100);
    assert.equal(store.get('roles',fixture.roles[0].id).codexLoginSource,'desktop');
    await js('document.querySelector("#role-connection").open=true;document.querySelector("#r-login-source").scrollIntoView({block:"center"})');await wait(100);
    fs.writeFileSync(path.join(directory,'shared-login-source.png'),(await window.webContents.capturePage()).toPNG());
    const windows=require('electron').BrowserWindow.getAllWindows().length;
    await js('document.querySelector("#role-login").click()');for(let attempt=0;attempt<100;attempt++){if((await js('document.querySelector("#toast").textContent')).includes('已确认桌面版'))break;await wait(50);}
    assert.equal(require('electron').BrowserWindow.getAllWindows().length,windows);
    assert((await js('document.querySelector("#toast").textContent')).includes('已确认桌面版'));
    await js('document.querySelector("#r-provider").value="gemini";document.querySelector("#r-provider").dispatchEvent(new Event("change"))');
    assert.equal(await js('document.querySelector("#r-login-source-field").hidden'),true);
    await js('document.querySelector("#r-provider").value="native";document.querySelector("#r-provider").dispatchEvent(new Event("change"));document.querySelector("#r-login-source").value="isolated";document.querySelector("#r-login-source").dispatchEvent(new Event("change"));document.querySelector("#role-form").requestSubmit()');await wait(100);
    assert.equal(store.get('roles',fixture.roles[0].id).codexLoginSource,'isolated');
  } finally {services.agents.desktopHome=originalDesktopHome;}
  for(const engine of ['kimi','cursor','workbuddy','codebuddy','antigravity']){
    await js(`document.querySelector('#role-connection').open=true;document.querySelector('#r-engine').value=${JSON.stringify(engine)};document.querySelector('#r-engine').dispatchEvent(new Event('change'))`);await wait(100);
    assert.equal(await js('document.querySelector("#agent-runtime-card").hidden'),false);
    assert.equal(await js('document.querySelector("#r-provider").value'),'native');
    assert.equal(await js('document.querySelector("#r-provider").disabled'),true);
    assert.equal(await js('document.querySelector("#r-key").disabled'),true);
    assert.equal(await js('document.querySelector("#r-effort").disabled'),['kimi','cursor'].includes(engine));
    assert.equal(await js('document.querySelector("#r-location").value'),'local');
    if(engine==='antigravity'){assert.equal(await js('document.querySelector("#agent-runtime-install").hidden'),false);assert((await js('document.querySelector("#agent-runtime-help").textContent')).includes('Google'));await js('document.querySelector("#agent-runtime-card").scrollIntoView({block:"start"})');await wait(180);fs.writeFileSync(path.join(directory,'antigravity-settings.png'),(await window.webContents.capturePage()).toPNG());}
    if(engine==='workbuddy')assert((await js('document.querySelector("#agent-runtime-help").textContent')).includes('请改用官方 CLI'));
    if(engine==='workbuddy'){
      assert.equal(await js('document.querySelector("#agent-runtime-account").hidden'),false);
      await js('document.querySelector("#r-executable").value="C:/fixture/desktop-worker.mjs";document.querySelector("#r-model").value="fixture-desktop-model";document.querySelector("#agent-runtime-account").click()');await wait(100);
      assert.equal(await js('document.querySelector("#r-engine").value'),'codebuddy');
      assert.equal(await js('document.querySelector("#r-provider").value'),'native');
      assert.equal(await js('document.querySelector("#r-executable").value'),'');
      assert.equal(await js('document.querySelector("#r-model").value'),'');
      assert.equal(await js('document.querySelector("#r-key").disabled'),true);
      assert.equal(store.get('roles',fixture.roles[0].id).engine,'codex');
    }
    if(engine==='kimi'){await js('document.querySelector("#agent-runtime-card").scrollIntoView({block:"start"})');await wait(220);fs.writeFileSync(path.join(directory,'native-agent-settings.png'),(await window.webContents.capturePage()).toPNG());}
  }
  await js(`editRole(role(${JSON.stringify(fixture.roles[0].id)}))`);await wait(100);
  const originalAvatar = fixture.roles[0].avatarId || '';
  await js('document.querySelector("#avatar-picker button").click()');await wait(120);
  const avatarPresets = services.avatars.defaults();
  const visiblePresetIds = await js('Array.from(document.querySelectorAll("[data-avatar-default]"), button => button.dataset.avatarDefault)');
  assert.deepEqual(visiblePresetIds, avatarPresets.map(item => item.id));
  for (const item of avatarPresets) {
    assert(item.src.startsWith('data:image/jpeg;base64,'));
    assert.deepEqual(services.avatars.nativeImage.createFromDataURL(item.src).getSize(),{width:256,height:256});
  }
  await js('document.querySelectorAll("[data-avatar-default]")[2].click();document.querySelector("#dialog-cancel").click()');
  assert.equal(fixture.roles[0].avatarId || '',originalAvatar);
  const nativePicker=services.dialog.showOpenDialog;
  try {
    services.dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});
    await js('document.querySelector("#avatar-picker button").click()');await wait(100);
    const beforeUpload=services.avatars.list().length;
    await js('document.querySelector("#avatar-upload").click()');await wait(100);
    assert.equal(services.avatars.list().length,beforeUpload);
    services.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.resolve(__dirname,'../assets/role-avatars.png')]});
    await js('document.querySelector("#avatar-upload").click()');await wait(250);
    assert.equal(await js('document.querySelectorAll("#avatar-options [aria-pressed=true]").length'),1);
    const selected=await js('document.querySelector("#avatar-options [aria-pressed=true]").dataset.avatarId');
    const imported=services.avatars.nativeImage.createFromDataURL(services.avatars.get(selected));
    assert.deepEqual(imported.getSize(),{width:256,height:256});
    const reopened=new (require('./avatars.cjs').Avatars)(services.avatars.directory,services.avatars.nativeImage);
    assert.equal(reopened.get(selected),services.avatars.get(selected));
    const avatarCount=reopened.list().length;
    await reopened.import(path.resolve(__dirname,'../assets/role-avatars.png'));
    assert.equal(reopened.list().length,avatarCount);
    const invalidAvatar=path.join(directory,'invalid-avatar.png');fs.writeFileSync(invalidAvatar,'Invalid image fixture');
    await assert.rejects(reopened.import(invalidAvatar),/decoded/);
    assert.equal(services.avatars.get('../workspace'),'');
    await js('document.querySelector("#dialog-form").requestSubmit()');await wait(100);
    assert.equal(await js('document.querySelectorAll("#avatar-picker .avatar.custom img").length'),1);
    await js('document.querySelector("#role-form").requestSubmit()');await wait(160);
    assert.equal(store.get('roles',fixture.roles[0].id).avatarId,selected);
    assert.equal(store.persisted().roles.find(role=>role.id===fixture.roles[0].id).avatarId,selected);
    await js('document.querySelector("#avatar-picker button").click()');await wait(120);
    fs.writeFileSync(path.join(directory,'avatar-picker.png'),(await window.webContents.capturePage()).toPNG());
    await js('document.querySelectorAll("[data-avatar-default]")[1].click();document.querySelector("#dialog-form").requestSubmit();document.querySelector("#role-form").requestSubmit()');await wait(160);
    assert.equal(store.get('roles',fixture.roles[0].id).avatarId,'preset-claude');
    await js('document.querySelector("#avatar-picker button").click()');await wait(100);
    await js(`document.querySelector('[data-avatar-id="${selected}"]').click();document.querySelector("#dialog-form").requestSubmit();document.querySelector("#role-form").requestSubmit()`);await wait(150);
  } finally { services.dialog.showOpenDialog=nativePicker; }
  await js('(async()=>{const s=await api.snapshot();await api["role-save"]({...s.roles[0],apiKey:"fixture-only-key"});})()');
  assert(!fs.readFileSync(path.join(directory,'secrets.json'),'utf8').includes('fixture-only-key'));
  assert((await js('(async()=> (await api.snapshot()).roles[0].hasKey)()')));
  await js('document.querySelector("[data-page=locations]").click()');await wait(120);
  assert.equal(await js('document.querySelector("#l-name").disabled'),true);
  await js('document.querySelector("#l-proxy-mode").value="custom";document.querySelector("#l-proxy-mode").dispatchEvent(new Event("change"));document.querySelector("#l-proxy-url").value="http://127.0.0.1:7890";document.querySelector("#location-form").requestSubmit()');await wait(150);
  assert.equal(store.get('locations','local').proxy.mode,'custom');
  await js('document.querySelector("#l-proxy-mode").scrollIntoView({block:"center"})');await wait(100);
  fs.writeFileSync(path.join(directory,'location-proxy.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#l-proxy-mode").value="system";document.querySelector("#location-form").requestSubmit()');await wait(140);
  await js('document.querySelector("[data-page=settings]").click()');await wait(100);
  assert.equal(await js('document.querySelector("#s-limit").value'),'3');
  await js('document.querySelector("[data-settings-section=updates]").click()');
  const versionCalls=[];
  services.claudeUpdater.request=async operation=>{
    versionCalls.push(operation);
    services.claudeUpdater.publish({state:'complete',phase:'complete',installed:operation==='update'?'2.1.325':'2.1.308',latest:'2.1.325',available:operation!=='update',canRollback:operation!=='check',reason:operation==='update'?'updated':operation==='rollback'?'rolled_back':'prepared',preparedVersion:operation==='check'?'2.1.325':''});
    return services.claudeUpdater.snapshot();
  };
  await js('document.querySelector("[data-claude-action=check]").click()');await wait(100);
  assert.equal(await js('document.querySelector(".claude-installed").textContent'),'2.1.308');
  assert.equal(await js('document.querySelector(".claude-latest").textContent'),'2.1.325');
  await js('document.querySelector("#claude-updater").scrollIntoView({block:"center"})');await wait(100);
  fs.writeFileSync(path.join(directory,'claude-updater.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("[data-claude-action=update]").click()');await wait(100);
  assert.equal(await js('document.querySelector(".claude-installed").textContent'),'2.1.325');
  await js('document.querySelector("[data-claude-action=rollback]").click()');await wait(100);
  assert.deepEqual(versionCalls,['check','update','rollback']);
  await js('document.querySelector("[data-page=projects]").click();document.querySelector("#input").value="Draft survives navigation";document.querySelector("#input").dispatchEvent(new Event("input"))');await wait(450);
  assert.equal(store.state.chats.find(c=>c.id===fixture.chat.id).draft,'Draft survives navigation');
  await js('document.querySelectorAll("[data-chat]")[1].click();document.querySelectorAll("[data-chat]")[0].click()');
  assert.equal(await js('document.querySelector("#input").value'),'Draft survives navigation');
  await js('document.querySelector("#tool-files").click()');await wait(450);
  assert((await js('document.querySelectorAll(".file-row").length'))>0);
  await js('document.querySelector("#tools-wide").click()');await wait(100);
  assert.equal(await js('document.body.classList.contains("tools-wide")'),true);
  await js('document.querySelector("#tools-close").click()');
  const dispatched=[];let fixtureDecision='continue';
  services.agents.run = async (chatId,role,_project,signal,_summary,context) => {
    dispatched.push({roleId:role.id,model:role.model,effort:role.effort,relayReplies:context?.relayReplies});
    const message=store.message(chatId,{kind:'assistant',roleId:role.id,roleName:role.name,model:role.model,text:'',status:'running',locationId:'local',thinking:'Fixture reasoning summary',activities:[{id:'fixture-tool',title:'Fixture tool',status:'running'}],terminal:'[Reasoning summary]\r\nFixture reasoning summary\r\n$ fixture-command\r\n'});
    services.agents.emit({chatId,message});await wait(120);message.text='Fixture reply from '+role.name;message.status=signal.aborted?'cancelled':'complete';if(context?.discussion&&fixtureDecision)message.discussionVote={decision:fixtureDecision,reason:'Fixture assessment'};message.activities[0].status=signal.aborted?'interrupted':'complete';message.terminal+='Fixture command output\r\n[Assistant]\r\n'+message.text+'\r\n['+message.status+']\r\n';store.save();services.agents.emit({chatId,message});return message;
  };
  const savedDefault=store.get('roles',fixture.roles[0].id).model;
  const otherChat=store.state.chats.find(c=>c.id!==fixture.chat.id&&c.roleIds.includes(fixture.roles[0].id));
  const otherSettings=structuredClone(otherChat.roleSettings[fixture.roles[0].id]);
  await js('document.querySelector("#participants [data-chat-role]").click()');await wait(100);
  assert.equal(await js('document.querySelector("#dialog").open'),true);
  assert.equal(await js('document.querySelectorAll("#chat-model-picker .model-picker-option").length'),3);
  await js('document.querySelector("#chat-model-picker input").value="fixture-chat-model";document.querySelector("#chat-effort").value="high";document.querySelector("#dialog-form").requestSubmit()');await wait(100);
  assert.deepEqual(fixture.chat.roleSettings[fixture.roles[0].id],{model:'fixture-chat-model',effort:'high'});
  assert.equal(store.get('roles',fixture.roles[0].id).model,savedDefault);
  assert.deepEqual(otherChat.roleSettings[fixture.roles[0].id],otherSettings);
  await js('document.querySelector("#chat-settings").click();document.querySelectorAll("#chat-speaking-list [data-order-move]")[1].click()');
  assert((await js('document.querySelector("#chat-speaking-list").textContent')).indexOf(fixture.roles[1].name)<(await js('document.querySelector("#chat-speaking-list").textContent')).indexOf(fixture.roles[0].name));
  assert.equal(await js('document.querySelector("#dialog").open'),true);await wait(220);
  fs.writeFileSync(path.join(directory,'group-speaking-settings.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#dialog-form").requestSubmit()');await wait(100);
  assert.deepEqual(fixture.chat.roleIds,[fixture.roles[1].id,fixture.roles[0].id,fixture.roles[2].id]);
  await js('document.querySelector("#chat-settings").click();document.querySelectorAll("#chat-speaking-list [data-order-move]")[1].click();document.querySelector("#dialog-form").requestSubmit()');await wait(100);
  assert.deepEqual(fixture.chat.roleIds,fixture.roles.map(r=>r.id));
  await js('document.querySelector("#group-order").click();document.querySelector("[data-order-down]").click();document.querySelector("#dialog-form").requestSubmit()');await wait(100);
  assert.deepEqual(fixture.chat.roleIds,[fixture.roles[1].id,fixture.roles[0].id,fixture.roles[2].id]);
  assert((await js('document.querySelector("#speaking-order").textContent')).indexOf(store.get('roles',fixture.roles[1].id).name)<(await js('document.querySelector("#speaking-order").textContent')).indexOf(store.get('roles',fixture.roles[0].id).name));
  await js('document.querySelector("#group-order").click();document.querySelector("[data-order-down]").click();document.querySelector("#dialog-form").requestSubmit()');await wait(100);
  assert.deepEqual(fixture.chat.roleIds,fixture.roles.map(r=>r.id));
  await js('document.querySelector("#reply-flow").value="independent";document.querySelector("#reply-flow").dispatchEvent(new Event("change"))');await wait(80);
  assert.equal(fixture.chat.relayReplies,false);
  assert.equal(await js('Boolean(document.querySelector("#speaker"))'),false);
  const mentionBefore=fixture.chat.messages.length;
  await js('document.querySelector("#input").focus();document.querySelector("#input").value="@";document.querySelector("#input").dispatchEvent(new Event("input"))');await wait(120);
  assert.equal(await js('document.querySelector("#mention-menu").hidden'),false);
  assert.equal(await js('document.querySelectorAll("#mention-menu [role=option]").length'),4);
  fs.writeFileSync(path.join(directory,'mention-menu.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#input").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));document.querySelector("#input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  assert.equal(fixture.chat.messages.length,mentionBefore);
  assert((await js('document.querySelector("#input").value')).startsWith('@'+store.get('roles',fixture.roles[0].id).name+' '));
  assert.equal(await js('document.querySelector("#quick-model").hidden'),false);
  await js('document.querySelector("#input").value+="Inspect the fixture";document.querySelector("#input").dispatchEvent(new Event("input"));document.querySelector("#send").click()');await wait(330);
  assert.equal(fixture.chat.messages.length,mentionBefore+2);
  assert.equal(fixture.chat.messages.at(-1).roleId,fixture.roles[0].id);
  assert.equal(dispatched.at(-1).model,'fixture-chat-model');assert.equal(dispatched.at(-1).effort,'high');assert.equal(dispatched.at(-1).relayReplies,false);
  assert.equal(await js('document.querySelectorAll(".message-reasoning:not([hidden])").length'),1);
  await js('document.querySelector(".message-reasoning:not([hidden])").open=true;document.querySelectorAll(".task-output")[document.querySelectorAll(".task-output").length-1].click()');await wait(140);
  assert.equal(await js('document.querySelector("#activity-tools").hidden'),false);
  assert.equal(await js('activityView.term.options.disableStdin'),true);
  assert((await js('activityView.output')).includes('fixture-command'));
  assert((await js('document.querySelector("#activity-host").clientHeight'))>400);
  fs.writeFileSync(path.join(directory,'task-output.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#tools-wide").click()');await wait(80);
  assert((await js('document.querySelector("#activity-host").clientWidth'))>900);
  fs.writeFileSync(path.join(directory,'task-output-wide.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#tools-close").click();document.querySelector("#participants [data-chat-role]").click()');await wait(80);
  fs.writeFileSync(path.join(directory,'chat-model.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#dialog-cancel").click()');
  assert.equal(await js('document.querySelector("#quick-model").hidden'),true);
  await js(`(async()=>{await api['role-save']({...role(${JSON.stringify(fixture.roles[0].id)}),effort:'high'});await api['chat-role-settings'](${JSON.stringify(fixture.chat.id)},${JSON.stringify(fixture.roles[0].id)},{model:'',effort:''});state=await api.snapshot();document.querySelector('#input').value=${JSON.stringify('@'+store.get('roles',fixture.roles[0].id).name+' Check inherited role defaults')};document.querySelector('#input').dispatchEvent(new Event('input'));})()`);await wait(80);
  assert.equal(await js('document.querySelector("#quick-model").value'),savedDefault);
  assert.equal(await js('document.querySelector("#quick-effort").value'),'');
  assert.equal(store.get('roles',fixture.roles[0].id).effort,'high');
  await js('document.querySelector("#participants [data-chat-role]").click()');await wait(80);
  assert.equal(await js('document.querySelector("#chat-model-picker input").value'),'');
  assert((await js('document.querySelector("#chat-model-picker input").placeholder')).includes(savedDefault));
  assert.equal(await js('document.querySelector("#chat-effort").value'),'');
  fs.writeFileSync(path.join(directory,'chat-model-inheritance.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#dialog-cancel").click();document.querySelector("#send").click()');await wait(350);
  assert.equal(dispatched.at(-1).model,savedDefault);assert.equal(dispatched.at(-1).effort,store.get('roles',fixture.roles[0].id).effort);
  assert.equal(fixture.chat.roleSettings[fixture.roles[0].id].model,'');assert.deepEqual(otherChat.roleSettings[fixture.roles[0].id],otherSettings);
  const subsetStart=fixture.chat.messages.length;
  await js(`document.querySelector("#input").value=${JSON.stringify('@'+store.get('roles',fixture.roles[1].id).name+' @'+store.get('roles',fixture.roles[2].id).name+' Review the fixture')};document.querySelector("#input").dispatchEvent(new Event("input"));document.querySelector("#send").click()`);await wait(450);
  assert.deepEqual(fixture.chat.messages.slice(subsetStart+1).map(message=>message.roleId),fixture.roles.slice(1).map(role=>role.id));
  await js('document.querySelector("#reply-flow").value="relay";document.querySelector("#reply-flow").dispatchEvent(new Event("change"))');await wait(80);
  const orderStart=dispatched.length;
  await js(`document.querySelector("#input").value=${JSON.stringify('@所有角色 @'+store.get('roles',fixture.roles[0].id).name+' Summarize last')};document.querySelector("#input").dispatchEvent(new Event("input"));document.querySelector("#send").click()`);await wait(650);
  assert.deepEqual(dispatched.slice(orderStart).map(d=>d.roleId),[fixture.roles[1].id,fixture.roles[2].id,fixture.roles[0].id]);
  assert(dispatched.slice(orderStart).every(d=>d.relayReplies===true));
  const compositionStart=fixture.chat.messages.length;
  await js('document.querySelector("#input").value="@";document.querySelector("#input").dispatchEvent(new Event("input"));document.querySelector("#input").dispatchEvent(new CompositionEvent("compositionstart"));document.querySelector("#input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}));document.querySelector("#input").dispatchEvent(new CompositionEvent("compositionend"));document.querySelector("#input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal(fixture.chat.messages.length,compositionStart);
  assert.equal(await js('document.querySelector("#mention-menu").hidden'),true);
  await js(`document.querySelector("#input").value=${JSON.stringify('@'+store.get('roles',fixture.roles[0].id).name+' Draft mention')};document.querySelector("#input").dispatchEvent(new Event("input"));document.querySelectorAll("[data-chat]")[1].click();document.querySelectorAll("[data-chat]")[0].click()`);
  assert.equal(await js('composerRecipients().roleIds.length'),1);
  assert.equal(await js('composerRecipients().roleIds[0]'),fixture.roles[0].id);
  for(let attempt=0;attempt<160&&(services.running.size||await js('sendingChats.size'));attempt++)await wait(50);
  assert.equal(services.running.size,0);
  const before=fixture.chat.messages.length;
  await js('document.querySelector("#rounds").value="2";document.querySelector("#input").value="Fixture group task";document.querySelector("#send").click()');
  for(let attempt=0;attempt<150&&(fixture.chat.messages.length<before+7||services.running.size);attempt++)await wait(40);
  assert.equal(fixture.chat.messages.length,before+7);
  assert.equal(await js('document.querySelector("#input").value'),'');
  assert.equal(services.running.size,0);
  await js('document.querySelector("#input").value="Fixture cancelled task";document.querySelector("#send").click()');await wait(40);await js('document.querySelector("#end-task").click()');await wait(250);
  assert.equal(services.running.size,0);assert.equal(fixture.chat.messages.at(-1).status,'cancelled');
  const runDiscussion=async(decision,autoStop=true)=>{
    fixtureDecision=decision;const start=dispatched.length;
    await js(`document.querySelector('#rounds').value='10';document.querySelector('#auto-stop').checked=${autoStop};document.querySelector('#input').value='Fixture adaptive discussion';document.querySelector('#input').dispatchEvent(new Event('input'));document.querySelector('#send').click()`);
    for(let attempt=0;attempt<150&&(dispatched.length===start||services.running.size);attempt++)await wait(40);
    assert.equal(services.running.size,0);return dispatched.length-start;
  };
  assert.equal(await runDiscussion('complete'),3);assert.equal(fixture.chat.lastDiscussion.state,'complete');assert.equal(fixture.chat.lastDiscussion.rounds,1);assert.equal(fixture.chat.maxRounds,10);
  assert.equal(await js('document.querySelector("#discussion-result").hidden'),false);
  assert((await js('document.querySelector("#discussion-result").textContent')).includes('1 轮 / 上限 10 轮'));
  await wait(200);fs.writeFileSync(path.join(directory,'adaptive-discussion.png'),(await window.webContents.capturePage()).toPNG());
  assert.equal(await runDiscussion('needs_user'),3);assert.equal(fixture.chat.lastDiscussion.state,'needs_user');
  assert.equal(await runDiscussion(null),3);assert.equal(fixture.chat.lastDiscussion.state,'unconfirmed');
  await js('document.querySelector("#rounds").value="2";document.querySelector("#auto-stop").checked=false;document.querySelector("#auto-stop").dispatchEvent(new Event("change"))');await wait(100);
  assert.equal(fixture.chat.maxRounds,2);assert.equal(fixture.chat.autoStop,false);
  const fixedStart=dispatched.length;
  await js('document.querySelector("#input").value="Fixture fixed discussion";document.querySelector("#send").click()');
  for(let attempt=0;attempt<150&&(dispatched.length===fixedStart||services.running.size);attempt++)await wait(40);
  assert.equal(dispatched.length-fixedStart,6);assert.equal(fixture.chat.lastDiscussion.state,'limit');
  await js('document.querySelectorAll("[data-chat]")[1].click()');await wait(80);
  assert.equal(await js('document.querySelector("#rounds").value'),'1');
  await js('document.querySelectorAll("[data-chat]")[0].click()');await wait(80);
  assert.equal(await js('document.querySelector("#rounds").value'),'2');assert.equal(await js('document.querySelector("#auto-stop").checked'),false);
  await js('document.querySelector("#reply-flow").value="independent";document.querySelector("#reply-flow").dispatchEvent(new Event("change"))');await wait(80);
  assert.equal(await js('document.querySelector("#rounds").disabled'),true);
  assert.equal(await runDiscussion('continue'),3);assert.equal(fixture.chat.lastDiscussion.maxRounds,1);
  const invalidStart=fixture.chat.messages.length;
  assert.equal(await js(`(async()=>{try{await api.send({chatId:${JSON.stringify(fixture.chat.id)},text:'Invalid fixture rounds',rounds:51});return false;}catch{return true;}})()`),true);
  assert.equal(fixture.chat.messages.length,invalidStart);
  await js('document.querySelector("#reply-flow").value="relay";document.querySelector("#reply-flow").dispatchEvent(new Event("change"))');await wait(80);
  fixtureDecision='continue';
  fs.writeFileSync(path.join(directory,'discussion-checks.json'),JSON.stringify({passed:true,checks:['limits above five accepted','unanimous completion stops after one full round','user input pauses automatic continuation','missing decisions stop without false completion','fixed rounds preserve selected ceiling','per-chat controls persist on navigation','independent answers run once','invalid limits rejected before accepting user text']},null,2));
  const workbuddyFailure=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,text:'',status:'failed',errorCode:'WORKBUDDY_DESKTOP_AUTH_UNAVAILABLE',note:'Official desktop credentials are not available to the worker.'});
  await js(`(async()=>{state=await api.snapshot();renderMessages();})()`);await wait(100);
  assert.equal(await js(`document.getElementById(${JSON.stringify('msg-'+workbuddyFailure.id)}).querySelector('.native-login').hidden`),true);
  assert((await js(`document.getElementById(${JSON.stringify('msg-'+workbuddyFailure.id)}).querySelector('.message-note').textContent`)).includes('原提问已保留'));
  await js('document.querySelector("#tool-terminal").click()');await wait(80);await js('document.querySelector("#terminal-new").click()');await wait(700);
  const opened=await js('(async()=> (await window.desk.terminals()).length)()');assert.equal(opened,1);
  await js('document.querySelectorAll("[data-chat]")[1].click()');await wait(80);assert.equal(await js('(async()=> (await window.desk.terminals()).length)()'),1);
  await js('document.querySelector("#terminal-end").click()');await wait(180);assert.equal(await js('(async()=> (await window.desk.terminals()).length)()'),0);
  await js('document.querySelector("#tools-close").click()');
  const loginMessage=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:'',status:'failed',errorCode:'CODEX_LOGIN_REQUIRED',note:'This role is not signed in to Codex.'});
  await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(fixture.chat.id)};renderList();activateChat();})()`);await wait(100);
  assert.equal(await js(`document.getElementById(${JSON.stringify('msg-'+loginMessage.id)}).querySelector('.native-login').hidden`),false);
  assert((await js(`document.getElementById(${JSON.stringify('msg-'+loginMessage.id)}).querySelector('.message-note').textContent`)).includes('此角色尚未登录'));
  assert((await js(`document.getElementById(${JSON.stringify('msg-'+loginMessage.id)}).querySelector('.message-bubble').textContent`)).includes('需要登录'));
  fs.writeFileSync(path.join(directory,'native-login-required.png'),(await window.webContents.capturePage()).toPNG());
  const sharedLoginMessage=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:'',status:'failed',errorCode:'CODEX_DESKTOP_LOGIN_REQUIRED',note:'Sign in to desktop Codex.'});
  await js('(async()=>{state=await api.snapshot();renderMessages();})()');await wait(80);
  assert.equal(await js(`document.getElementById(${JSON.stringify('msg-'+sharedLoginMessage.id)}).querySelector('.native-login').textContent`),'检查桌面版登录');
  const missingModelMessage=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:'',status:'failed',errorCode:'CODEX_MODEL_REQUIRED',note:'Choose a model.'});
  await js('(async()=>{state=await api.snapshot();renderMessages();})()');await wait(60);
  assert.equal(await js(`document.getElementById(${JSON.stringify('msg-'+missingModelMessage.id)}).querySelector('.select-task-model').hidden`),false);
  await js(`document.getElementById(${JSON.stringify('msg-'+missingModelMessage.id)}).querySelector('.select-task-model').click()`);await wait(60);
  assert.equal(await js('document.querySelector("#dialog").open'),true);await js('document.querySelector("#dialog-cancel").click()');
  const newRoleIds=await js('(async()=>{const s=await api.snapshot();const ids=[];for(const name of ["Fixture New Role One","Fixture New Role Two"]){const saved=await api["role-save"]({...s.roles[0],id:undefined,name,model:"fixture-model"});ids.push(saved.id);}return ids;})()');
  assert(newRoleIds.every(id=>!fixture.project.roleIds.includes(id)));
  await js('document.querySelector("#chat-new").click()');
  assert.equal(await js('document.querySelectorAll(".role-option").length'),5);
  assert.equal(await js('document.querySelector("#dialog-form button[type=submit]").disabled'),true);
  for(const name of ['Fixture New Role One','Fixture New Role Two'])await js(`(()=>{const search=document.querySelector('.role-picker-search input');search.value=${JSON.stringify(name)};search.dispatchEvent(new Event('input'));document.querySelector('.role-option:not([hidden]) input').click();})()`);
  await js('document.querySelector(".role-picker-search input").value="missing role";document.querySelector(".role-picker-search input").dispatchEvent(new Event("input"))');
  assert.equal(await js('document.querySelector(".role-picker-empty").hidden'),false);
  assert.equal(await js('document.querySelectorAll(".role-picker-chip").length'),2);
  await js('document.querySelector(".role-picker-search input").value="";document.querySelector(".role-picker-search input").dispatchEvent(new Event("input"))');await wait(120);
  fs.writeFileSync(path.join(directory,'role-picker.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#dialog-form").requestSubmit()');await wait(160);
  const newChat=store.state.chats.find(c=>c.roleIds.includes(newRoleIds[0]));assert(newChat);assert.deepEqual(newChat.roleIds,newRoleIds);assert(newRoleIds.every(id=>fixture.project.roleIds.includes(id)));
  await js('document.querySelector("#chat-settings").click()');
  assert.equal(await js('document.querySelectorAll(".role-option input:checked").length'),2);
  await js('document.querySelector(".role-picker-chip").click();document.querySelector("#dialog-form").requestSubmit()');await wait(120);assert.equal(newChat.roleIds.length,1);
  window.setContentSize(1000,700);await wait(180);
  assert(await js('document.querySelector("#send").getBoundingClientRect().right<=innerWidth'));
  await js('document.querySelector("#tool-files").click()');await wait(180);await js('document.querySelector("#tools-wide").click()');await wait(100);
  assert((await js('document.querySelector("#tools-panel").getBoundingClientRect().width'))>500);
  await js('document.querySelector("[data-page=roles]").click()');await wait(100);
  assert((await js('document.querySelector("#role-form").getBoundingClientRect().width'))>200);
  window.setContentSize(1488,1056);
  await js('document.querySelector("[data-page=settings]").click();document.querySelector("#s-theme").value="dark";document.querySelector("#s-theme").dispatchEvent(new Event("change"))');await wait(200);
  assert.equal(store.state.settings.theme,'dark');
  assert.equal(store.persisted().settings.theme,'dark');
  assert.equal(await js('document.documentElement.dataset.theme'),'dark');
  assert.equal(await js('getComputedStyle(document.body).backgroundColor'),'rgb(25, 29, 35)');
  await js('document.querySelector("#s-theme").scrollIntoView({block:"center"})');await wait(100);
  fs.writeFileSync(path.join(directory,'theme-settings-dark.png'),(await window.webContents.capturePage()).toPNG());
  fixture.chat.messages.push({id:'theme-markdown',kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:'## Theme review\n\nReadable text and `inline code`.\n\n| Item | Status |\n|---|---|\n| Dark palette | Ready |\n\n```js\nconst theme = "dark";\n```',status:'complete',at:Date.now()});
  await js(`(async()=>{state=await api.snapshot();projectId=state.projects[0].id;chatId=${JSON.stringify(fixture.chat.id)};document.querySelector("[data-page=projects]").click();})()`);await wait(200);
  assert.equal(await js('document.querySelectorAll("#messages table").length'),1);
  fs.writeFileSync(path.join(directory,'theme-chat-dark.png'),(await window.webContents.capturePage()).toPNG());
  await js('openChat()');await wait(100);
  assert.equal(await js('getComputedStyle(document.querySelector("dialog")).backgroundColor'),'rgb(25, 29, 35)');
  fs.writeFileSync(path.join(directory,'theme-dialog-dark.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#dialog-cancel").click()');
  await js('openTools("files")');await wait(120);
  await js(`document.querySelector("#file-list").hidden=true;document.querySelector("#file-preview").hidden=false;document.querySelector("#file-preview").textContent=${JSON.stringify('File preview\n\nReadable text on a dark background.')}`);
  await wait(150);
  assert.equal(await js('getComputedStyle(document.querySelector("#tools-panel")).backgroundColor'),'rgb(34, 40, 48)');
  fs.writeFileSync(path.join(directory,'theme-files-dark.png'),(await window.webContents.capturePage()).toPNG());
  await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload();});await wait(250);
  assert.equal(await js('document.documentElement.dataset.theme'),'dark');
  assert.equal(await js('localStorage.getItem("relay-desk-theme")'),'dark');
  await js('document.querySelector("[data-page=settings]").click();document.querySelector("[data-theme-choice=eyecare]").click()');await wait(150);
  assert.equal(store.state.settings.theme,'eyecare');
  assert.equal(await js('document.documentElement.dataset.theme'),'eyecare');
  assert.equal(await js('document.documentElement.dataset.themeTone'),'light');
  assert.equal(await js('getComputedStyle(document.body).backgroundColor'),'rgb(231, 240, 230)');
  assert.equal(require('electron').nativeTheme.themeSource,'light');
  fs.writeFileSync(path.join(directory,'theme-settings-eyecare.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#s-theme").value="forest-night";document.querySelector("#s-theme").dispatchEvent(new Event("change"))');await wait(120);
  assert.equal(await js('document.documentElement.dataset.theme'),'forest-night');
  assert.equal(await js('document.documentElement.dataset.themeTone'),'dark');
  assert.equal(require('electron').nativeTheme.themeSource,'dark');
  await js('document.querySelector("#s-theme").value="light";document.querySelector("#s-theme").dispatchEvent(new Event("change"))');await wait(120);
  assert.equal(await js('document.documentElement.dataset.theme'),'light');
  await js('document.querySelector("#s-theme").value="system";document.querySelector("#s-theme").dispatchEvent(new Event("change"))');await wait(120);
  assert.equal(require('electron').nativeTheme.themeSource,'system');
  assert.equal(await js('document.documentElement.dataset.theme === (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")'),true);
  const quotaBase={...store.state.roles[0],id:undefined,engine:'codex',provider:'native',locationId:'local',executable:'',codexLoginSource:'desktop',proxyMode:'direct'};
  const quotaRoles=[store.saveRole({...quotaBase,name:'Quota Fixture Codex'}),store.saveRole({...quotaBase,name:'Quota Fixture Shared'}),store.saveRole({...quotaBase,name:'Quota Fixture Claude',engine:'claude',codexLoginSource:'isolated'}),store.saveRole({...quotaBase,name:'Quota Fixture Antigravity',engine:'antigravity',codexLoginSource:'isolated'}),store.saveRole({...quotaBase,name:'Quota Fixture DeepSeek',provider:'deepseek',codexLoginSource:'isolated'})];
  services.accountUsage.native=async()=>({state:'ready',windows:[{id:'5h',label:'5h',usedPercent:40,windowMinutes:300,resetsAt:Math.floor(Date.now()/1000)+7200}],updatedAt:Date.now(),source:'codex-app-server'});
  services.accountUsage.balance=async()=>({state:'ready',balances:[{currency:'CNY',remaining:'12.34'}],updatedAt:Date.now(),source:'deepseek-api'});
  await js('(async()=>{state=await api.snapshot();renderSidebar();document.querySelector("#usage-center-open").click();document.querySelector(".usage-search").value="Quota Fixture";document.querySelector(".usage-search").dispatchEvent(new Event("input"));})()');await wait(100);
  assert.equal(await js('document.querySelectorAll(".usage-card").length'),4);
  assert.equal(await js('document.querySelector(".usage-filter").value'),'all');
  assert((await js('document.querySelector("#usage-center").textContent')).includes('共用登录配置'));
  await js('document.querySelector(".usage-refresh-all").click()');
  for(let attempt=0;attempt<150&&services.accountUsage.snapshot().filter(e=>e.roleIds.some(id=>quotaRoles.some(r=>r.id===id))).some(e=>e.refreshable&&e.state!=='ready');attempt++)await wait(40);
  await wait(180);
  assert.equal(await js('document.querySelector(".usage-card progress").value'),40);
  assert((await js('document.querySelector("#usage-center").textContent')).includes('剩余 60%'));
  assert((await js('document.querySelector("#usage-center").textContent')).includes('可用余额：12.34 CNY'));
  assert((await js('document.querySelector("#usage-center").textContent')).includes('应用内查看额度'));
  const nativeQuotaOpen=services.quotaConsole.open;let quotaRoleOpened;
  services.quotaConsole.open=async id=>{quotaRoleOpened=id;};
  try{await js('[...document.querySelectorAll(".usage-card")].find(card=>card.textContent.includes("Quota Fixture Antigravity")).querySelector("button").click()');await wait(80);assert.equal(quotaRoleOpened,quotaRoles[3].id);}finally{services.quotaConsole.open=nativeQuotaOpen;}
  assert.equal(await js('document.querySelectorAll(".usage-card progress").length'),2);
  fs.writeFileSync(path.join(directory,'usage-center.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#dialog-cancel").click();document.querySelector("[data-page=roles]").click()');await wait(100);
  assert((await js('document.querySelectorAll(".role-usage-summary").length'))>=5);
  await js(`editRole(role(${JSON.stringify(quotaRoles[0].id)}));document.querySelector('#role-usage-open').click()`);await wait(80);
  assert.equal(await js('document.querySelector("#dialog").open'),true);assert.equal(await js('document.querySelectorAll(".usage-card").length'),1);
  await js('document.querySelector("#dialog-cancel").click()');
  assert(!Object.entries((await js('(async()=>await api.snapshot())()')).connectionStatus).some(([id,status])=>id!=='local'&&status==='ready'));
  fs.writeFileSync(path.join(directory,'usage-checks.json'),JSON.stringify({passed:true,checks:['all roles discoverable','shared login groups deduplicated','used progress 40 means remaining 60','API currency shown separately','unknown quotas have no progress bar','refresh uses metadata fixture only','role list summaries','role settings open focused quota','no automatic SSH connection'],consoleErrors:errors},null,2));
  const attachmentChat=store.createChat({projectId:fixture.project.id,roleIds:[fixture.roles[0].id],name:'Attachment Fixture'});
  const dropFile=path.join(directory,'fixture-\u6587\u4ef6-` @agent.md'),pickedFile=path.join(directory,'chooser-source.txt');fs.writeFileSync(dropFile,'Fixture dropped content');fs.writeFileSync(pickedFile,'Fixture chosen content');
  await js(`(async()=>{state=await api.snapshot();page='projects';projectId=${JSON.stringify(fixture.project.id)};chatId=${JSON.stringify(attachmentChat.id)};showPage('projects');document.querySelector('#input').value='Fixture typed request';document.querySelector('#input').dispatchEvent(new Event('input'));})()`);
  const drop=async filename=>{
    const point=await js('(()=>{const r=document.querySelector("#input").getBoundingClientRect();return {x:r.x+20,y:r.y+20};})()');
    window.webContents.debugger.attach('1.3');
    try{for(const type of ['dragEnter','dragOver','drop'])await window.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type,...point,data:{items:[],files:[filename],dragOperationsMask:1}});}finally{window.webContents.debugger.detach();}
    for(let attempt=0;attempt<100&&!attachmentChat.draftAttachments.some(f=>f.path===filename);attempt++)await wait(30);await wait(80);
  };
  await drop(dropFile);assert.equal(attachmentChat.draftAttachments.length,1);assert.equal(await js('document.querySelector("#input").value'),'Fixture typed request');
  assert.equal(await js('document.querySelectorAll("#attachments .attachment-card").length'),1);assert((await js('document.querySelector("#attachments").textContent')).includes(path.basename(dropFile)));
  await drop(dropFile);assert.equal(attachmentChat.draftAttachments.length,1);
  const originalFileDialog=services.dialog.showOpenDialog;services.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[pickedFile]});
  try{await js('document.querySelector("#attach").click()');for(let attempt=0;attempt<100&&attachmentChat.draftAttachments.length<2;attempt++)await wait(30);}finally{services.dialog.showOpenDialog=originalFileDialog;}
  assert.equal(attachmentChat.draftAttachments.length,2);
  await js('document.querySelectorAll("#attachments .attachment-remove")[1].click()');await wait(80);assert.equal(attachmentChat.draftAttachments.length,1);
  let resolveClipboard;const originalImageSource=services.imageSource.read;services.imageSource.read=()=>new Promise(resolve=>{resolveClipboard=resolve;});
  await js('document.querySelector("#paste-image").click()');await wait(60);const beforePending=attachmentChat.messages.length;
  await js('document.querySelector("#input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');assert.equal(attachmentChat.messages.length,beforePending);
  await js(`document.querySelector('[data-chat="${fixture.chat.id}"]').click()`);
  resolveClipboard(require('electron').nativeImage.createFromBitmap(Buffer.alloc(32*24*4,200),{width:32,height:24}));
  for(let attempt=0;attempt<100&&attachmentChat.draftAttachments.length<2;attempt++)await wait(30);services.imageSource.read=originalImageSource;
  assert.equal(fixture.chat.draftAttachments.length,0);assert.equal(attachmentChat.draftAttachments[1].kind,'clipboard-image');
  await js(`document.querySelector('[data-chat="${attachmentChat.id}"]').click()`);await wait(100);
  assert.equal(await js('document.querySelectorAll("#attachments .attachment-thumbnail").length'),1);
  assert.equal(await js('document.querySelector("#input").value'),'Fixture typed request');
  await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload();});await wait(250);
  await js(`(async()=>{state=await api.snapshot();projectId=${JSON.stringify(fixture.project.id)};chatId=${JSON.stringify(attachmentChat.id)};renderSidebar();activateChat();})()`);await wait(150);
  assert.equal(await js('document.querySelectorAll("#attachments .attachment-card").length'),2);assert.equal(await js('document.querySelector("#input").value'),'Fixture typed request');
  fs.writeFileSync(dropFile,'Fixture file changed after staging');const rejectedBefore=attachmentChat.messages.length;
  await js('document.querySelector("#send").click()');await wait(140);assert.equal(attachmentChat.messages.length,rejectedBefore);assert.equal(await js('document.querySelector("#input").value'),'Fixture typed request');assert.equal(attachmentChat.draftAttachments.length,2);assert((await js('document.querySelector("#toast").textContent')).includes('发生了变化'));
  await js('document.querySelector("#attachments .attachment-remove").click()');await wait(70);await drop(dropFile);
  await wait(180);fs.writeFileSync(path.join(directory,'composer-attachments.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#send").click()');for(let attempt=0;attempt<100&&(attachmentChat.messages.length<rejectedBefore+2||services.running.size);attempt++)await wait(30);
  assert.equal(attachmentChat.messages.length,rejectedBefore+2);assert.equal(attachmentChat.messages[rejectedBefore].text,'Fixture typed request');assert.equal(attachmentChat.messages[rejectedBefore].attachments.length,2);assert.equal(await js('document.querySelector("#input").value'),'');assert.equal(await js('document.querySelectorAll("#attachments .attachment-card").length'),0);assert.equal(await js('document.querySelectorAll(".message.user .attachment-card").length'),2);
  await js('document.querySelector(".message.user .restore").click()');await wait(100);assert.equal(await js('document.querySelector("#input").value'),'Fixture typed request');assert.equal(await js('document.querySelectorAll("#attachments .attachment-card").length'),2);
  await js('document.querySelector("#input").value="";document.querySelector("#input").dispatchEvent(new Event("input"));document.querySelector("#send").click()');for(let attempt=0;attempt<100&&(attachmentChat.messages.length<rejectedBefore+4||services.running.size);attempt++)await wait(30);
  assert.equal(attachmentChat.messages[rejectedBefore+2].text,'');assert.equal(attachmentChat.messages[rejectedBefore+2].attachments.length,2);
  await wait(180);fs.writeFileSync(path.join(directory,'history-attachments.png'),(await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(directory,'attachment-checks.json'),JSON.stringify({passed:true,checks:['native Chromium file drop reaches preload','typed text unchanged','file chooser shares staging','duplicates deduplicated','individual removal','clipboard thumbnail normalization','pending paste blocks send','async paste stays in original chat','draft cards survive navigation and reload','changed file rejection retains draft','accepted send clears submitted cards','history renders cards','restore includes files','attachment-only send'],consoleErrors:errors},null,2));
  let permissionLocation=store.state.locations.find(l=>l.type==='ssh');
  if(!permissionLocation){permissionLocation={id:'claude-permission-ssh',name:'Fixture VPS',type:'ssh',os:'linux',control:'ssh',host:'example.invalid',username:'fixture',port:22};store.state.locations.push(permissionLocation);}
  const claudePermissionRole=store.saveRole({...store.state.roles[0],id:undefined,name:'Claude Permission Fixture',engine:'claude',provider:'native',locationId:permissionLocation.id,permission:'acceptEdits',codexLoginSource:'isolated',allowLocationTools:false});
  await js(`(async()=>{state=await api.snapshot();showPage('roles');editRole(role(${JSON.stringify(claudePermissionRole.id)}));document.querySelector('#role-connection').open=true;})()`);await wait(100);
  assert.equal(await js('document.querySelector("#r-permission").disabled'),false);assert.equal(await js('document.querySelector("#r-permission").value'),'workspace-write');
  await js('document.querySelector("#r-permission").value="danger-full-access";document.querySelector("#r-permission").dispatchEvent(new Event("change"));document.querySelector("#r-permission").scrollIntoView({block:"center"})');await wait(180);
  const permissionHint = await js('document.querySelector("#permission-hint").textContent');
  assert(permissionHint.includes('跳过工具审批'));
  assert(permissionHint.includes('仍受系统权限'));
  fs.writeFileSync(path.join(directory,'claude-permission-settings.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#role-form").requestSubmit()');await wait(120);assert.equal(store.get('roles',claudePermissionRole.id).permission,'danger-full-access');
  const permissionChat=store.createChat({projectId:fixture.project.id,roleIds:[claudePermissionRole.id],name:'Claude Permission Replies'});
  const oldApproval=store.message(permissionChat.id,{kind:'assistant',roleId:claudePermissionRole.id,roleName:claudePermissionRole.name,locationId:permissionLocation.id,text:'Partial permission fixture',status:'complete',note:'Some tools require approval. Use the project terminal or classic interface to approve them.'});
  const fullApproval=store.message(permissionChat.id,{kind:'assistant',roleId:claudePermissionRole.id,roleName:claudePermissionRole.name,locationId:permissionLocation.id,text:'Policy fixture',status:'complete',permission:'danger-full-access',warningCode:'CLAUDE_PERMISSION_DENIED',note:'Some tools were denied by Claude permission rules.'});
  await js(`(async()=>{state=await api.snapshot();showPage('projects');projectId=${JSON.stringify(fixture.project.id)};chatId=${JSON.stringify(permissionChat.id)};renderSidebar();activateChat();})()`);await wait(80);
  assert((await js(`document.getElementById(${JSON.stringify('msg-'+oldApproval.id)}).querySelector('.message-note').textContent`)).includes('另一个终端补批'));
  assert((await js(`document.getElementById(${JSON.stringify('msg-'+fullApproval.id)}).querySelector('.message-note').textContent`)).includes('本次已使用 Claude 完全权限'));
  assert(!Object.entries((await js('(async()=>await api.snapshot())()')).connectionStatus).some(([id,status])=>id!=='local'&&status==='ready'));
  fs.writeFileSync(path.join(directory,'claude-permission-checks.json'),JSON.stringify({passed:true,checks:['remote Claude permission selector enabled','legacy acceptEdits maps to standard selection','full mode explains tool approvals and system limits','saving persists full permission mode','legacy denied-tool hint translated without cross-process approval claim','full-mode denial points to native/service policies','no automatic SSH connection'],consoleErrors:errors},null,2));
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'shared-login-checks.json'),JSON.stringify({passed:true,checks:['desktop reuse selector persists','API roles hide desktop selector','draft model catalog uses selected source','login check does not open authorization window','shared missing-login message targets desktop source'],consoleErrors:errors},null,2));
  fs.writeFileSync(path.join(directory,'conversation-checks.json'),JSON.stringify({passed:true,checks:['per-chat models preserve role defaults and other chats','avatar dialog loads searchable model catalog','model and effort snapshots dispatched on next send','independent and relay context captured','default participant order persists','all-participant mention with explicit final speaker','CLI reasoning details visible','read-only task console follows emitted output','task console expansion and selection','shared project terminal preserved'],consoleErrors:errors},null,2));
  fs.writeFileSync(path.join(directory,'smoke.json'),JSON.stringify({passed:true,checks:['initial render','bottom scroll','no automatic SSH','role edit/persistence','two freeform persona fields','encrypted API-key storage','immutable local location','settings','draft persistence/navigation','project file listing/expanded panel','group two-round order','incremental message events','accepted send clears composer','pause stops queued participants','project terminal survives switching chat','terminal close','all roles available in chooser','search preserves multi-selection','new roles join project on chat save','editing preserves chosen roles','Fable 3 percent used renders 97 percent remaining','quota progress represents used percentage','quota panel collapses without connecting','Claude updater version display','Claude check/update/rollback actions','dark theme immediate switching','theme saved and restored after reload','light override and system preference','dark Markdown/dialog/file preview surfaces','avatar presets and cancel','uploaded avatar normalization and local persistence','avatar library reuse and deduplication','invalid avatar rejection','per-role full access selection and persistence','mention keyboard selection without sending','single and subset mention routing','IME and escape handling','mention target restored with draft','automatic model list on connection expansion','model search and refresh','draft credentials without saving','manual model and failure fallback','Chromium provider transport streams authenticated responses','visible system proxy error','custom proxy routing through Chromium','local location proxy remains editable','per-role direct override persists'],consoleErrors:errors},null,2));
  app.exit(0);
}
module.exports={run};
