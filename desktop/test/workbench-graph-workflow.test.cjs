const assert = require('node:assert/strict');
const test = require('node:test');
const graph = require('../workbench/graph-workflow.cjs');

const role = {id:'local-role',locationId:'local'};
const node = (id, title, limit, exits) => ({
  id,title,limit,exits:exits.map(([label,to])=>({label,to})),instruction:'Verify the result',roleId:role.id,
});
const template = {
  title:'Repair and verify',entry:'n1',
  nodes:[
    node('n1','Plan',1,[['Plan ready','n2']]),
    node('n2','Repair',3,[['Repair ready','n3']]),
    node('n3','Review',3,[['Pass','n4'],['Defect','n2']]),
    {...node('n4','Test',3,[['Pass','complete'],['Defect','n2'],['Device offline','n4']]),localOnly:true},
  ],
};
const receipt = (exit, text = 'Observed evidence') => ({status:'complete',text:text+'\nWORKFLOW: EXIT '+exit});
const fixture = (draft=template) => ({workflow:graph.configure({...draft,goal:'Fix the demo'},[role]),messages:[]});
const run = (chat,turn) => graph.run(chat,{signal:new AbortController().signal,save(){},turn});

test('Graph follows review and test feedback without rerunning planning',async()=>{
  const chat=fixture();
  const results=[1,1,2,1,1,2,1,1,3,1];
  let saved;
  await run(chat,async (attempt,prompt)=>{
    const result=receipt(results.shift(), 'Evidence for attempt '+chat.workflow.attempts.length);
    const previous=chat.workflow.attempts.at(-2);
    if (previous) assert.ok(prompt.includes(previous.evidence));
    chat.messages.push({kind:'assistant',workflowAttemptId:attempt.id,...result});
    if (chat.workflow.attempts.length===6) saved=structuredClone(chat);
    return result;
  });
  assert.equal(chat.workflow.status,'complete');
  assert.deepEqual(chat.workflow.attempts.map(a=>a.nodeIndex),[0,1,2,1,2,3,1,2,3,3]);
  assert.deepEqual(chat.workflow.visits,{n1:1,n2:3,n3:3,n4:3});
  graph.recover(saved);
  graph.recover(saved);
  assert.equal(saved.workflow.visits.n4,1);
  assert.equal(saved.workflow.nodeIndex,1);
  let prompt;
  await run(saved,async (attempt,input)=>{ prompt=input;return receipt(9); });
  assert.match(prompt,/Evidence for attempt 6/);
  assert.equal(saved.workflow.status,'needs_check');
  assert.equal(saved.workflow.visits.n2,2);
});

test('An exhausted repair node records why the workflow stopped',async()=>{
  const chat=fixture();
  await run(chat,async ({nodeIndex})=>receipt(nodeIndex===2?2:1));
  assert.equal(chat.workflow.status,'round_limit');
  assert.equal(chat.workflow.visits.n2,3);
  assert.equal(chat.workflow.attempts.at(-1).target,'n2');
  assert.equal(chat.workflow.attempts.at(-1).outcome,'Defect');
});

test('Validation rejects broken targets and remote roles on local-only nodes',()=>{
  const broken=structuredClone(template);
  broken.nodes[1].exits[0].to='n99';
  assert.throws(()=>graph.validate(broken));
  const unreachable=structuredClone(template);
  unreachable.nodes[2].exits[0].to='complete';
  assert.throws(()=>graph.validate(unreachable));
  assert.throws(()=>graph.configure({...template,goal:'Test'},[{...role,locationId:'remote'}]));
});
