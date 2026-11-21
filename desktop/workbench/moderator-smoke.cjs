const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {historyFor}=require('./conversations.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,services,js,errors}){
  const project=store.state.projects[0],ids=store.state.roles.slice(0,3).map(r=>r.id),chat=store.createChat({projectId:project.id,name:'Moderator GUI Fixture',roleIds:ids}),calls=[];let reviewCount=0,invalid=false,invalidCompact=false,rawExpected=false;
  for(let i=0;i<20;i++)store.message(chat.id,{kind:i%2?'assistant':'user',roleId:ids[i%ids.length],roleName:'Fixture peer',text:'Historical detail '+i+' '+('context fixture ').repeat(220),status:'complete'});
  const originalIds=chat.messages.map(m=>m.id);
  services.agents.run=async(chatId,role,_project,signal,_summary,context)=>{
    assert.equal(chatId,chat.id);assert(!signal.aborted);const task=context.moderatorTask;calls.push(task?.kind||role.id);
    let text;if(task){if(task.history){let offset=0;for(;;){const page=task.history.read({offset});if(page.eof)break;offset=page.nextOffset;}}
      if(task.kind==='review')reviewCount++;
      text=invalid&&task.kind==='review'||invalidCompact&&task.kind==='compact'?'Invalid fixture response':'Reading the history pages before returning the final JSON.\n\n'+JSON.stringify({kind:task.kind,token:task.token,sourceHash:task.sourceHash,...(task.kind==='compact'?{summary:'Fixture summary preserves the goals, paths, constraints and pending work.'}:{decision:reviewCount%2===0?'complete':'continue',reason:reviewCount%2===0?'Fixture review: the discussion is sufficient.':'Fixture review: one material issue needs another round.'})});
    }else{const history=historyFor({...chat,...context},role);if(rawExpected)assert(!history[0].moderatorMemory);else assert(history[0].moderatorMemory);if(invalidCompact)assert.equal(context.ignoreModeratorMemory,true);assert(history.some(m=>m.kind==='user'&&m.text.startsWith('MODERATOR_GUI_')));text='Fixture participant contribution from '+role.name;}
    const message=store.message(chat.id,{kind:'assistant',roleId:role.id,roleName:role.name,locationId:role.locationId,text,status:'complete',...(task?{moderatorTask:task.kind}:{})});services.agents.emit({chatId,message});await wait(30);return message;
  };
  const until=async predicate=>{for(let i=0;i<80;i++){if(await predicate())return;await wait(100);}throw new Error('Moderator GUI fixture timed out.');};
  await js(`(async()=>{state=await api.snapshot();projectId=${JSON.stringify(project.id)};chatId=${JSON.stringify(chat.id)};activateChat();document.querySelector('#chat-settings').click();})()`);
  assert.equal(await js('document.querySelector("#chat-moderator-settings").hidden'),false);
  assert.equal(await js('document.querySelectorAll("#c-moderator option").length'),4);
  await js(`document.querySelector('#c-moderator').value=${JSON.stringify(ids[0])};document.querySelector('#c-moderator').dispatchEvent(new Event('change'));document.querySelector('#dialog-form').requestSubmit();`);await until(()=>chat.moderatorRoleId===ids[0]);
  await js('document.querySelector("#chat-settings").click();document.querySelector("#chat-moderator-settings").scrollIntoView({block:"center"});');await wait(100);
  assert.equal(await js('document.querySelector("#c-moderator").value'),ids[0]);fs.writeFileSync(path.join(directory,'moderator-settings.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("#dialog-close").click()');await wait(50);
  assert((await js('document.querySelector("#speaking-order").textContent')).includes('主持人：'));
  await js(`api.send({chatId:${JSON.stringify(chat.id)},text:'MODERATOR_GUI_LATEST: discuss the fixture and stop when sufficient.',roleId:'all',rounds:4,autoStop:true})`);
  await until(()=>!services.running.has(chat.id)&&chat.lastDiscussion?.state==='complete');
  assert.equal(chat.lastDiscussion.rounds,2);assert.deepEqual(calls,['compact',...ids,'review',...ids,'review']);assert(chat.moderatorMemory);assert.deepEqual(chat.messages.slice(0,originalIds.length).map(m=>m.id),originalIds);
  await until(()=>js('document.querySelectorAll(".moderator-message").length===3'));
  await js('document.querySelectorAll(".moderator-message>details").forEach(d=>d.open=true);document.querySelector(".moderator-memory").open=true;document.querySelector("#messages").scrollTop=document.querySelector("#messages").scrollHeight;');await wait(100);
  assert.equal(await js('document.querySelector("#messages").textContent.includes("sourceHash")'),false);
  fs.writeFileSync(path.join(directory,'moderator-discussion.png'),(await window.webContents.capturePage()).toPNG());
  invalid=true;const previous=calls.length;await js(`api.send({chatId:${JSON.stringify(chat.id)},text:'MODERATOR_GUI_INVALID: check invalid moderator handling.',roleId:'all',rounds:5,autoStop:true})`);await until(()=>!services.running.has(chat.id)&&chat.lastDiscussion?.state==='moderator_failed');assert.deepEqual(calls.slice(previous),[...ids,'review']);assert.equal(chat.lastDiscussion.rounds,1);
  assert.equal(chat.messages.at(-1).errorCode,'MODERATOR_INVALID_RESULT');assert(chat.messages.some(m=>m.kind==='user'&&m.text.includes('MODERATOR_GUI_INVALID')));assert.deepEqual(errors,[]);
  invalid=false;rawExpected=true;chat.moderatorCompression=false;store.save();let start=calls.length;
  await js(`api.send({chatId:${JSON.stringify(chat.id)},text:'MODERATOR_GUI_ONE_ROUND: answer only the selected roles.',roleIds:${JSON.stringify(ids.slice(1))},rounds:1,autoStop:true})`);
  await until(()=>!services.running.has(chat.id)&&chat.lastDiscussion?.state==='limit');assert.deepEqual(calls.slice(start),ids.slice(1));
  invalidCompact=true;chat.moderatorCompression=true;delete chat.moderatorMemory;store.save();start=calls.length;
  await js(`api.send({chatId:${JSON.stringify(chat.id)},text:'MODERATOR_GUI_FALLBACK: preserve this latest request and answer despite optional compression failure.',roleIds:${JSON.stringify(ids.slice(1))},rounds:1,autoStop:true})`);
  await until(()=>!services.running.has(chat.id)&&calls.length===start+3&&chat.lastDiscussion?.state==='limit');assert.deepEqual(calls.slice(start),['compact',...ids.slice(1)]);
  const fallback=chat.messages.findLast(message=>message.moderatorFallback);assert(fallback);assert.equal(fallback.moderatorDiagnostic.stage,'compact');assert.equal(chat.moderatorMemory,undefined);
  await until(()=>js(`document.querySelector('#msg-${fallback.id}>details>summary').textContent.includes('已回退原文')`));
  await js(`document.querySelector('#msg-${fallback.id}>details').open=true;document.querySelector('#msg-${fallback.id}').scrollIntoView({block:'center'});`);await wait(100);
  assert((await js(`document.querySelector('#msg-${fallback.id} .moderator-note').textContent`)).includes('48 KiB'));assert.equal(await js(`document.querySelector('#msg-${fallback.id} .moderator-note').textContent.includes('The moderator')`),false);
  fs.writeFileSync(path.join(directory,'moderator-fallback.png'),(await window.webContents.capturePage()).toPNG());assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'moderator-checks.json'),JSON.stringify({passed:true,checks:['moderator settings save and reopen','progress commentary before final JSON accepted','long-history compression with original retention','latest user request retained','participant order preserved','host stops at second round before ceiling','separate coordination cards','invalid host review stops additional rounds','single-round task omits unused moderator','optional compression failure falls back to originals','only selected roles answer after compression failure','specific translated stage and threshold details','submitted text preserved','no real model request'],consoleErrors:errors},null,2));app.exit(0);
}
module.exports={run};
