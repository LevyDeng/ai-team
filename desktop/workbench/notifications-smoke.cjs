const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function gate(){let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};}
async function run({window,store,app,directory,services,fixture,js,errors}){
  const {notifications,skills}=services,counts=[],attention=[];
  const render=notifications.render;notifications.render=count=>{counts.push(count);render(count);};
  notifications.attention=()=>attention.push(Date.now());
  // Keep this fixture chat out of view so the renderer cannot mark it read.
  const chat=store.createChat({projectId:fixture.project.id,name:'Notification fixture',roleIds:fixture.roles.map(role=>role.id)});
  const ids=chat.roleIds;chat.moderatorRoleId=ids[0];chat.moderatorCompression=false;store.save();
  const image=skills.list().find(skill=>skill.kind==='image');
  skills.vault.set('skill:'+image.id,'fixture-notification-key');
  let imageGate=gate();skills.image=async()=>{await imageGate.promise;return {files:[]};};
  let first=gate(),second=gate(),review=gate(),calls=[],observed=[];
  const until=async check=>{for(let n=0;n<100;n++){if(await check())return;await wait(50);}throw new Error('Notification fixture timed out.');};
  services.agents.run=async(chatId,role,_project,_signal,_summary,context)=>{
    const task=context.moderatorTask;calls.push(task?.kind||role.id);
    if(!task)observed.push({roleId:role.id,model:role.model,relay:context.relayReplies});
    if(task){
      await review.promise;
      const message=store.message(chatId,{kind:'assistant',roleId:role.id,roleName:role.name,status:'complete',moderatorTask:task.kind,text:JSON.stringify({kind:task.kind,token:task.token,sourceHash:task.sourceHash,decision:'complete',reason:'Fixture discussion is complete.'})});
      services.agents.emit({chatId,message});return message;
    }
    const message=store.message(chatId,{kind:'assistant',roleId:role.id,roleName:role.name,status:'running',text:'Fixture reply'});
    if(role.id===ids[1]){
      await skills.run(skills.scope(chatId,role.id,context.taskId),image.id,'Fixture nested image');
      message.text='Fixture final answer before CLI cleanup';services.agents.emit({chatId,message});await first.promise;
    }else await second.promise;
    message.status='complete';services.agents.emit({chatId,message});return message;
  };
  chat.unread=true;notifications.refresh();assert.equal(counts.at(-1),1);
  await js(`api.send({chatId:${JSON.stringify(chat.id)},text:'Fixture group task',roleIds:${JSON.stringify(ids.slice(1))},rounds:2,autoStop:true})`);
  await until(()=>skills.jobs.size===1);assert.equal(counts.at(-1),0);assert.equal(chat.unread,true);assert.equal(attention.length,0);
  await js(`(async()=>{await api['chat-save']({id:${JSON.stringify(chat.id)},name:'Updated during task',roleIds:${JSON.stringify(ids.slice(0,2))},moderatorRoleId:'',moderatorCompression:false});await api['chat-flow'](${JSON.stringify(chat.id)},false);await api['chat-role-settings'](${JSON.stringify(chat.id)},${JSON.stringify(ids[1])},{model:'next-task-model',effort:'high'});})()`);
  assert.equal(chat.name,'Updated during task');assert.equal(chat.relayReplies,false);assert.equal(chat.moderatorRoleId,'');
  imageGate.release();await until(()=>!skills.jobs.size);
  assert.equal(attention.length,0,'Nested image completion must not request attention.');
  assert.equal(counts.at(-1),0,'Final-looking text must not notify before CLI cleanup.');
  first.release();await until(()=>calls.includes(ids[2]));assert.equal(attention.length,0);
  second.release();await until(()=>calls.includes('review'));assert.equal(attention.length,0);assert.equal(counts.at(-1),0);
  assert.equal(services.running.get(chat.id).phase,'review');
  review.release();await until(()=>!services.running.has(chat.id));
  assert.equal(chat.lastDiscussion.state,'complete');assert.equal(attention.length,1);assert.equal(counts.at(-1),1);
  assert.deepEqual(observed.map(value=>value.roleId),ids.slice(1));assert(observed.every(value=>value.relay===true&&value.model!=='next-task-model'));
  await js(`api.read(${JSON.stringify(chat.id)})`);assert.equal(counts.at(-1),0);
  imageGate=gate();
  await js(`api.send({chatId:${JSON.stringify(chat.id)},text:'/image Fixture standalone image',roleIds:${JSON.stringify([ids[1]])}})`);
  await until(()=>skills.jobs.size===1);assert.equal(attention.length,1);assert.equal(counts.at(-1),0);
  imageGate.release();await until(()=>attention.length===2);assert.equal(counts.at(-1),1);
  await js(`api.send({chatId:${JSON.stringify(chat.id)},text:'Fixture next task',roleIds:${JSON.stringify([ids[1]])},rounds:1,autoStop:true})`);
  await until(()=>attention.length===3);assert.equal(observed.at(-1).model,'next-task-model');assert.equal(observed.at(-1).relay,false);
  const auxiliary = new (require('electron').BrowserWindow)({show:false});
  const overlays = [], auxiliaryOverlays = [], flashes = [];
  window.setOverlayIcon = icon => overlays.push(Boolean(icon));
  auxiliary.setOverlayIcon = icon => auxiliaryOverlays.push(Boolean(icon));
  window.flashFrame = enabled => flashes.push(enabled);
  window.emit('focus');
  assert.equal(counts.at(-1),1);
  assert.equal(flashes.at(-1),false);
  if(process.platform==='win32')assert.equal(overlays.at(-1),true);
  await js(`api['chat-delete'](${JSON.stringify(chat.id)})`);
  assert.equal(counts.at(-1),0,'Deleting the last unread chat must clear the taskbar badge.');
  if(process.platform==='win32')assert.equal(overlays.at(-1),false);
  const otherProject=store.saveProject({name:'Unread project fixture',directories:[{locationId:'local',path:directory}]});
  const otherChat=store.createChat({projectId:otherProject.id,roleIds:[ids[1]]});
  notifications.complete(otherChat.id);
  assert.equal(counts.at(-1),1);
  services.dialog.showMessageBox = async () => ({response:1});
  assert.equal(await js(`api['project-delete'](${JSON.stringify(otherProject.id)})`),true);
  assert.equal(counts.at(-1),0,'Deleting a project must remove its conversations from the badge count.');
  window.emit('restore');
  if(process.platform==='win32')assert.equal(overlays.at(-1),false);
  assert.deepEqual(auxiliaryOverlays,[],'Login and auxiliary windows must never receive a workbench badge.');
  auxiliary.destroy();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'notification-checks.json'),JSON.stringify({passed:true,checks:['old unread excluded while new task runs','unread retained until read','nested image does not notify','final answer waits for CLI cleanup','next participant does not notify early','moderator review does not notify early','whole task notifies exactly once','standalone image still notifies','read clears taskbar badge','no real model or image requests'],counts,attentionCount:attention.length},null,2));
  app.exit(0);
}
module.exports={run};
