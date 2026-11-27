const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,services,fixture,js,errors}) {
  const ids=fixture.chat.roleIds;
  delete fixture.chat.defaultReplyRoleIds;
  require('./conversations.cjs').initialize(fixture.chat,fixture.roles);store.save();
  await js('(async()=>{state=await api.snapshot();activateChat();})()');
  assert.deepEqual(fixture.chat.defaultReplyRoleIds,[]);
  await js('openChat(chat())');
  assert.equal(await js('document.querySelector("#chat-default-replies").hidden'),false);
  const checked=()=>js('[...document.querySelectorAll("[name=default-reply-role]:checked")].map(x=>x.value)');
  assert.deepEqual(await checked(),[]);
  await js('document.querySelectorAll("[name=default-reply-role]")[0].click()');
  assert.deepEqual(await checked(),[ids[0]]);
  await js('document.querySelectorAll("[name=default-reply-role]")[0].click()');
  assert.deepEqual(await checked(),[]);
  await js('document.querySelectorAll("[name=default-reply-role]")[1].click();document.querySelectorAll("[name=default-reply-role]")[2].click()');
  assert.deepEqual(await checked(),ids.slice(1));
  fs.writeFileSync(path.join(directory,'default-replies-settings.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#dialog-close").click();openChat(chat())');
  assert.deepEqual(await checked(),[]);
  await js('document.querySelectorAll("[name=default-reply-role]")[1].click();document.querySelectorAll("[name=default-reply-role]")[2].click();document.querySelector("#dialog-form").requestSubmit()');
  for(let i=0;i<50&&await js('document.querySelector("#dialog").open');i++)await wait(100);
  assert.equal(await js('document.querySelector("#dialog").open'),false);
  assert.deepEqual(store.get('chats',fixture.chat.id).defaultReplyRoleIds,ids.slice(1));
  assert.deepEqual(await js('document.querySelector("#input").value="hello";composerRecipients().roleIds'),ids.slice(1));
  assert.deepEqual(await js('document.querySelector("#input").value="@所有人 hello";composerRecipients().roleIds'),ids);
  assert.deepEqual(await js(`document.querySelector('#input').value=${JSON.stringify('@'+fixture.roles[0].name+' hello')};composerRecipients().roleIds`),[ids[0]]);
  const calls=[];
  services.agents.run=async (_chatId,role)=>{calls.push(role.id);return {status:'complete'};};
  async function dispatch(text,expected,raw=false) {
    calls.length=0;
    if(raw)await js(`api.send({chatId:chat().id,text:${JSON.stringify(text)},rounds:1,autoStop:false})`);
    else await js(`$('input').value=${JSON.stringify(text)};$('auto-stop').checked=false;send()`);
    for(let i=0;i<100;i++){await wait(50);if(calls.length&& !services.running.has(fixture.chat.id)&&!services.inputQueue.dispatching.has(fixture.chat.id))break;}
    assert.deepEqual(calls,expected);
  }
  await dispatch('default dispatch',ids.slice(1));
  await dispatch('@'+fixture.roles[0].name+' explicit dispatch',[ids[0]]);
  await dispatch('@所有人 all dispatch',ids);
  await dispatch('backend fallback dispatch',ids.slice(1),true);
  await js('openChat(chat())');
  assert.deepEqual(await checked(),ids.slice(1));
  // Removing both defaults clears the configuration, reverting to all remaining participants.
  await js(`document.querySelector('#chat-role-picker input[value="${ids[1]}"]').click();document.querySelector('#chat-role-picker input[value="${ids[2]}"]').click()`);
  assert.deepEqual(await checked(),[]);
  assert.equal(await js('document.querySelector("#chat-default-replies").hidden'),true);
  await js('document.querySelector("#dialog-close").click()');
  assert.deepEqual(store.get('chats',fixture.chat.id).defaultReplyRoleIds,ids.slice(1));
  await window.webContents.reload();
  for(let i=0;i<60;i++){await wait(100);if(await js('typeof state!=="undefined"&&Boolean(state?.chats?.length)'))break;}
  assert.deepEqual(await js('chat().defaultReplyRoleIds'),ids.slice(1));
  await js('openChat(chat());document.querySelectorAll("[name=default-reply-role]")[1].click();document.querySelectorAll("[name=default-reply-role]")[2].click();document.querySelector("#dialog-form").requestSubmit()');
  for(let i=0;i<50&&await js('document.querySelector("#dialog").open');i++)await wait(100);
  assert.deepEqual(store.get('chats',fixture.chat.id).defaultReplyRoleIds,[]);
  await dispatch('cleared defaults dispatch',ids);
  await dispatch('cleared backend defaults dispatch',ids,true);
  await js(`(async()=>{
    await api['chat-save']({...chat(),defaultReplyRoleIds:[${JSON.stringify(ids[0])}]});
    state=await api.snapshot();activateChat();
    $('input').value='Check the default recipient';$('input').dispatchEvent(new Event('input'));
  })()`);
  assert.deepEqual(await js('composerRecipients().roleIds'),[ids[0]]);
  const controlsHidden=()=>js(`['round-limit-control','auto-stop-control'].map(id=>$(id).hidden)`);
  const draft=text=>js(`$('input').value=${JSON.stringify(text)};$('input').dispatchEvent(new Event('input'));`);
  assert.deepEqual(await controlsHidden(),[true,true]);
  await draft(`@${fixture.roles[0].name} @${fixture.roles[1].name} Two recipients`);
  assert.deepEqual(await controlsHidden(),[false,false]);
  assert.equal(await js(`$('rounds').disabled||$('auto-stop').disabled`),false);
  await draft(`@${fixture.roles[0].name} One explicit recipient`);
  assert.deepEqual(await controlsHidden(),[true,true]);
  await js(`(async()=>{await api['chat-save']({...chat(),defaultReplyRoleIds:${JSON.stringify(ids.slice(0,2))}});state=await api.snapshot();activateChat();})()`);
  await draft('Two default recipients');
  assert.deepEqual(await controlsHidden(),[false,false]);
  await js(`(async()=>{await api['chat-flow'](chat().id,false);state=await api.snapshot();activateChat();})()`);
  assert.deepEqual(await controlsHidden(),[true,true]);
  await js(`(async()=>{await api['chat-flow'](chat().id,true);state=await api.snapshot();activateChat();})()`);
  assert.deepEqual(await controlsHidden(),[false,false]);
  await draft(`@${fixture.roles[0].name} Override two default recipients`);
  assert.deepEqual(await controlsHidden(),[true,true]);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'default-replies-checks.json'),JSON.stringify({passed:true,checks:['unconfigured defaults to everyone','empty selection restores everyone','subset save','cancel discards changes','explicit mentions override','all alias','member removal','reload persistence'],consoleErrors:errors},null,2));
  app.exit(0);
}
module.exports={run};
