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
const fixture = (nodes,moderatorRoleId) => ({messages:[],workflow:workflows.configure({title:'Viewer repair',goal:'Repair the viewer',nodes,moderatorRoleId}, knownRoles)});

test('Workflow ratings share custom labels, retain unknown scores and reject duplicate or invalid ratings', () => {
  const scores = ratings.normalize([{domain:' Physics ',duty:'Investigation',score:9}]);
  assert.deepEqual(scores,[{domain:'Physics',duty:'Investigation',score:9}]);
  assert.ok(ratings.catalog([{workflowRatings:scores}]).domains.includes('Physics'));
  assert.throws(()=>ratings.normalize([...scores,{domain:'physics',duty:'INVESTIGATION',score:1}]),/unique/);
  assert.throws(()=>ratings.normalize([{...scores[0],score:3.5}]),/whole-number/);
  assert.deepEqual(ratings.rank(step,[knownRoles[2],knownRoles[1],knownRoles[0]]),[
    {roleId:'primary',score:8},{roleId:'backup',score:5},{roleId:'unrated',score:null},
  ]);
});

test('Generated plans default to auto and reject invalid transitions or embedded role assignments', () => {
  const task = workflows.planTask('Repair the viewer',ratings.catalog(knownRoles));
  const plan = {token:task.token,title:'Viewer repair',nodes:[step]};
  assert.equal(task.decode(JSON.stringify(plan)).nodes[0].mode,'auto');
  for (const value of [
    {...plan,token:'wrong'}, {...plan,nodes:[{...step,next:0}]}, {...plan,nodes:[{...step,roleIds:['primary']}]},
    {...plan,nodes:[{...step,mode:'ordered'}]}, {...plan,nodes:Array(13).fill(step)},
  ]) assert.throws(()=>task.decode(JSON.stringify(value)),/ordered steps/);
  assert.throws(()=>fixture([{...step,mode:'ordered',roleIds:['foreign']}]),/project role/);
});

test('Each auto node reads current scores; an ordered node retains its explicit order', async () => {
  const chat = fixture([step,{...step,title:'Verify'},{...step,title:'Final review',mode:'ordered',roleIds:['primary','backup']}]);
  let roles = knownRoles;
  await workflows.run(chat,{signal,save(){},roles:()=>roles,turn:async attempt=>{
    if (attempt.nodeIndex===0) roles = [role('primary',2),role('backup',10),role('unrated')];
    return complete;
  }});
  assert.equal(chat.workflow.status,'complete');
  assert.deepEqual(chat.workflow.attempts.map(a=>[a.roleId,a.score,a.via]),[['primary',8,'ratings'],['backup',10,'ratings'],['primary',undefined,'ordered']]);
});

test('Moderator can select by context; invalid output and outages fall back only to matches', async () => {
  const chat = fixture([step,step,step],'host');
  let called = 0;
  await workflows.run(chat,{signal,save(){},roles:()=>knownRoles,route:async task=>{
    called++;
    if (called===3) throw Error('connection unavailable');
    return task.select(JSON.stringify({token:task.token,roleId:called===1?'unrated':'foreign',reason:'Already has context'}));
  },turn:async()=>complete});
  assert.equal(chat.workflow.status,'complete');
  assert.deepEqual(chat.workflow.attempts.map(a=>[a.roleId,a.via,a.selectionReason]),[
    ['unrated','moderator','Already has context'],['primary','ratings_fallback',undefined],['primary','ratings_fallback',undefined],
  ]);
  const noRatings = fixture([step],'host');
  await workflows.run(noRatings,{signal,save(){},roles:()=>[knownRoles[2]],route:async()=>undefined,turn:async()=>assert.fail('Unrated role should not run without routing')});
  assert.equal(noRatings.workflow.status,'needs_check');
  assert.equal(noRatings.workflow.attempts.length,0);
});

test('Recovery uses the saved node selection and never dispatches after an uncertain receipt', async () => {
  const chat = fixture([step,{...step,title:'Verify'}]);
  let saved;
  await workflows.run(chat,{signal,save(){},roles:()=>knownRoles,turn:async attempt=>{
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
  await workflows.run(saved,{signal,save(){},roles:()=>[role('primary',10),role('backup',1)],turn:async attempt=>{
    selected.push(attempt.roleId);return complete;
  }});
  assert.equal(saved.workflow.status,'complete');
  assert.deepEqual(selected,['backup','primary']);
});

test('A step asking for a decision does not advance or repeat automatically',async()=>{
  const chat = fixture([step,step]);
  await workflows.run(chat,{signal,save(){},roles:()=>knownRoles,turn:async()=>({status:'complete',text:'Approval needed\nWORKFLOW: NEEDS_USER'})});
  assert.equal(chat.workflow.status,'needs_check');
  assert.equal(chat.workflow.nodeIndex,0);
  assert.equal(chat.workflow.attempts.length,1);
});
