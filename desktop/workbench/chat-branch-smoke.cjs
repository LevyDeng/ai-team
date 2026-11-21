const assert = require('node:assert/strict');
const {plan, commit} = require('./moderator.cjs');
const {historyFor} = require('./conversations.cjs');
const {resolve} = require('./mentions.js');

async function run({app, store, fixture, services, js}) {
  const [first, second] = fixture.roles;
  const source=fixture.chat;
  await js(`document.querySelector('[data-page="skills"]').click()`);
  assert.equal(await js(`[...document.querySelectorAll('[data-skill]')].some(row=>row.textContent.includes('/handoff'))`),true);
  await js(`document.querySelector('[data-page="projects"]').click();chatId=${JSON.stringify(source.id)};activateChat();const handoffInput=$('input');handoffInput.focus();handoffInput.value='/han';handoffInput.setSelectionRange(4,4);handoffInput.dispatchEvent(new Event('input'))`);
  assert.equal(await js(`!$('skill-menu').hidden&&$('skill-menu').querySelector('[role="option"]').textContent.includes('/handoff')`),true);
  await js(`$('input').value='';$('input').dispatchEvent(new Event('input'));saveDraftNow()`);

  source.moderatorRoleId=first.id;
  source.moderatorCompression=true;
  for(let i=0;i<14;i++)store.message(source.id,{kind:'user',status:'accepted',text:`Old fixture ${i}: `+'historical detail '.repeat(250)});
  store.message(source.id,{kind:'assistant',roleId:second.id,status:'complete',text:'Most recent fixture reply'});
  const task=plan('compact',first,source);
  assert(task);
  commit(source,task,{summary:'Verified fixture summary'},first.id);
  source.nativeSessions={[first.id]:{id:'source-owned-session'}};store.save();
  const target=store.createChat({projectId:source.projectId,name:'Target conversation',roleIds:[second.id,first.id]});
  const calls=[];services.agents.run=async(_chatId,role)=>{calls.push(role.id);return {status:'complete'};};
  const until=async check=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,40));}assert.fail('Chat branch fixture timed out.');};

  await js(`(async()=>{state=await api.snapshot();chatId=${JSON.stringify(source.id)};activateChat();openChat(chat());$('chat-branch').click();})()`);
  await js(`$('branch-name').value='Fixture branch';$('dialog-form').requestSubmit()`);
  await until(()=>js(`$('chat-title').textContent==='Fixture branch'`));
  const branch=store.state.chats.find(chat=>chat.sourceChatId===source.id);
  assert(branch);assert.equal(branch.messages.length,1);assert.equal(branch.nativeSessions,undefined);
  assert.match(branch.messages[0].text,/Verified fixture summary/);
  assert.match(branch.messages[0].text,/Most recent fixture reply/);
  assert.doesNotMatch(branch.messages[0].text,/Old fixture 0:/);
  assert.equal(historyFor({...branch,relayReplies:false},second)[0].branchContext,true);
  assert.equal(await js(`document.querySelector('.message-meta b').textContent`),'分支上下文');

  await js(`openChat(chat());$('chat-handoff').click();$('handoff-chat').value=${JSON.stringify(target.id)};$('handoff-chat').dispatchEvent(new Event('change'));document.querySelectorAll('#handoff-roles input').forEach(input=>input.checked=true);$('handoff-prompt').value='Review the animation handoff';$('dialog-form').requestSubmit()`);
  await until(()=>js(`$('chat-title').textContent==='Target conversation'`));
  assert.match(target.draft,/Review the animation handoff/);
  assert.deepEqual(resolve(target.draft,[second,first]).roleIds,[second.id,first.id]);
  assert.equal(target.messages.length,0);assert.equal(calls.length,0);
  await assert.rejects(js(`api['chat-handoff'](${JSON.stringify(source.id)},${JSON.stringify(target.id)},[${JSON.stringify(first.id)}],'Do not overwrite')`),/已有草稿/);
  assert.doesNotMatch(target.draft,/Do not overwrite/);

  await js(`(async()=>{$('input').value='';saveDraftNow();await api.draft(chatId,'');chatId=${JSON.stringify(source.id)};activateChat();})()`);
  const prompt='Verify the refined animation against the approved reference.';
  const proposal=await services.skills.call(services.skills.scope(source.id,first.id,'fixture-handoff'),'skill_handoff_prepare',{
    targetChatId:target.id,recipientIds:[second.id],prompt,requestId:'review-animation'
  });
  const cardId=JSON.stringify('msg-'+proposal.messageId);
  await until(()=>js(`Boolean(document.getElementById(${cardId}))`));
  assert.equal(target.draft,'');
  await js(`[...document.getElementById(${cardId}).querySelectorAll('button')].find(button=>button.textContent==='Review handoff').click()`);
  assert.equal(await js(`$('handoff-chat').value`),target.id);
  assert.equal(await js(`$('handoff-prompt').value`),prompt);
  assert.deepEqual(await js(`[...document.querySelectorAll('#handoff-roles input:checked')].map(input=>input.value)`),[second.id]);
  assert.equal(await js(`$('handoff-speaking-order').hidden`),true);
  await js(`[...document.querySelectorAll('#handoff-roles input')].find(input=>input.value===${JSON.stringify(first.id)}).click()`);
  assert.equal(await js(`$('handoff-speaking-order').hidden`),false);
  await js(`$('handoff-speaking-list').querySelector('[data-order-move="-1"][data-order-index="1"]').click()`);
  await js(`$('dialog-form').requestSubmit()`);
  await until(()=>js(`$('chat-title').textContent==='Target conversation'`));
  assert.deepEqual(resolve(target.draft,[second,first]).roleIds,[first.id,second.id]);
  assert.match(target.draft,/Verify the refined animation/);
  assert.equal(target.messages.length,0);assert.equal(calls.length,0);
  await js(`send()`);
  await until(()=>calls.length===2&&Boolean(target.lastDiscussion));
  assert.deepEqual(calls,[first.id,second.id]);
  assert.deepEqual(target.roleIds,[second.id,first.id]);
  app.exit(0);
}

module.exports={run};
