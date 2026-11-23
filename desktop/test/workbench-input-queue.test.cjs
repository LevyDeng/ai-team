const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {InputQueue,maxEntries}=require('../workbench/input-queue.cjs');
const {Store}=require('../workbench/store.cjs');
const {Attachments}=require('../workbench/attachments.cjs');
const {historyFor}=require('../workbench/conversations.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-input-queue-'));
  const store=new Store(directory,directory),project=store.state.projects[0],role=store.state.roles[0];
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]}),other=store.createChat({projectId:project.id,roleIds:[role.id]}),attachments=new Attachments(store);
  const busy=new Set(),calls=[],interruptions=[];
  const queue=new InputQueue({store,busy:id=>busy.has(id),start:async(value,entryId)=>{
    attachments.validate(value.files);busy.add(value.chatId);calls.push(structuredClone(value));
    store.message(value.chatId,{kind:'user',text:value.text,status:'accepted',inputQueueId:entryId,attachments:value.files});return {accepted:true};
  },interrupt:id=>interruptions.push(id),accept:(chat,value)=>{if(chat.draft===value.text)chat.draft='';attachments.consume(chat.id,value.files);}});
  t.after(()=>{try{queue.close();}finally{fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});}});
  const value=(text,id=chat.id)=>({chatId:id,text,roleIds:[role.id],files:[],rounds:1,autoStop:true,roleSettings:{[role.id]:{model:'fixture-model',effort:'medium'}}});
  const finish=(state='answered',id=chat.id)=>{busy.delete(id);queue.settled(id,state);};
  return {directory,store,project,role,chat,other,attachments,busy,calls,interruptions,queue,value,finish};
}
test('Queued messages remain outside model history and dispatch once in FIFO order per chat',async t=>{
  const f=fixture(t);f.busy.add(f.chat.id);f.chat.draft='Second';f.queue.submit(f.chat.id,f.value('Second'));f.queue.submit(f.chat.id,f.value('Third'));
  assert.equal(f.chat.draft,'');assert.deepEqual(historyFor(f.chat,f.role),[]);await tick();assert.equal(f.calls.length,0);
  f.finish();await tick();assert.deepEqual(f.calls.map(c=>c.text),['Second']);assert.equal(f.chat.inputQueue.length,1);
  f.queue.kick(f.chat.id);await tick();assert.equal(f.calls.length,1);
  f.finish();await tick();assert.deepEqual(f.calls.map(c=>c.text),['Second','Third']);assert.equal(f.chat.inputQueue.length,0);
});
test('Interrupt waits for confirmed task shutdown, prioritizes a message and preserves other pending tasks',async t=>{
  const f=fixture(t);f.busy.add(f.chat.id);f.queue.submit(f.chat.id,f.value('Later'));
  f.queue.submit(f.chat.id,f.value('Urgent'),'interrupt');await tick();assert.equal(f.calls.length,0);assert.deepEqual(f.interruptions,[f.chat.id]);
  f.finish('paused');await tick();assert.deepEqual(f.calls.map(c=>c.text),['Urgent']);assert.equal(f.chat.inputQueue[0].value.text,'Later');
  f.finish();await tick();assert.deepEqual(f.calls.map(c=>c.text),['Urgent','Later']);
});
test('Failures, user decisions and unconfirmed completion pause without discarding or replaying messages',async t=>{
  const f=fixture(t);for(const outcome of ['failed','needs_user','unconfirmed','moderator_failed','paused']){
    f.busy.add(f.chat.id);f.queue.submit(f.chat.id,f.value(outcome));f.finish(outcome);await tick();
    assert.equal(f.chat.queuePaused,true);assert.equal(f.calls.length,0);assert.equal(f.chat.inputQueue[0].value.text,outcome);
    f.queue.remove(f.chat.id,f.chat.inputQueue[0].id);
  }
  f.queue.submit(f.chat.id,f.value('New explicit request'));await tick();assert.equal(f.calls.length,1);
});
test('Manual pause wins over an interrupt and resumes only after explicit consent',async t=>{
  const f=fixture(t);f.busy.add(f.chat.id);f.queue.submit(f.chat.id,f.value('Urgent'),'interrupt');f.queue.pause(f.chat.id);f.finish('paused');await tick();
  assert.equal(f.calls.length,0);assert.equal(f.chat.inputQueue.length,1);f.queue.resume(f.chat.id);await tick();assert.equal(f.calls.length,1);
});
test('An unconfirmed remote shutdown never advances a priority queue automatically',async t=>{
  const f=fixture(t);f.busy.add(f.chat.id);f.queue.submit(f.chat.id,f.value('Priority after SSH interruption'),'interrupt');f.finish('stop_unconfirmed');await tick();
  assert.equal(f.calls.length,0);assert.equal(f.chat.queuePaused,true);assert.equal(f.chat.queueReason,'stop_unconfirmed');assert.equal(f.chat.inputQueue.length,1);
});
test('Repeated priority requests keep the original stop request active', async t => {
  const f=fixture(t);
  f.busy.add(f.chat.id);
  f.queue.submit(f.chat.id,f.value('First priority'),'interrupt');
  const timer=f.queue.interrupting.get(f.chat.id);
  f.queue.submit(f.chat.id,f.value('Latest priority'),'interrupt');
  assert.equal(f.queue.interrupting.get(f.chat.id),timer);
  assert.deepEqual(f.interruptions,[f.chat.id]);
  f.finish('paused');
  await tick();
  assert.deepEqual(f.calls.map(call=>call.text),['Latest priority']);
});
test('Independent chat queues, role order, model and effort snapshots survive later settings changes',async t=>{
  const f=fixture(t);f.busy.add(f.chat.id);const value=f.value('First queue');value.roleIds=['second',f.role.id];f.queue.submit(f.chat.id,value);value.roleIds.reverse();value.roleSettings[f.role.id].model='changed';
  f.queue.submit(f.other.id,f.value('Other chat',f.other.id));await tick();assert.equal(f.calls[0].chatId,f.other.id);
  f.finish();await tick();assert.deepEqual(f.calls[1].roleIds,['second',f.role.id]);assert.equal(f.calls[1].roleSettings[f.role.id].model,'fixture-model');assert.equal(f.calls[1].roleSettings[f.role.id].effort,'medium');
});
test('Restart pauses pending work and removes a dispatch that already has a user history entry',async t=>{
  const f=fixture(t);f.busy.add(f.chat.id);const first=f.queue.submit(f.chat.id,f.value('Accepted just before crash'));f.queue.submit(f.chat.id,f.value('Still waiting'));
  f.chat.inputQueue[0].state='dispatching';f.store.message(f.chat.id,{kind:'user',status:'accepted',text:'Accepted just before crash',inputQueueId:first.queueId});f.store.save();
  const loaded=new Store(f.directory,f.directory),chat=loaded.get('chats',f.chat.id);assert.equal(chat.inputQueue.length,1);assert.equal(chat.inputQueue[0].value.text,'Still waiting');assert.equal(chat.queuePaused,true);assert.equal(chat.queueReason,'restart');
  let starts=0;const next=new InputQueue({store:loaded,busy:()=>false,start:()=>{starts++;},interrupt:()=>{}});next.kick(chat.id);await tick();assert.equal(starts,0);next.close();
});
test('Unavailable queued files pause safely; drafts, attachments and clipboard cache remain recoverable',async t=>{
  const f=fixture(t),filename=path.join(f.directory,'queued.png');fs.writeFileSync(filename,'Fixture image metadata');
  const files=f.attachments.add(f.chat.id,[filename],{path:filename,width:1,height:1,format:'png'});f.busy.add(f.chat.id);
  f.queue.submit(f.chat.id,{...f.value('Image question'),files});assert.equal(f.attachments.files(f.chat.id).length,0);assert(f.attachments.protectedPaths().has(filename));
  fs.unlinkSync(filename);f.chat.draft='New draft';f.finish();await tick();assert.equal(f.chat.queuePaused,true);assert.equal(f.chat.inputQueue.length,1);assert.equal(f.chat.draft,'New draft');assert.equal(f.calls.length,0);
});
test('Reordering, removal, prioritizing an existing item and capacity failures preserve draft contents',async t=>{
  const f=fixture(t);f.busy.add(f.chat.id);const a=f.queue.submit(f.chat.id,f.value('A')),b=f.queue.submit(f.chat.id,f.value('B'));
  f.queue.move(f.chat.id,b.queueId,-1);assert.deepEqual(f.chat.inputQueue.map(e=>e.value.text),['B','A']);f.queue.remove(f.chat.id,b.queueId);
  for(let i=1;i<maxEntries;i++)f.queue.submit(f.chat.id,f.value('Pending '+i));f.chat.draft='Keep on queue overflow';assert.throws(()=>f.queue.submit(f.chat.id,f.value(f.chat.draft)),/full/);assert.equal(f.chat.draft,'Keep on queue overflow');
  f.queue.now(f.chat.id,a.queueId);f.finish('paused');await tick();assert.equal(f.calls[0].text,'A');assert.equal(f.chat.inputQueue.length,maxEntries-1);
});
test('Submission failures after a native write never cause duplicate automatic delivery',async t=>{
  const f=fixture(t);f.queue.start=async(value,entryId)=>{f.store.message(f.chat.id,{kind:'user',text:value.text,status:'unconfirmed',inputQueueId:entryId});throw new Error('Uncertain terminal write');};
  f.queue.submit(f.chat.id,f.value('Write once'));await tick();assert.equal(f.chat.inputQueue.length,0);assert.equal(f.chat.queuePaused,true);assert.equal(f.chat.messages.filter(m=>m.text==='Write once').length,1);f.queue.resume(f.chat.id);await tick();assert.equal(f.chat.messages.length,1);
});
test('A pending native submission is serialized and cannot be moved, removed or interrupted',async t=>{
  const f=fixture(t);let release;f.queue.start=()=>new Promise(resolve=>{release=resolve;});const first=f.queue.submit(f.chat.id,f.value('Submitting'));await tick();
  assert.throws(()=>f.queue.remove(f.chat.id,first.queueId),/submit/);assert.throws(()=>f.queue.now(f.chat.id,first.queueId),/submit/);assert.throws(()=>f.queue.submit(f.chat.id,f.value('Do not lose'),'interrupt'),/submit/);
  f.queue.submit(f.chat.id,f.value('Wait next'));f.busy.add(f.chat.id);release({accepted:true});await tick();assert.equal(f.chat.inputQueue.length,1);assert.equal(f.chat.inputQueue[0].value.text,'Wait next');
});
test('Closing prevents new tasks and preserves the pending queue for manual continuation',async t=>{
  const f=fixture(t);f.busy.add(f.chat.id);f.queue.submit(f.chat.id,f.value('After restart'));f.queue.close();f.finish();await tick();assert.equal(f.calls.length,0);assert.equal(f.chat.inputQueue.length,1);assert.equal(f.chat.queuePaused,true);assert.throws(()=>f.queue.resume(f.chat.id),/closing/);
});
