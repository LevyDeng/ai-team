const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {historyFor}=require('./conversations.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,services,js,errors}){
  const project=store.state.projects[0],roles=store.state.roles.slice(0,2);
  const chat=store.createChat({projectId:project.id,name:'Input Queue Fixture',roleIds:roles.map(role=>role.id),defaultReplyRoleIds:roles.map(role=>role.id),autoStop:false});
  chat.autoStop=false;store.save();
  const calls=[],active=[];let delayedStops=0;
  services.agents.run=(chatId,role,_project,signal)=>new Promise(resolve=>{
    assert.equal(chatId,chat.id);
    const history=historyFor(chat,role),request=history.findLast(message=>message.kind==='user');
    const message=store.message(chat.id,{kind:'assistant',roleId:role.id,roleName:role.name,text:'Fixture partial reply for '+request.text,status:'running'});
    services.agents.emit({chatId,message});
    const call={roleId:role.id,text:request.text,history:history.map(message=>message.text),model:role.model,attachments:request.attachments};calls.push(call);
    let ended=false;const finish=status=>{if(ended)return;ended=true;message.status=status;services.agents.emit({chatId,message});resolve(message);};
    signal.addEventListener('abort',()=>{delayedStops++;setTimeout(()=>finish('cancelled'),120);},{once:true});
    active.push({call,finish});
  });
  const until=async predicate=>{for(let i=0;i<120;i++){if(await predicate())return;await wait(50);}throw new Error('Input queue GUI fixture timed out. Calls: '+calls.map(call=>call.text+':'+call.roleId).join(', '));};
  const enter=async text=>js(`$('input').value=${JSON.stringify(text)};$('input').dispatchEvent(new Event('input'));$('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`);
  const complete=()=>{const current=active.shift();assert(current);current.finish('complete');};
  await js(`(async()=>{state=await api.snapshot();projectId=${JSON.stringify(project.id)};chatId=${JSON.stringify(chat.id)};activateChat();})()`);
  await enter('QUEUE_FIRST');await until(()=>calls.length===1);
  assert.equal(await js('$('+'"send"'+').hidden'),false);
  await enter('QUEUE_SECOND');await until(()=>chat.inputQueue?.length===1);
  await enter('QUEUE_THIRD');await until(()=>chat.inputQueue?.length===2);
  assert.equal(await js('$('+'"input"'+').value'),'');assert.equal(calls.length,1);
  assert(!historyFor(chat,roles[0]).some(message=>/QUEUE_SECOND|QUEUE_THIRD/.test(message.text)));
  assert.equal(await js('document.querySelectorAll(".queued-input").length'),2);
  fs.writeFileSync(path.join(directory,'input-queue.png'),(await window.webContents.capturePage()).toPNG());
  // The next queued message must wait for every participant, not just one reply.
  complete();await until(()=>calls.length===2);assert.equal(calls[1].text,'QUEUE_FIRST');assert.equal(chat.inputQueue.length,2);
  complete();await until(()=>calls.length===3);assert.equal(calls[2].text,'QUEUE_SECOND');assert(!calls[2].history.includes('QUEUE_THIRD'));
  // The active participant is cancelled, then the priority message runs once.
  await js(`$('input').value='QUEUE_URGENT';$('input').dispatchEvent(new Event('input'));$('interrupt-send').click();`);
  await until(()=>delayedStops===1);assert.equal(calls.length,3);
  await until(()=>calls.length===4);assert.equal(calls[3].text,'QUEUE_URGENT');assert.equal(calls.filter(call=>call.text==='QUEUE_SECOND').length,1);
  active.shift(); // The delayed cancellation already resolved this entry.
  complete();await until(()=>calls.length===5);assert.equal(calls[4].text,'QUEUE_URGENT');
  complete();await until(()=>calls.length===6);assert.equal(calls[5].text,'QUEUE_THIRD');
  // Failure pauses the remaining queue, keeping attachments and typed text.
  const attachment=path.join(directory,'queued-notes.txt');fs.writeFileSync(attachment,'Fixture attachment');
  await js(`api['attachment-stage'](${JSON.stringify(chat.id)},[${JSON.stringify(attachment)}])`);
  await enter('QUEUE_WITH_ATTACHMENT');await until(()=>chat.inputQueue?.length===1);
  const failed=active.shift();failed.finish('failed');await until(()=>chat.queuePaused===true);
  assert.equal(calls.length,6);assert.equal(chat.inputQueue[0].value.files[0].path,attachment);
  assert.equal(await js('$('+'"queue-resume"'+').hidden'),false);
  await js('$('+'"queue-resume"'+').click()');await until(()=>calls.length===7);assert.equal(calls[6].text,'QUEUE_WITH_ATTACHMENT');assert.equal(calls[6].attachments[0].path,attachment);
  complete();await until(()=>calls.length===8);complete();await until(()=>!services.running.has(chat.id)&&!chat.inputQueue.length);
  // Editing removes one pending entry without overwriting an unrelated draft.
  services.running.set(chat.id,{controller:new AbortController(),roleIds:[roles[0].id],roleId:roles[0].id,round:1,rounds:1});
  await enter('QUEUE_EDIT_ME');await until(()=>chat.inputQueue.length===1);
  await js(`$('input').value='Keep my draft';$('input').dispatchEvent(new Event('input'));`);
  await js('Array.from(document.querySelectorAll(".queued-input button")).find(button=>button.textContent==="编辑").click()');await wait(100);
  assert.equal(chat.inputQueue.length,1);assert.equal(await js('$('+'"input"'+').value'),'Keep my draft');
  await js(`$('input').value='';$('input').dispatchEvent(new Event('input'));Array.from(document.querySelectorAll('.queued-input button')).find(button=>button.textContent==='编辑').click();`);
  await until(()=>!chat.inputQueue.length);assert.equal(await js('$('+'"input"'+').value'),'QUEUE_EDIT_ME');services.running.delete(chat.id);
  assert(chat.messages.some(message=>message.status==='cancelled'&&message.text.includes('QUEUE_SECOND')));
  let forceTarget;
  services.agents.forceStop=id=>{forceTarget=id;};
  await enter('FORCE_ACTIVE');await until(()=>calls.length===9);
  await enter('FORCE_PENDING');await until(()=>chat.inputQueue.length===1);
  assert.equal(await js('$("end-task").textContent'),'结束任务');
  assert.equal(await js('$("force-stop").parentElement.id'),'chat-banner');
  assert.equal(await js('getComputedStyle($("force-stop")).backgroundColor'),'rgb(184, 50, 50)');
  await js('window.confirm=()=>false;$("force-stop").click();');
  assert.equal(forceTarget,undefined);
  await js('window.confirm=()=>true;$("force-stop").click();');
  await until(()=>!services.running.has(chat.id));
  assert.equal(forceTarget,chat.id);
  assert.equal(chat.inputQueue[0].value.text,'FORCE_PENDING');
  assert.equal(chat.queuePaused,true);
  assert.equal(calls.length,9);
  await until(()=>js('!$("force-stop") && $("end-task").hidden'));
  forceTarget=undefined;
  await js('$("queue-resume").click()');
  await until(()=>calls.length===10);
  await js('$("end-task").click()');
  await until(()=>!services.running.has(chat.id));
  assert.equal(forceTarget,undefined);
  assert.equal(calls.length,10);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'input-queue-checks.json'),JSON.stringify({passed:true,checks:['Enter enqueues while running','full group completes before dequeue','pending inputs excluded from native context','interrupt waits for cancellation','no automatic replay of interrupted task','remaining queue retained','failed tasks pause pending inputs','attachments delivered with their own message','explicit continuation','editing preserves unrelated draft','no real model requests'],consoleErrors:errors},null,2));
  app.exit(0);
}
module.exports={run};
