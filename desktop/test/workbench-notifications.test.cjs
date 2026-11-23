const test = require('node:test');
const assert = require('node:assert/strict');
const {CompletionNotifications} = require('../workbench/notifications.cjs');

function fixture() {
  const chats = [{id:'active',unread:false},{id:'other',unread:false}];
  const busy = new Set(), counts = [], effects = [];
  const notifications = new CompletionNotifications({
    store:{state:{chats},get:(_kind,id)=>chats.find(chat=>chat.id===id),scheduleSave:()=>effects.push('save'),save:()=>effects.push('save')},
    busy:id=>busy.has(id),render:count=>counts.push(count),
    changed:()=>effects.push('state'),attention:()=>effects.push('attention')
  });
  return {chats,busy,counts,effects,notifications};
}

test('A child completion cannot notify while its discussion or moderator is still running', () => {
  const f = fixture();f.busy.add('active');
  assert.equal(f.notifications.complete('active'),false);
  assert.equal(f.chats[0].unread,false);assert.deepEqual(f.effects,[]);
  f.busy.delete('active');assert.equal(f.notifications.complete('active'),true);
  assert.equal(f.chats[0].unread,true);assert.deepEqual(f.counts,[1]);
  assert.deepEqual(f.effects,['save','state','attention']);
});

test('Old unread state is retained but excluded from the taskbar during a new task', () => {
  const f = fixture();f.chats[0].unread=true;f.notifications.refresh();
  f.busy.add('active');assert.equal(f.notifications.refresh(),0);
  assert.equal(f.chats[0].unread,true);assert.deepEqual(f.effects,[]);
  f.busy.delete('active');f.notifications.complete('active');
  f.notifications.read('active');assert.deepEqual(f.counts,[1,0,1,0]);
  assert.equal(f.chats[0].unread,false);
});

test('An independent completed chat still notifies while another chat is running', () => {
  const f = fixture();f.chats[0].unread=true;f.busy.add('active');
  f.notifications.complete('other');assert.equal(f.counts.at(-1),1);
  assert.equal(f.chats[1].unread,true);assert.equal(f.effects.filter(e=>e==='attention').length,1);
});

test('Workflow notifications come from the workflow runner after completion or a stop that needs attention', () => {
  const {chats,busy,counts,effects,notifications} = fixture();
  const chat=chats[0];
  chat.workflow={status:'queued'};
  chat.unread=true;
  assert.equal(notifications.refresh(),0);
  assert.equal(chat.unread,true);

  chat.unread=false;
  for (const status of ['queued','running','paused']) {
    chat.workflow.status=status;
    assert.equal(notifications.complete(chat.id,{workflow:true}),false);
  }
  for (const status of ['complete','needs_check','unavailable','round_limit','unresolved']) {
    chat.workflow.status=status;
    assert.equal(notifications.complete(chat.id),false);
    busy.add(chat.id);
    assert.equal(notifications.complete(chat.id,{workflow:true}),false);
    busy.delete(chat.id);
    assert.equal(notifications.complete(chat.id,{workflow:true}),true);
    notifications.read(chat.id);
  }
  assert.deepEqual(counts,[0,1,0,1,0,1,0,1,0,1,0]);
  assert.equal(effects.filter(effect=>effect==='attention').length,5);
});
