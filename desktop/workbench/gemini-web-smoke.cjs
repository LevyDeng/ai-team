const assert = require('node:assert/strict');
const {conversationUrl} = require('./gemini-web.cjs');

async function run({app, fixture, store, services, js, errors}) {
  const opened = [], copied = [], peerCalls = [];
  let clipboardText='';
  services.shell.openExternal = async url => { opened.push(url); };
  services.clipboard.writeText = value => { clipboardText=value;copied.push(value); };
  services.clipboard.readText = () => clipboardText;
  services.agents.run = async (chatId, peer) => {
    const chat = store.get('chats', chatId);
    peerCalls.push(chat.messages.findLast(message => message.geminiWeb)?.text);
    return store.message(chatId, {kind:'assistant', roleId:peer.id, text:'Fixture peer response', status:'complete'});
  };
  const until = async check => {
    for (let index = 0; index < 100; index++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve,50));
    }
    assert.fail('Timed out waiting for the Gemini Web fixture.');
  };
  for (const url of ['https://gemini.google.com.evil.example/app/abc','https://g.co/gemini/share/abc','https://gemini.google.com/share/abc','http://gemini.google.com/app/abc']) {
    assert.equal(conversationUrl(url),'');
  }
  await js(`showPage('roles');editRole(); $('r-name').value='Browser Fixture'; $('r-persona').value='Fixture role instructions'; $('r-engine').value='gemini-web'; $('r-engine').dispatchEvent(new Event('change'));`);
  assert.equal(await js(`$('r-key').closest('label').hidden && $('role-model-picker').closest('label').hidden && $('r-location').value==='local'`),true);
  await js(`$('role-login').click();`);
  await until(()=>opened.length===1);
  assert.equal(opened[0],'https://gemini.google.com/app');
  await js(`$('role-form').requestSubmit();`);
  await until(()=>store.state.roles.some(role=>role.engine==='gemini-web'));
  const role = store.state.roles.find(role=>role.engine==='gemini-web');
  const roles = [role.id,fixture.roles[0].id];
  const chat = store.createChat({projectId:fixture.project.id,roleIds:roles,name:'Browser session fixture'});
  const other = store.createChat({projectId:fixture.project.id,roleIds:[role.id],name:'Separate browser session fixture'});
  const url = 'https://gemini.google.com/u/1/app/fixture-conversation';
  await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(chat.id)};showPage('projects');openChatRole(${JSON.stringify(role.id)});})()`);
  await js(`$('gemini-web-link').value=${JSON.stringify(url+'?source=ignored#fragment')};$('dialog-form').requestSubmit();`);
  await until(()=>chat.geminiWebChats?.[role.id]===url);
  assert.equal(other.geminiWebChats?.[role.id],undefined);
  await js(`api.send({chatId, text:'Fixture first request', roleIds:${JSON.stringify(roles)}, rounds:1})`);
  await until(()=>js(`Boolean(document.querySelector('[data-gemini-reply]'))`));
  assert.deepEqual(peerCalls,[]);
  assert.equal(await js(`$('chat-banner').textContent.includes('待录入回复')&&!$('chat-banner').querySelector('.spinner')`),true);
  assert.equal(await js(`document.querySelector('.message.assistant .message-state').textContent`),'待录入回复');
  assert.match(await js(`$('sidebar-bottom').querySelector('.status-line>span').textContent`),/0 个讨论运行中.*1 个待录入回复/);
  await js(`document.querySelector('[data-gemini-open]').click();`);
  await until(()=>copied.length===1 && opened.length===2);
  assert.equal(opened[1],url);
  assert.match(copied[0],/Fixture role instructions/);
  assert.match(copied[0],/Fixture first request/);
  await js(`document.querySelector('[data-gemini-reply]').click()`);
  await until(()=>js(`$('toast').textContent.includes('剪贴板里还是提示词')`));
  assert.equal(await js(`$('gemini-web-reply').value`),'');
  await js(`$('dialog').close()`);
  clipboardText='Fixture pasted Gemini response';
  await js(`document.querySelector('[data-gemini-reply]').click()`);
  await until(()=>js(`$('gemini-web-reply').value==='Fixture pasted Gemini response'`));
  assert.deepEqual(peerCalls,[]);
  await js(`$('dialog-form').requestSubmit()`);
  await until(()=>chat.lastDiscussion?.state==='limit'&&!services.running.has(chat.id));
  assert.deepEqual(peerCalls,['Fixture pasted Gemini response']);
  await js(`api.send({chatId, text:'Fixture cancelled request', roleIds:[${JSON.stringify(role.id)}]})`);
  await until(()=>chat.messages.some(message=>message.geminiWeb&&message.status==='running'));
  await js(`api.pause(chatId)`);
  await until(()=>chat.lastDiscussion?.state==='paused'&&!services.running.has(chat.id));
  const cancelled = chat.messages.findLast(message=>message.geminiWeb);
  assert.equal(cancelled.status,'cancelled');
  await assert.rejects(js(`api['gemini-web-reply'](chatId,${JSON.stringify(cancelled.id)},'too late')`),/已结束/);
  assert.deepEqual(errors,[]);
  app.exit(0);
}

module.exports = {run};
