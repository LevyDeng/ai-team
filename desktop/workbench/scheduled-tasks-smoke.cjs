const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');

async function until(predicate) {
  for(let i=0;i<120;i++) {
    if(await predicate())return;
    await delay(35);
  }
  assert.fail('Scheduled task state did not become ready');
}

async function run({window,store,app,directory,services,fixture,js,errors}) {
  const {chat,project,roles:[role]}=fixture;
  const calls=[];
  services.agents.run=async(id,actor,_project,_signal,_summary,context)=>{
    calls.push({id,roleId:actor.id,workflow:Boolean(context.workflowAttemptId)});
    const message=store.message(id,{kind:'assistant',roleId:actor.id,roleName:actor.name,text:'Fixture reply',status:context.workflowAttemptId?'failed':'complete'});
    services.agents.emit({chatId:id,message});
    return message;
  };
  const input=`@${role.name} Check the scheduled draft.`;
  await js(`$('input').value=${JSON.stringify(input)};$('input').dispatchEvent(new Event('input'));$('send-options').click();$('send-schedule').click();`);
  assert.equal(await js(`$('dialog-title').textContent`),'定时发送');
  await js(`$('dialog-form').requestSubmit()`);
  await until(()=>js(`!$('dialog').open&&!$('draft-schedule').hidden`));
  assert.equal(await js(`$('input').value`),input);
  assert.equal(chat.scheduledTasks,undefined);
  await delay(160);
  const composer=await js(`(() => {
    const {x,y,width,height}=$('composer').getBoundingClientRect();
    return {x:Math.ceil(x),y:Math.ceil(y),width:Math.floor(width),height:Math.floor(height)};
  })()`);
  fs.writeFileSync(path.join(directory,'scheduled-send-selected.png'),(await window.webContents.capturePage(composer)).toPNG());
  await js(`$('send').click()`);
  await until(()=>chat.scheduledTasks?.length===1);
  const scheduled=chat.scheduledTasks[0];
  const persisted=store.persisted().chats.find(item=>item.id===chat.id);
  assert.equal(persisted.scheduledTasks[0].value.text,input);
  assert.equal(calls.length,0);
  await until(()=>js(`!$('scheduled-tasks').hidden&&$('input').value===''`));
  await js(`$('input').value='New draft';$('input').dispatchEvent(new Event('input'));saveDraftNow();`);
  services.pumpScheduledTasks(scheduled.at-1);
  assert.equal(chat.scheduledTasks.length,1);
  services.pumpScheduledTasks(scheduled.at);
  services.pumpScheduledTasks(scheduled.at);
  await until(()=>calls.length===1&&!services.running.has(chat.id));
  assert.deepEqual(calls[0],{id:chat.id,roleId:role.id,workflow:false});
  assert.equal(chat.scheduledTasks.length,0);
  assert.equal(chat.draft,'New draft');
  assert.equal(chat.messages.filter(message=>message.kind==='user'&&message.text===input).length,1);

  const invoke=(name,...args)=>js(`api[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  const definition={title:'Schedule fixture',type:'graph',structured:true,entry:'n1',nodes:[{id:'n1',kind:'role',roleId:role.id,title:'Check',instruction:'Check the fixture.',x:240,y:80,exits:[{label:'Done',to:'complete'}]}]};
  const saved=await invoke('workflow-group-save',chat.id,null,definition);
  await js(`openTools('workflow')`);
  await until(()=>js(`!$('group-workflow-start').disabled`));
  await js(`$('group-workflow-start').click();const mode=document.querySelector('[data-workflow-start-mode]');mode.value='scheduled';mode.dispatchEvent(new Event('change'));$('group-workflow-goal').value='Run the scheduled workflow.';$('dialog-form').requestSubmit();`);
  await until(()=>chat.scheduledTasks.length===1);
  const workflowTask=chat.scheduledTasks[0];
  assert.equal(workflowTask.value.definition.id,saved.id);
  assert.equal(chat.workflowRuns,undefined);
  const rescheduled=workflowTask.at+60000;
  await invoke('schedule-edit',chat.id,workflowTask.id,rescheduled);
  services.pumpScheduledTasks(workflowTask.at);
  assert.equal(chat.workflowRuns,undefined);
  services.pumpScheduledTasks(rescheduled);
  await until(()=>calls.length===2&&!services.running.has(chat.id));
  assert.equal(chat.workflowRuns.length,1);
  assert.equal(chat.workflowRuns[0].goal,'Run the scheduled workflow.');
  assert.equal(chat.scheduledTasks.length,0);

  const created=await invoke('workflow-create',{...definition,projectId:project.id,goal:'Check the scheduled standalone run.',startAt:rescheduled});
  const standalone=store.get('chats',created.id);
  assert.equal(standalone.workflow.status,'scheduled');
  assert.equal(store.persisted().chats.find(item=>item.id===created.id).workflow.status,'scheduled');
  await invoke('schedule-edit',created.id,standalone.scheduledTasks[0].id,null);
  services.pumpScheduledTasks(rescheduled);
  assert.equal(standalone.workflow.status,'paused');
  assert.equal(calls.length,2);
  const next=await invoke('workflow-create',{...definition,projectId:project.id,goal:'Run the standalone workflow.',startAt:rescheduled});
  services.pumpScheduledTasks(rescheduled+60000);
  await until(()=>calls.length===3&&!services.running.has(next.id));
  assert.equal(calls[2].id,next.id);
  assert.equal(store.get('chats',next.id).scheduledTasks.length,0);
  assert.deepEqual(errors,[]);
  console.log('Scheduled message and workflow smoke checks passed.');
  app.exit(0);
}

module.exports={run};
