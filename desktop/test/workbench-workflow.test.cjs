const test=require('node:test');
const assert=require('node:assert/strict');
const {configure,run,recover}=require('../workbench/workflow.cjs');
const roles=[...['developer','backup','reviewer','alternate'].map(id=>({id,engine:'opencode'})),{id:'host',engine:'antigravity'},
  {id:'manual',engine:'gemini-web'}, {id:'disabled',engine:'codex',enabled:false}];
function fixture(settings={}){
  return {messages:[],workflow:configure({goal:'Repair the viewer',criteria:'Viewer tests pass',
    teams:{implement:['developer','backup'],review:['reviewer','alternate']},limit:2,...settings},roles)};
}
const complete=text=>({status:'complete',text});
const rejected={status:'failed',note:'HTTP 429 insufficient_quota'};
const signal=new AbortController().signal;
const selection=(task,roleId,extra={})=>JSON.stringify({token:task.token,roleId,...extra});

test('Independent ordered backup teams implement, review, request changes and pass',async()=>{
  const chat=fixture(),calls=[];
  const results=[rejected,complete('Patch 1'),{status:'failed',workflowSubmitted:false,note:'ECONNREFUSED'},complete('Fix the width.\nVERDICT: REWORK'),complete('Patch 2'),complete('Tests pass.\nVERDICT: PASS')];
  await run(chat,{signal,save(){},turn:async a=>{calls.push(a.roleId);return results.shift();}});
  assert.deepEqual(calls,['developer','backup','reviewer','alternate','developer','reviewer']);
  assert.equal(chat.workflow.status,'complete');
  assert.equal(chat.workflow.round,2);
});
test('All candidates unavailable stops at that stage; partial execution goes to inspection',async()=>{
  for(const stage of ['implement','review']){
    const chat=fixture();chat.workflow.stage=stage;
    await run(chat,{signal,save(){},turn:async()=>rejected});
    assert.equal(chat.workflow.status,'unavailable');
    assert.match(chat.workflow.reason,new RegExp(stage));
    assert.deepEqual(chat.workflow.attempts.map(a=>a.roleId),chat.workflow.teams[stage]);
  }
  const chat=fixture();
  await run(chat,{signal,save(){},turn:async()=>({...rejected,activities:[{title:'Write file'}]})});
  assert.equal(chat.workflow.status,'needs_check');assert.equal(chat.workflow.attempts.length,1);
});
test('Restart recovers confirmed results once and parks a missing receipt',async()=>{
  const chat=fixture();let saved;
  await run(chat,{signal,save(){},turn:async attempt=>{
    if(attempt.stage==='review')return complete('Passed\nVERDICT: PASS');
    const reply={kind:'assistant',workflowAttemptId:attempt.id,...complete('Patch saved')};
    chat.messages.push(reply);saved=structuredClone(chat);return reply;
  }});
  const missing=structuredClone(saved);missing.messages=[];recover(missing);assert.equal(missing.workflow.status,'needs_check');
  recover(saved);assert.equal(saved.workflow.stage,'review');assert.equal(saved.workflow.status,'queued');
  const calls=[];
  await run(saved,{signal,save(){},turn:async a=>{calls.push(a.roleId);return complete('Verified\nVERDICT: PASS');}});
  assert.deepEqual(calls,['reviewer']);
});
test('Confirmed quota failure hands completed work over without treating a lost remote channel as confirmed',async()=>{
  const chat=fixture(),prompts=[];
  await run(chat,{signal,save(){},turn:async(a,prompt)=>{
    prompts.push(prompt);
    if(a.roleId==='developer')return {...rejected,stopConfirmed:true,activities:[{status:'complete',title:'Write patch'}]};
    if(a.roleId==='backup')return complete('Verified existing patch and finished the test.');
    return {status:'failed',errorCode:'REMOTE_CHANNEL_CLOSED',stopConfirmed:false,note:'Lost remote connection'};
  }});
  assert.match(prompts[1],/Inspect the current workspace/);
  assert.equal(chat.workflow.status,'needs_check');
  assert.deepEqual(chat.workflow.attempts.map(a=>a.roleId),['developer','backup','reviewer']);
});

test('A moderator chooses one candidate per stage and fallback keeps the original order until the next round',async()=>{
  const chat=fixture({moderatorRoleId:'host'}),calls=[],selections=['backup','alternate','backup','alternate'];
  await run(chat,{signal,save(){},describe:id=>({name:id}),route:async task=>{
    const roleId=selections.shift();calls.push('route:'+roleId);
    return task.select(selection(task,roleId));
  },turn:async attempt=>{
    calls.push(attempt.roleId);
    if(attempt.stage==='implement')return attempt.roleId==='backup'?rejected:complete('Patch saved');
    return complete('Changes still needed.\nVERDICT: REWORK');
  }});
  assert.deepEqual(calls,['route:backup','backup','developer','route:alternate','alternate','route:backup','backup','developer','route:alternate','alternate']);
  assert.equal(chat.workflow.status,'round_limit');
  assert.equal(chat.workflow.round,2);
});

test('Invalid routing output or an invalid workflow stops before running a participant',async()=>{
  for (const id of ['manual','disabled','unknown']) assert.throws(()=>fixture({moderatorRoleId:id}));
  for(const response of [task=>selection(task,'reviewer'),task=>selection(task,'developer',{action:'restart'})]){
    const chat=fixture({moderatorRoleId:'host'});
    let attempts=0;
    await run(chat,{signal,save(){},route:async task=>task.select(response(task)),turn:async()=>{attempts++;}});
    assert.equal(chat.workflow.status,'needs_check');
    assert.match(chat.workflow.reason,/could not select/);
    assert.equal(attempts,0);
  }
  const chat=fixture();chat.workflow.limit=Infinity;
  await run(chat,{signal,save(){},turn:async()=>assert.fail('Invalid workflow started a participant')});
  assert.equal(chat.workflow.status,'needs_check');
});

test('Moderator selection survives a restart and singleton teams skip selection',async()=>{
  const chat=fixture({moderatorRoleId:'host',teams:{implement:['developer','backup'],review:['reviewer']}});
  let saved;
  await run(chat,{signal,save(){},route:async task=>task.select(selection(task,'backup')),turn:async attempt=>{
    if(attempt.stage==='review')return complete('VERDICT: PASS');
    if(attempt.roleId==='developer')return complete('Verified and patched');
    const reply={kind:'assistant',workflowAttemptId:attempt.id,...rejected};
    chat.messages.push(reply);saved=structuredClone(chat);return reply;
  }});
  recover(saved);
  const calls=[];
  await run(saved,{signal,save(){},route:async()=>assert.fail('Selection was already saved or unnecessary'),turn:async attempt=>{
    calls.push(attempt.roleId);return complete('VERDICT: PASS');
  }});
  assert.deepEqual(calls,['developer','reviewer']);
  assert.equal(saved.workflow.status,'complete');
});

test('Stopping during moderator selection does not dispatch the chosen role',async()=>{
  const chat=fixture({moderatorRoleId:'host'}), controller=new AbortController();
  await run(chat,{signal:controller.signal,save(){},route:async(task,routeSignal)=>{
    controller.abort();
    assert.equal(routeSignal.aborted,true);
    return task.select(selection(task,'backup'));
  },turn:async()=>assert.fail('Participant started after stopping')});
  assert.equal(chat.workflow.status,'paused');
  assert.deepEqual(chat.workflow.attempts,[]);
});

test('A routing timeout stops selection and participants use the workflow cancellation signal',async t=>{
  const timeouts=[];
  t.mock.method(AbortSignal,'timeout',ms=>{
    const controller=new AbortController();
    timeouts.push({ms,controller});
    return controller.signal;
  });
  const waitingForRoute=fixture({moderatorRoleId:'host'});
  await run(waitingForRoute,{signal,save(){},route:async(task,routeSignal)=>{
    timeouts.at(-1).controller.abort();
    if(routeSignal.aborted)return task.select(selection(task,'backup'));
  },turn:async()=>assert.fail('Participant started after a routing timeout')});
  assert.match(waitingForRoute.workflow.reason,/moderator timed out/);
  assert.equal(waitingForRoute.workflow.attempts.length,0);

  const manuallyStopped = fixture({moderatorRoleId:'host'});
  const controller = new AbortController();
  await run(manuallyStopped,{signal:controller.signal,save(){},route:async task=>task.select(selection(task,'backup')),turn:async(_attempt,_prompt,stepSignal)=>{
    timeouts.at(-1).controller.abort();
    assert.equal(stepSignal,controller.signal);
    assert.equal(stepSignal.aborted,false);
    controller.abort();
    return {status:'cancelled',stopConfirmed:true};
  }});
  assert.deepEqual(timeouts.map(timeout=>timeout.ms),[90_000,90_000]);
  assert.equal(manuallyStopped.workflow.status,'paused');
  assert.equal(manuallyStopped.workflow.attempts[0].status,'cancelled');
});
