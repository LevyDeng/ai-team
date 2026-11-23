const test = require('node:test');
const assert = require('node:assert/strict');
const workflows = require('../workbench/generated-workflow.cjs');
const ratings = require('../workbench/workflow-ratings.js');

const signal = new AbortController().signal;
const complete = {status:'complete', text:'Verified result\nWORKFLOW: DONE'};
const step = {title:'Implement', instruction:'Update the view and run its tests', domain:'Frontend', duty:'Implementation'};
const assess = score => ratings.normalize([{domain:'Frontend',duty:'Implementation',score}]);
const role = (id,score) => ({id,name:id,workflowRatings:score == null ? [] : assess(score)});
const knownRoles = [role('primary',8),role('backup',5),role('unrated')];
const priorities = () => ratings.migrate(knownRoles, () => 'priority-rule');
const fixture = (nodes,moderatorRoleId) => ({messages:[],workflow:workflows.configure({title:'Viewer repair',goal:'Repair the viewer',nodes,moderatorRoleId}, knownRoles)});

test('Legacy ratings migrate to tiers with equal weights and preserve custom labels', () => {
  const scores = ratings.normalize([{domain:' Physics ',duty:'Investigation',score:9}]);
  assert.deepEqual(scores,[{domain:'Physics',duty:'Investigation',score:9}]);
  const migrated = ratings.migrate([{id:'physics',workflowRatings:scores}], () => 'physics-rule');
  assert.ok(ratings.catalog(migrated).domains.includes('Physics'));
  assert.throws(()=>ratings.normalize([...scores,{domain:'physics',duty:'INVESTIGATION',score:1}]),/unique/);
  assert.throws(()=>ratings.normalize([{...scores[0],score:3.5}]),/whole-number/);
  assert.deepEqual(priorities()[0].candidates,[
    {roleId:'primary',tier:1,weight:1},{roleId:'backup',tier:2,weight:1},
  ]);
  const tied = ratings.migrate([role('first',9),role('second',9),role('third',3)], () => 'tie-rule');
  assert.deepEqual(tied[0].candidates.map(item=>[item.tier,item.weight]),[[1,1],[1,1],[2,1]]);
});

test('Weighted draws only compare members of the same tier and never repeat a candidate', () => {
  const candidates = [
    {roleId:'first',tier:1,weight:3},{roleId:'peer',tier:1,weight:1},{roleId:'last',tier:2,weight:100},
  ];
  assert.deepEqual(ratings.weightedOrder(candidates,()=>0.749).map(item=>item.roleId),['first','peer','last']);
  assert.deepEqual(ratings.weightedOrder(candidates,()=>0.75).map(item=>item.roleId),['peer','first','last']);
  assert.equal(candidates.length,3);
  assert.throws(()=>ratings.normalizeRule({...step,candidates:[candidates[0],candidates[0]]}));
  assert.throws(()=>ratings.normalizeRule({...step,candidates:[{...candidates[0],weight:0}]}));
});

test('Generated plans default to auto and reject invalid transitions or embedded role assignments', () => {
  const task = workflows.planTask('Repair the viewer',ratings.catalog(priorities()));
  const plan = {token:task.token,title:'Viewer repair',nodes:[step]};
  assert.equal(task.decode(JSON.stringify(plan)).nodes[0].mode,'auto');
  for (const value of [
    {...plan,token:'wrong'}, {...plan,nodes:[{...step,next:0}]}, {...plan,nodes:[{...step,roleIds:['primary']}]},
    {...plan,nodes:[{...step,mode:'ordered'}]}, {...plan,nodes:Array(13).fill(step)},
  ]) assert.throws(()=>task.decode(JSON.stringify(value)),/ordered steps/);
  assert.throws(()=>fixture([{...step,mode:'ordered',roleIds:['foreign']}]),/project role/);
});

test('Review and device checks share a bounded return to repair and pass findings to the next role', async () => {
  const task = workflows.planTask('Repair and test', {});
  const nodes = ['Plan','Repair','Review','Device test'].map((title,i) => ({...step,title,...(i >= 2 ? {reworkTo:2} : {})}));
  const plan = task.decode(JSON.stringify({token:task.token,title:'Repair',nodes,reworkLimit:2}));
  const chat = {messages:[],workflow:workflows.configure({...plan,goal:'Repair'},knownRoles)};
  const visited = [];
  const findings = ['Incorrect width','Device click failed'];
  let snapshot;
  await workflows.run(chat,{signal,save(){},roles:()=>knownRoles,priorities,turn:async (attempt,prompt)=>{
    const index = attempt.nodeIndex;
    const count = chat.workflow.reworkCount;
    visited.push(index+1);
    if (index === 1 && count) assert.ok(prompt.includes(findings[count-1]));
    if ((index === 2 && !count) || (index === 3 && count === 1)) {
      const receipt = {kind:'assistant',workflowAttemptId:attempt.id,status:'complete',text:findings[count]+'\nWORKFLOW: REWORK'};
      chat.messages.push(receipt);
      snapshot = structuredClone(chat);
      return receipt;
    }
    return complete;
  }});
  assert.deepEqual(visited,[1,2,3,2,3,4,2,3,4]);
  assert.equal(chat.workflow.status,'complete');
  workflows.recover(snapshot);
  workflows.recover(snapshot);
  assert.equal(snapshot.workflow.nodeIndex,1);
  assert.equal(snapshot.workflow.reworkCount,2);
  await workflows.run(snapshot,{signal,save(){},roles:()=>knownRoles,priorities,turn:async attempt=>
    attempt.nodeIndex === 2 ? {status:'complete',text:'Still broken\nWORKFLOW: REWORK'} : complete});
  assert.equal(snapshot.workflow.status,'round_limit');
  assert.equal(snapshot.workflow.reworkCount,2);
  assert.equal(snapshot.workflow.attempts.at(-1).reason,'Still broken');
});

test('Rework targets must be earlier steps and the shared limit is finite', () => {
  for (const reworkTo of [0,2,3,-1,1.5,'1']) assert.throws(()=>fixture([step,{...step,reworkTo}]),/earlier step/);
  for (const reworkLimit of [-1,21,1.5,null]) {
    assert.throws(()=>workflows.configure({goal:'Repair',title:'Plan',nodes:[step],reworkLimit},knownRoles),/0 to 20/);
  }
});

test('Each auto node reads current priority rules; an ordered node retains its explicit order', async () => {
  const chat = fixture([step,{...step,title:'Verify'},{...step,title:'Final review',mode:'ordered',roleIds:['primary','backup']}]);
  let rules = priorities();
  await workflows.run(chat,{signal,save(){},roles:()=>knownRoles,priorities:()=>rules,route:async()=>assert.fail('Matched priority rule should take precedence'),turn:async attempt=>{
    if (attempt.nodeIndex===0) rules = ratings.migrate([role('primary',2),role('backup',10)], () => 'updated');
    return complete;
  }});
  assert.equal(chat.workflow.status,'complete');
  assert.deepEqual(chat.workflow.attempts.map(a=>[a.roleId,a.priority?.tier,a.via]),[['primary',1,'priority'],['backup',1,'priority'],['primary',undefined,'ordered']]);
});

test('Moderator handles unmatched steps and unavailable matches stop for inspection', async () => {
  const chat = fixture([step],'host');
  await workflows.run(chat,{signal,save(){},roles:()=>knownRoles,route:async task=>{
    return task.select(JSON.stringify({token:task.token,roleId:'unrated',reason:'Already has context'}));
  },turn:async()=>complete});
  assert.equal(chat.workflow.status,'complete');
  assert.deepEqual(chat.workflow.attempts.map(a=>[a.roleId,a.via,a.selectionReason]),[
    ['unrated','moderator','Already has context'],
  ]);
  const noRatings = fixture([step],'host');
  await workflows.run(noRatings,{signal,save(){},roles:()=>[knownRoles[2]],route:async()=>undefined,turn:async()=>assert.fail('Unrated role should not run without routing')});
  assert.equal(noRatings.workflow.status,'needs_check');
  assert.equal(noRatings.workflow.attempts.length,0);
  const unavailable = fixture([step],'host');
  await workflows.run(unavailable,{signal,save(){},roles:()=>[knownRoles[2]],priorities,
    route:async()=>assert.fail('A matched rule should retain its candidate restrictions'),
    turn:async()=>assert.fail('Unavailable rule candidates should not run')});
  assert.equal(unavailable.workflow.status,'needs_check');
  assert.equal(unavailable.workflow.selection.items.length,0);
});

test('Recovery uses the saved node selection and never dispatches after an uncertain receipt', async () => {
  const chat = fixture([step,{...step,title:'Verify'}]);
  let saved;
  await workflows.run(chat,{signal,save(){},roles:()=>knownRoles,priorities,turn:async attempt=>{
    if (attempt.nodeIndex===0&&attempt.roleId==='primary') {
      const receipt = {kind:'assistant',workflowAttemptId:attempt.id,status:'failed',note:'HTTP 429 quota exhausted'};
      chat.messages.push(receipt);
      saved = structuredClone(chat);
      return receipt;
    }
    return complete;
  }});
  const uncertain = structuredClone(saved);
  uncertain.messages=[];
  workflows.recover(uncertain);
  assert.equal(uncertain.workflow.status,'needs_check');
  workflows.recover(saved);
  const selected=[];
  await workflows.run(saved,{signal,save(){},roles:()=>knownRoles,priorities,turn:async attempt=>{
    selected.push(attempt.roleId);return complete;
  }});
  assert.equal(saved.workflow.status,'complete');
  assert.deepEqual(selected,['backup','primary']);
});

test('A step asking for a decision does not advance or repeat automatically',async()=>{
  const chat = fixture([step,step]);
  await workflows.run(chat,{signal,save(){},roles:()=>knownRoles,priorities,turn:async()=>({status:'complete',text:'Approval needed\nWORKFLOW: NEEDS_USER'})});
  assert.equal(chat.workflow.status,'needs_check');
  assert.equal(chat.workflow.nodeIndex,0);
  assert.equal(chat.workflow.attempts.length,1);
});

test('Generated steps wait for the role and can still be stopped manually', async t => {
  const scheduled = t.mock.method(AbortSignal, 'timeout');
  const controller = new AbortController();
  const chat = fixture([step, step, step]);
  await workflows.run(chat, {
    signal:controller.signal, save(){}, roles:()=>knownRoles, priorities,
    async turn(attempt, _prompt, stepSignal) {
      assert.equal(stepSignal, controller.signal);
      if (attempt.nodeIndex === 0) return complete;
      controller.abort();
      return {status:'cancelled', stopConfirmed:true};
    }
  });
  assert.equal(scheduled.mock.callCount(), 0);
  assert.equal(chat.workflow.status, 'paused');
  assert.deepEqual(chat.workflow.attempts.map(attempt => attempt.status), ['complete', 'cancelled']);
});
