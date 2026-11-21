const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const moderator=require('../workbench/moderator.cjs'),discussion=require('../workbench/discussion.cjs');
const {historyFor}=require('../workbench/conversations.cjs'),{Store}=require('../workbench/store.cjs'),{Agents,buildPrompt}=require('../workbench/agents.cjs');
const {prepare}=require('../workbench/chat-context.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-moderator-'));t.after(()=>fs.promises.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100}));const store=new Store(directory,directory),project=store.state.projects[0],roles=store.state.roles,chat=store.createChat({projectId:project.id,roleIds:roles.map(r=>r.id),moderatorRoleId:roles[0].id});return {directory,store,project,roles,chat};}
function seed(store,chat){for(let i=0;i<20;i++)store.message(chat.id,{kind:i%2?'assistant':'user',roleId:chat.roleIds[i%chat.roleIds.length],roleName:'Fixture '+i,text:'Historical message '+i+' exact/path-'+i+' '+('context '+i+' ').repeat(330),status:'complete'});store.message(chat.id,{kind:'user',text:'LATEST_USER_REQUEST: preserve this complete instruction.',status:'accepted'});}
function readAll(task){if(!task.history)return;let offset=0;for(;;){const page=task.history.read({offset});if(page.eof)return;offset=page.nextOffset;}}
function answer(task,extra={}){return JSON.stringify({kind:task.kind,token:task.token,sourceHash:task.sourceHash,...(task.kind==='compact'?{summary:'User goals, exact/path-0, decisions and unresolved issues remain in scope.'}:{decision:'complete',reason:'The requested discussion is sufficient.'}),...extra});}
test('Moderator choices are per chat, validated atomically, persisted, and cleared when their participant is removed',t=>{
  const {store,project,roles,chat,directory}=fixture(t);const other=store.createChat({projectId:project.id,roleIds:roles.map(r=>r.id)});assert.equal(other.moderatorRoleId,'');
  assert.throws(()=>store.saveChat({...chat,name:'Must not save',moderatorRoleId:'foreign'}),/moderator/);assert.notEqual(chat.name,'Must not save');
  store.saveChat({...chat,moderatorRoleId:roles[1].id,moderatorCompression:false});const loaded=new Store(directory,directory).get('chats',chat.id);assert.equal(loaded.moderatorRoleId,roles[1].id);assert.equal(loaded.moderatorCompression,false);
  store.saveChat({id:chat.id,roleIds:[roles[0].id,roles[2].id]});assert.equal(chat.moderatorRoleId,'');
  assert.throws(()=>store.createChat({projectId:project.id,roleIds:[roles[0].id],moderatorRoleId:roles[0].id}),/moderator/);
});
test('Compression retains originals, the latest complete user request and recent messages; stale memory falls back to originals',t=>{
  const {store,chat,roles,project}=fixture(t);seed(store,chat);const original=JSON.stringify(chat.messages),task=moderator.plan('compact',roles[0],chat);assert(task?.history);readAll(task);moderator.commit(chat,task,task.decode(answer(task)),roles[0].id);
  assert.equal(JSON.stringify(chat.messages),original);const effective=historyFor(chat,roles[0]);assert.equal(effective[0].moderatorMemory,true);assert.equal(effective.at(-1).text,'LATEST_USER_REQUEST: preserve this complete instruction.');assert.deepEqual(effective.slice(-8).map(m=>m.id),chat.messages.slice(-8).map(m=>m.id));
  const transfer=prepare(roles[0],project,chat,false,buildPrompt);assert.equal(transfer.metadata.mode,'moderated');assert(transfer.prompt.includes('LATEST_USER_REQUEST'));let offset=0,full='';for(;;){const page=transfer.history.read({offset});full+=page.text;if(page.eof)break;offset=page.nextOffset;}assert.equal(JSON.parse(full).length,chat.messages.length);
  const independent=historyFor({...chat,relayReplies:false},roles[0]);assert(!independent.some(m=>m.moderatorMemory));assert(independent.every(m=>m.kind==='user'||m.roleId===roles[0].id));
  chat.messages[0].text='Edited source';assert(!historyFor(chat,roles[0])[0].moderatorMemory);chat.messages[0].text=JSON.parse(original)[0].text;
  chat.moderatorCompression=false;assert(!historyFor(chat,roles[0])[0].moderatorMemory);
});
test('A long single user task remains intact even when its early peer replies are summarized',t=>{
  const {store,chat,roles}=fixture(t);store.message(chat.id,{kind:'user',text:'CURRENT_TASK_EXACT',status:'accepted'});for(let i=0;i<20;i++)store.message(chat.id,{kind:'assistant',roleId:roles[1].id,text:'Peer '+i+' '+('long reply ').repeat(400),status:'complete'});
  const task=moderator.plan('compact',roles[0],chat);readAll(task);moderator.commit(chat,task,task.decode(answer(task)),roles[0].id);const effective=historyFor(chat,roles[0]);assert.equal(effective[1].text,'CURRENT_TASK_EXACT');assert.equal(effective.filter(m=>m.kind==='user').length,1);
});
test('Moderator rejects incomplete page reads, forged task bindings, malformed decisions and oversized summaries',t=>{
  const {store,chat,roles}=fixture(t);seed(store,chat);const task=moderator.plan('compact',roles[0],chat);task.history.read({offset:0});assert.throws(()=>task.decode(answer(task)),/complete history/);readAll(task);
  for(const extra of [{token:'wrong'},{sourceHash:'wrong'},{summary:''},{summary:'x'.repeat(17000)},{unexpected:true}])assert.throws(()=>task.decode(answer(task,extra)));
  const review=moderator.plan('review',roles[0],chat);readAll(review);assert.throws(()=>review.decode(answer(review,{decision:'keep_going_forever'})),/invalid/);assert.throws(()=>review.decode('Not JSON'),/JSON/);
  const sourceCount=chat.messages.length;assert.throws(()=>moderator.commit(chat,{...task,sourceHash:'wrong'},{summary:'Wrong'},roles[0].id),/changed/);assert.equal(chat.messages.length,sourceCount);
});
test('Progress commentary before the final coordination JSON is accepted without relaxing task binding',t=>{
  const {store,chat,roles}=fixture(t);seed(store,chat);const task=moderator.plan('compact',roles[0],chat);readAll(task);
  const summary='Keep the path C:\\fixture\\project, a quoted "name", and literal braces { } unchanged.';
  for(const wrap of [json=>'Reading every history page first.\n\n'+json,json=>'Progress: one page read.\n\n```json\n'+json+'\n```',json=>'Progress with an unmatched { brace.\n'+json])assert.equal(task.decode(wrap(answer(task,{summary}))).summary,summary);
  const other=answer(task,{token:'wrong'});assert.throws(()=>task.decode(answer(task)+'\n'+other),/match this task/);
  for(const raw of [answer(task)+'\nAdditional trailing prose.', 'Progress\n'+answer(task)+'\n{broken}', 'Progress\n'+answer(task)+'\n```'])assert.throws(()=>task.decode(raw));
  const unread=moderator.plan('compact',roles[0],chat);assert.throws(()=>unread.decode('Progress\n'+answer(unread)),/complete history/);
});
test('Optional compression failure preserves originals and allows selected participants to answer once',async t=>{
  const {store,chat,roles,project}=fixture(t);seed(store,chat);const originals=JSON.stringify(chat.messages),calls=[];let fallback=0;
  const agents={emit(){},async run(_id,_role,_project,_signal,_summary,context){calls.push(context.moderatorTask.kind);return store.message(chat.id,{kind:'assistant',moderatorTask:'compact',status:'complete',text:'No coordination JSON in this fixture.'});}};
  const coordinator=moderator.coordinator({agents,store,chat,role:roles[0],project,signal:new AbortController().signal,taskId:'fixture',onFallback:()=>fallback++});
  const outcome=await discussion.run({roleIds:[roles[1].id,roles[2].id],rounds:1,autoStop:true,signal:new AbortController().signal,beforeRound:round=>coordinator.beforeRound(round,1),reviewRound:()=>assert.fail('No review at the ceiling'),runTurn:async id=>{calls.push(id);assert.equal(JSON.stringify(chat.messages.slice(0,-1)),originals);assert(historyFor(chat,roles[1]).some(m=>m.text.includes('LATEST_USER_REQUEST')));return {status:'complete'};}});
  assert.equal(outcome.state,'limit');assert.deepEqual(calls,['compact',roles[1].id,roles[2].id]);assert.equal(fallback,1);assert.equal(chat.moderatorMemory,undefined);
  assert.equal(chat.messages.at(-1).moderatorDiagnostic.reason,'invalid_json');assert.equal(chat.messages.at(-1).moderatorFallback.mode,'original_history');assert.equal((await coordinator.beforeRound(2,5)).status,'fallback');assert.equal(calls.length,3);
});
test('Malformed coordination never commits a summary and uncertain transport or user cancellation still stops work',async t=>{
  for(const code of ['REMOTE_CHANNEL_CLOSED','CLI_SHUTDOWN_STALLED','VENDOR_PROTOCOL_TIMEOUT']){
    const {store,chat,roles,project}=fixture(t);seed(store,chat);const agents={emit(){},async run(){return store.message(chat.id,{kind:'assistant',moderatorTask:'compact',status:'failed',text:'',errorCode:code});}};
    const coordinator=moderator.coordinator({agents,store,chat,role:roles[0],project,signal:new AbortController().signal,taskId:'fixture',onFallback:()=>assert.fail('Uncertain shutdown must not proceed')});
    assert.equal((await coordinator.beforeRound(1,2)).status,'failed');assert.equal(chat.moderatorMemory,undefined);assert.equal(chat.messages.at(-1).moderatorFallback,undefined);
  }
});
test('Host reviews replace participant voting without changing order and cannot exceed the round ceiling',async()=>{
  const calls=[],controller=new AbortController();const result=await discussion.run({roleIds:['first','host'],rounds:5,autoStop:true,signal:controller.signal,runTurn:async(id,control)=>{assert.equal(control,null);calls.push(id);return {status:'complete'};},reviewRound:async round=>{calls.push('review');return {status:'complete',decision:round===2?'complete':'continue',reason:'Fixture'};}});
  assert.equal(result.rounds,2);assert.equal(result.state,'complete');assert.deepEqual(calls,['first','host','review','first','host','review']);
  const ceiling=await discussion.run({roleIds:['first'],rounds:2,autoStop:true,signal:controller.signal,runTurn:async()=>({status:'complete'}),reviewRound:async()=>({status:'complete',decision:'continue',reason:'Open issue'})});assert.equal(ceiling.state,'limit');assert.equal(ceiling.rounds,2);
  for(const reply of [{status:'failed'},{status:'complete',decision:'complete',reason:''}]){const outcome=await discussion.run({roleIds:['first'],rounds:5,autoStop:true,signal:controller.signal,runTurn:async()=>({status:'complete'}),reviewRound:async()=>reply});assert.equal(outcome.state,'moderator_failed');assert.equal(outcome.rounds,1);}
  const outcome=await discussion.run({roleIds:['first'],rounds:5,autoStop:true,signal:controller.signal,beforeRound:async()=>({status:'budget'}),runTurn:async()=>assert.fail('Must not run')});assert.equal(outcome.state,'moderator_budget');assert.equal(outcome.rounds,0);
});
test('Coordinator bounds compression calls and excludes its own audit messages from history',async t=>{
  const {store,chat,roles,project}=fixture(t);seed(store,chat);let calls=0;const agents={emit(){},async run(_id,_role,_project,_signal,_summary,context){calls++;const task=context.moderatorTask;readAll(task);return store.message(chat.id,{kind:'assistant',moderatorTask:task.kind,roleId:roles[0].id,text:answer(task),status:'complete'});}};
  const coordinator=moderator.coordinator({agents,store,chat,role:roles[0],project,signal:new AbortController().signal,taskId:'fixture'});
  assert.equal((await coordinator.beforeRound(1,10)).status,'complete');assert(chat.moderatorMemory);assert.equal((await coordinator.reviewRound(1,10)).decision,'complete');assert(!historyFor({...chat,ignoreModeratorMemory:true},roles[0],true).some(m=>m.moderatorTask));
  for(let n=0;n<2;n++){for(let i=0;i<12;i++)store.message(chat.id,{kind:'assistant',roleId:roles[1].id,text:('New context '+n+' ').repeat(600),status:'complete'});const outcome=await coordinator.beforeRound(n+2,10);assert.equal(outcome.status,n===0?'complete':'budget');}
  assert.equal(calls,3);
});
test('Paused coordination does not commit a completed-but-unprocessed summary or retry the task',async t=>{
  const {store,chat,roles,project}=fixture(t);seed(store,chat);const controller=new AbortController();let calls=0;
  const agents={emit(){},async run(_id,_role,_project,_signal,_summary,context){calls++;const task=context.moderatorTask;readAll(task);const message=store.message(chat.id,{kind:'assistant',moderatorTask:task.kind,text:answer(task),status:'complete'});controller.abort();return message;}};
  const coordinator=moderator.coordinator({agents,store,chat,role:roles[0],project,signal:controller.signal,taskId:'fixture'});assert.equal((await coordinator.beforeRound(1,5)).status,'cancelled');assert.equal(calls,1);assert.equal(chat.moderatorMemory,undefined);assert.equal(chat.messages.at(-1).status,'cancelled');
});
test('Claude coordination disables inherited MCP, built-in tools and hooks without changing saved role permissions',async t=>{
  const {store,roles,project,directory}=fixture(t),role=store.saveRole({...roles[1],engine:'claude',provider:'native',executable:process.execPath,permission:'danger-full-access'}),agents=new Agents(store,{get:()=>''},{},()=>{});t.after(()=>agents.close());
  const prepared=await agents.prepareLocal({...role,permission:'read-only',allowLocationTools:false,moderatorTask:true},directory,project);
  assert.equal(prepared.tools,null);assert(prepared.extra.includes('--strict-mcp-config'));assert.equal(prepared.extra[prepared.extra.indexOf('--tools')+1],'');assert.equal(JSON.parse(prepared.extra[prepared.extra.indexOf('--settings')+1]).disableAllHooks,true);assert.deepEqual(JSON.parse(prepared.extra[prepared.extra.indexOf('--mcp-config')+1]),{mcpServers:{}});assert.equal(store.get('roles',role.id).permission,'danger-full-access');
});
test('Real ACP adapter uses a separate read-only moderator task and validates all history pages through MCP',async t=>{
  const {store,chat,roles,project}=fixture(t);seed(store,chat);const role=store.saveRole({...roles[0],id:undefined,engine:'codebuddy',provider:'native',executable:path.join(__dirname,'fixtures/acp-agent.cjs'),model:'fixture-model',permission:'danger-full-access',allowLocationTools:true,codexLoginSource:'isolated'});store.saveChat({...chat,roleIds:[role.id,roles[1].id],moderatorRoleId:role.id});
  const agents=new Agents(store,{get:()=>''},{},()=>{});t.after(()=>agents.close());const coordinator=moderator.coordinator({agents,store,chat,role,project,signal:new AbortController().signal,taskId:'fixture'});
  const result=await coordinator.beforeRound(1,3);assert.equal(result.status,'complete',chat.messages.at(-1).note);assert.equal(chat.messages.at(-1).permission,'read-only');assert.equal(chat.messages.at(-1).moderatorTask,'compact');assert(chat.moderatorMemory.summary.includes('Fixture summary'));assert.equal(role.permission,'danger-full-access');
  assert.equal((await coordinator.reviewRound(1,3)).decision,'complete');assert(!historyFor({...chat,ignoreModeratorMemory:true},role,true).some(m=>m.moderatorTask));
});
