const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../workbench/store.cjs');
const { effectiveRole, historyFor } = require('../workbench/conversations.cjs');
const { buildPrompt, parseEvent } = require('../workbench/agents.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-conversations-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const store = new Store(directory, directory), project = store.state.projects[0];
  return { store, project, directory, roles:store.state.roles };
}
test('Model and effort are frozen per chat, persist, and do not mutate role defaults or another chat', t => {
  const { store, project, directory, roles } = fixture(t);
  const role = store.saveRole({ ...roles[0], model:'default-model', effort:'medium' });
  const a = store.createChat({ projectId:project.id, roleIds:[role.id] });
  const b = store.createChat({ projectId:project.id, roleIds:[role.id] });
  store.saveChatRole(a.id, role.id, { model:'chat-a-model', effort:'high' });
  const updated = store.saveRole({ ...role, model:'new-default', effort:'low' });
  assert.equal(effectiveRole(a, updated).model, 'chat-a-model');
  assert.equal(effectiveRole(b, updated).model, 'default-model');
  assert.equal(updated.model, 'new-default');
  const c = store.createChat({ projectId:project.id, roleIds:[role.id] });
  assert.equal(effectiveRole(c, updated).model, 'new-default');
  const reopened = new Store(directory,directory);
  assert.deepEqual(reopened.get('chats',a.id).roleSettings[role.id], { model:'chat-a-model', effort:'high' });
  assert.throws(() => store.saveChatRole(a.id, roles[1].id, { model:'other', effort:'' }), /participant/);
});

test('Blank chat selections inherit role defaults while explicit selections remain independent', t=>{
  const {store,project,roles,directory}=fixture(t);
  const chat=store.createChat({projectId:project.id,roleIds:[roles[0].id]});
  store.saveChatRole(chat.id,roles[0].id,{model:'',effort:''});
  const role=store.saveRole({...roles[0],model:'role-default-model',effort:'high'});
  assert.equal(effectiveRole(chat,role).model,'role-default-model');assert.equal(effectiveRole(chat,role).effort,'high');
  const reopened=new Store(directory,directory);assert.equal(effectiveRole(reopened.get('chats',chat.id),role).model,'role-default-model');
  store.saveChatRole(chat.id,role.id,{model:'explicit-model',effort:''});
  assert.equal(effectiveRole(chat,role).model,'explicit-model');assert.equal(effectiveRole(chat,role).effort,'high');
  const updated=store.saveRole({...role,model:'updated-role-default',effort:'low'});
  assert.equal(effectiveRole(chat,updated).model,'explicit-model');assert.equal(effectiveRole(chat,updated).effort,'low');
});

test('Whitespace defaults resolve consistently and chat settings cannot override account or permissions',()=>{
  const role={id:'fixture',model:'role-model',effort:'high',codexLoginSource:'desktop',permission:'read-only'};
  const selected=effectiveRole({roleSettings:{fixture:{model:'  ',effort:' ',codexLoginSource:'isolated',permission:'danger-full-access'}}},role);
  assert.equal(selected.model,'role-model');assert.equal(selected.effort,'high');assert.equal(selected.permission,'read-only');assert.equal(selected.codexLoginSource,'desktop');
});
test('Legacy chats and newly invited participants gain independent defaults without resetting saved selections', t => {
  const { store, project, directory, roles } = fixture(t);
  const chat = store.createChat({ projectId:project.id, roleIds:[roles[0].id] });
  delete chat.roleSettings; delete chat.relayReplies; store.save();
  const loaded = new Store(directory,directory), old = loaded.get('chats',chat.id);
  assert.equal(old.relayReplies,true); assert.equal(old.roleSettings[roles[0].id].effort,roles[0].effort);
  loaded.saveChatRole(chat.id,roles[0].id,{model:'retained',effort:'high'});
  loaded.saveChat({id:chat.id,roleIds:roles.slice(0,2).map(r=>r.id)});
  assert.equal(old.roleSettings[roles[0].id].model,'retained');
  assert.equal(old.roleSettings[roles[1].id].model,roles[1].model);
});
test('Independent mode omits peer replies, relay mode includes them, and explicit summary includes every speaker', t => {
  const { store, project, roles } = fixture(t);
  const chat = store.createChat({projectId:project.id,roleIds:roles.slice(0,2).map(r=>r.id)});
  for (const message of [
    {kind:'user',text:'User task',status:'accepted'},
    {kind:'assistant',roleId:roles[0].id,text:'Own history',status:'complete'},
    {kind:'assistant',roleId:roles[1].id,text:'Peer history',status:'complete'},
    {kind:'assistant',roleId:roles[0].id,text:'Incomplete live output',status:'running'},
  ]) store.message(chat.id,message);
  store.saveChatFlow(chat.id,false);
  assert.deepEqual(historyFor(chat,roles[0]).map(m=>m.text),['User task','Own history']);
  assert(!buildPrompt(roles[0],project,chat).includes('Peer history'));
  assert(buildPrompt(roles[0],project,chat,true).includes('Peer history'));
  store.saveChatFlow(chat.id,true);
  assert(historyFor(chat,roles[0]).some(m=>m.text==='Peer history'));
  assert(!historyFor(chat,roles[0]).some(m=>m.status==='running'));
});
test('Roster order can change without losing models or history; invalid reorders are atomic', t => {
  const { store, project, roles } = fixture(t);
  const ids = roles.map(r=>r.id), chat = store.createChat({projectId:project.id,roleIds:ids});
  store.message(chat.id,{kind:'user',text:'Retained task',status:'accepted'});
  const settings = structuredClone(chat.roleSettings);
  store.saveChatOrder(chat.id,[...ids].reverse());
  assert.deepEqual(chat.roleIds,[...ids].reverse()); assert.deepEqual(chat.roleSettings,settings);
  assert.throws(()=>store.saveChatOrder(chat.id,[ids[0],ids[0],ids[2]]),/Reorder/);
  assert.deepEqual(chat.roleIds,[...ids].reverse()); assert.equal(chat.messages[0].text,'Retained task');
});
test('Recoverable errors do not override a completed Codex turn; terminal failures remain failures', () => {
  const state = {text:''}; const emit = ()=>{};
  for (let i=0;i<5;i++) parseEvent('codex',{type:'error',message:'WebSocket retry '+i},state,emit);
  assert(!state.error); assert(!state.completed);
  parseEvent('codex',{type:'item.completed',item:{type:'agent_message',text:'Recovered answer'}},state,emit);
  parseEvent('codex',{type:'turn.completed'},state,emit);
  assert(state.completed); assert.equal(state.error,''); assert.equal(state.text,'Recovered answer');
  assert(state.terminal.includes('WebSocket retry 4'));
  parseEvent('codex',{type:'turn.failed',error:{message:'HTTP transport failed'}},state,emit);
  assert.equal(state.completed,false); assert.equal(state.error,'HTTP transport failed');
});
