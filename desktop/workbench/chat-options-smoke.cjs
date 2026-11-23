const assert = require('node:assert/strict');

async function run({app, store, fixture, services, js, errors}) {
  const [first, second] = fixture.roles;
  const runs=[];
  let refreshed=false;
  services.modelCatalogs.request=async (_role,{force}={})=>{
    if(force)refreshed=true;
    return {updatedAt:Date.now(),models:[
      {id:'deep-fixture',efforts:refreshed?['max','ultra']:['max'],isDefault:true,defaultEffort:'max'},
      {id:'fast-fixture',efforts:['low'],defaultEffort:'low'}
    ]};
  };
  services.agents.run=async (chatId,profile)=>{
    runs.push([profile.model,profile.effort]);
    return store.message(chatId,{kind:'assistant',roleId:profile.id,roleName:profile.name,status:'complete',text:'Fixture answer'});
  };
  const chat=store.createChat({projectId:fixture.project.id,roleIds:[first.id,second.id],defaultReplyRoleIds:[first.id],name:'Dissolve Fixture'});
  const until=async check=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail('Chat options fixture timed out.');};
  await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(chat.id)};activateChat();openChatRole(${JSON.stringify(first.id)});})()`);
  await until(()=>js(`Boolean($('chat-effort').querySelector('[value="max"]'))`));
  assert.equal(await js(`Boolean($('chat-effort').querySelector('[value="ultra"]'))`),false);
  await js(`$('chat-model-picker').querySelector('.model-picker-refresh').click()`);
  await until(()=>js(`Boolean($('chat-effort').querySelector('[value="ultra"]'))`));
  assert.equal(await js(`Boolean($('quick-effort').querySelector('[value="ultra"]'))`),true);
  await js(`$('chat-model-picker').querySelector('input').value='deep-fixture';$('chat-effort').value='ultra';$('dialog-form').requestSubmit()`);
  await until(()=>chat.roleSettings[first.id].effort==='ultra');
  await js(`api.send({chatId,text:'Fixture request',roleIds:[${JSON.stringify(first.id)}]})`);
  await until(()=>chat.lastDiscussion?.state==='answered');
  assert.deepEqual(runs,[['deep-fixture','ultra']]);
  await js(`openChatRole(${JSON.stringify(first.id)});const effortTestInput=$('chat-model-picker').querySelector('input');effortTestInput.value='fast-fixture';effortTestInput.dispatchEvent(new Event('change'));`);
  assert.equal(await js(`$('chat-effort').value`),'model-default');
  assert.equal(await js(`Boolean($('chat-effort').querySelector('[value="ultra"]'))`),false);
  await js(`$('dialog-form').requestSubmit()`);
  await until(()=>chat.roleSettings[first.id].effort==='model-default');
  await js(`api.send({chatId,text:'Fixture next request',roleIds:[${JSON.stringify(first.id)}]})`);
  await until(()=>runs.length===2&&!services.running.has(chat.id));
  assert.deepEqual(runs[1],['fast-fixture','']);
  await js(`showPage('roles');editRole(role(${JSON.stringify(first.id)}));`);
  await until(()=>js(`Boolean($('r-effort').querySelector('[value="ultra"]'))`));
  await js(`showPage('projects')`);

  const remote = store.saveLocation({name:'Review VPS',host:'example.invalid',username:'fixture',port:22,os:'linux',control:'ssh'});
  const reviewer = store.saveRole({...first,id:undefined,name:'Remote reviewer',locationId:remote.id});
  const planner = store.saveRole({...first,id:undefined,name:'Remote planner',locationId:remote.id});
  const directoryChat = store.createChat({projectId:fixture.project.id,roleIds:[first.id,reviewer.id,planner.id],name:'Missing directory fixture'});
  await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(directoryChat.id)};activateChat();$('input').value='Keep this draft';await send();})()`);
  const directoryWarning = await js(`$('toast').textContent`);
  assert(directoryWarning.includes(fixture.project.name));
  assert.match(directoryWarning, /Review VPS.*Remote reviewer.*Remote planner/);
  assert.match(directoryWarning, /\u9879\u76ee\u8bbe\u7f6e → \u6dfb\u52a0\u76ee\u5f55/);
  assert.equal(await js(`$('input').value`), 'Keep this draft');
  assert.equal(directoryChat.messages.length, 0);
  await js(`chatId=${JSON.stringify(chat.id)};activateChat();`);

  const extra=store.saveRole({...first,id:undefined,name:'Disbanded-only fixture role'});
  store.saveChat({id:chat.id,roleIds:[first.id,extra.id]});
  await js(`(async()=>{state=await api.snapshot();activateChat();$('chat-settings').click();window.confirm=()=>false;})()`);
  await assert.rejects(js(`api['role-delete'](${JSON.stringify(extra.id)})`),/Dissolve Fixture/);
  assert.equal(await js(`$('dialog-body').lastElementChild.contains($('chat-disband'))`),true);
  assert.match(await js(`$('chat-disband-warning').textContent`),/只读/);
  assert.equal(await js(`getComputedStyle($('chat-disband')).backgroundColor`),'rgb(180, 35, 50)');
  await js(`$('chat-disband').onclick()`);
  assert.equal(chat.disbandedAt,undefined);
  assert.equal(await js(`$('dialog').open`),true);
  await js(`window.confirm=()=>true; void 0;`);
  await js(`$('chat-disband').click()`);
  await until(()=>chat.disbandedAt&&js(`$('composer').hidden && $('chat-subtitle').textContent.includes('群聊已解散')`));
  assert.equal(chat.messages.filter(message=>message.kind==='assistant').length,2);
  await assert.rejects(js(`api.send({chatId,text:'Do not reopen',roleIds:[${JSON.stringify(first.id)}]})`),/群聊已解散/);
  await js(`api['role-delete'](${JSON.stringify(extra.id)})`);
  assert(!store.state.roles.some(profile=>profile.id===extra.id));
  assert.equal(chat.messages.filter(message=>message.kind==='assistant').length,2);
  const guest=fixture.roles[2];
  const group=store.createChat({projectId:fixture.project.id,roleIds:[first.id,second.id],defaultReplyRoleIds:[first.id],name:'Guest mention fixture'});
  const outsider=store.saveRole({...first,id:undefined,name:'Not assigned to the project'});
  await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(group.id)};activateChat();})()`);
  const type=text=>js(`$('input').value=${JSON.stringify(text)};$('input').setSelectionRange($('input').value.length,$('input').value.length);$('input').dispatchEvent(new Event('input'));`);
  await type('@');
  assert.deepEqual(await js(`[...$('mention-menu').querySelectorAll('.mention-option strong')].map(label=>label.textContent)`),
    ['@所有角色','@'+first.name,'@'+second.name,'@'+guest.name,'@'+reviewer.name,'@'+planner.name]);
  const guestOption=`[...$('mention-menu').querySelectorAll('.mention-guest')].find(button=>button.querySelector('strong').textContent===${JSON.stringify('@'+guest.name)})`;
  assert.equal(await js(`(${guestOption}).disabled`),false);
  assert.match(await js(`(${guestOption}).textContent`),/未加入群聊/);
  await js(`(${guestOption}).click()`);
  assert.equal(await js(`$('quick-model').hidden`),true);
  await type('@'+guest.name+' Only answer this task');
  await js(`send()`);
  await until(()=>group.lastDiscussion?.state==='answered');
  assert.deepEqual(group.messages.filter(message=>message.kind==='assistant').map(message=>message.roleId),[guest.id]);
  assert.deepEqual(group.roleIds,[first.id,second.id]);
  assert.deepEqual(group.defaultReplyRoleIds,[first.id]);
  const reply=group.messages.find(message=>message.roleId===guest.id);
  await js(`document.getElementById(${JSON.stringify('msg-'+reply.id)}).querySelector('.task-output').click()`);
  await until(()=>js(`$('activity-role').value===${JSON.stringify(guest.id)} && $('activity-run').value===${JSON.stringify(reply.id)}`));
  await assert.rejects(js(`api.send({chatId,text:'Outsider',roleIds:[${JSON.stringify(outsider.id)}]})`),/当前无法在此群聊发言/);

  const running={controller:new AbortController(),roleIds:[first.id],roleId:first.id,round:1,rounds:1};
  services.running.set(group.id,running);
  const queued=await js(`api.send({chatId,text:'Queued guest request',roleIds:[${JSON.stringify(guest.id)}]})`);
  await js(`$('project-edit').click();$('p-guest-mentions').checked=false;$('dialog-submit').click();`);
  await until(()=>store.get('projects',group.projectId).allowGuestMentions===false && js(`!$('dialog').open`));
  await assert.rejects(js(`api['queue-now'](chatId,${JSON.stringify(queued.queueId)})`),/当前无法在此群聊发言/);
  assert.equal(running.controller.signal.aborted,false);
  services.running.delete(group.id);
  await js(`api['queue-resume'](chatId)`);
  await until(()=>group.queueReason==='blocked');
  assert.equal(group.inputQueue[0]?.id,queued.queueId);
  await type('@');
  assert.equal(await js(`$('mention-menu').querySelectorAll('.mention-guest').length`),0);
  await type('@'+guest.name+' Keep this draft');
  await js(`send()`);
  assert.match(await js(`$('toast').textContent`),/已关闭点名/);
  assert.equal(await js(`$('input').value`),'@'+guest.name+' Keep this draft');
  assert.equal(group.messages.length,2);
  await assert.rejects(js(`api.send({chatId,text:'Blocked guest',roleIds:[${JSON.stringify(guest.id)}]})`),/当前无法在此群聊发言/);
  assert.deepEqual(errors,[]);
  app.exit(0);
}

module.exports={run};
