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
  await js(`(async()=>{state=await api.snapshot();activateChat();openChat(chat());window.confirm=()=>true;})()`);
  await assert.rejects(js(`api['role-delete'](${JSON.stringify(extra.id)})`),/Dissolve Fixture/);
  await js(`$('chat-disband').click()`);
  await until(()=>chat.disbandedAt&&js(`$('composer').hidden && $('chat-subtitle').textContent.includes('群聊已解散')`));
  assert.equal(chat.messages.filter(message=>message.kind==='assistant').length,2);
  await assert.rejects(js(`api.send({chatId,text:'Do not reopen',roleIds:[${JSON.stringify(first.id)}]})`),/群聊已解散/);
  await js(`api['role-delete'](${JSON.stringify(extra.id)})`);
  assert(!store.state.roles.some(profile=>profile.id===extra.id));
  assert.equal(chat.messages.filter(message=>message.kind==='assistant').length,2);
  assert.deepEqual(errors,[]);
  app.exit(0);
}

module.exports={run};
