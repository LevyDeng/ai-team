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
  await run(saved,async (attempt,input)=>{
    prompt=input;return {status:'complete',text:'Device access required\nWORKFLOW: BLOCKED'};
  });
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

const backup = {id:'backup-role',locationId:'local'};
const another = {id:'another-role',locationId:'local'};
const unavailable = {status:'failed',errorCode:'CODEX_CAPACITY',note:'At capacity',stopConfirmed:true};

test('Graph preserves the ordered backup list and retries within the same visit after recovery',async()=>{
  const draft = {title:'One step',entry:'n1',nodes:[{
    ...node('n1','Check',1,[['Pass','complete']]), localOnly:true, backupRoleIds:[backup.id,another.id],
  }]};
  const flow = graph.configure({...draft,goal:'Verify'},[{...role,enabled:false},backup,another]);
  assert.deepEqual(graph.roleIds(flow),[role.id,backup.id,another.id]);
  assert.deepEqual(flow.nodes[0].backupRoleIds,[backup.id,another.id]);
  assert.throws(()=>graph.validate({...draft,nodes:[{...draft.nodes[0],backupRoleIds:[role.id]}]}));
  const chat={workflow:flow,messages:[]};
  let saved;
  await run(chat,async (attempt,prompt)=>{
    const result=attempt.roleId===another.id?receipt(1):unavailable;
    chat.messages.push({kind:'assistant',workflowAttemptId:attempt.id,...result});
    if (attempt.roleId===role.id) saved=structuredClone(chat);
    else assert.match(prompt,/taking over the current workflow step/);
    return result;
  });
  assert.equal(flow.status,'complete');
  assert.deepEqual(flow.attempts.map(item=>item.roleId),[role.id,backup.id,another.id]);
  assert.deepEqual(flow.visits,{n1:1});
  graph.recover(saved);
  await run(saved,async attempt=>{assert.equal(attempt.roleId,backup.id);return receipt(1);});
  assert.equal(saved.workflow.status,'complete');
  assert.deepEqual(saved.workflow.visits,{n1:1});

  const exhausted={workflow:graph.configure({...draft,goal:'Verify'},[role,backup,another]),messages:[]};
  await run(exhausted,async()=>unavailable);
  assert.equal(exhausted.workflow.status,'unavailable');
  assert.equal(exhausted.workflow.nodeCandidateIndex,undefined);
  assert.equal(exhausted.workflow.attempts.length,3);
});

test('Loop iterations start with the primary again and stop on an unconfirmed shutdown',async()=>{
  const body={...node('n1','Check',1,[['Finished','iteration_end']]),kind:'role',backupRoleIds:[backup.id]};
  const loop={id:'n1',kind:'loop',title:'Review loop',rounds:2,mode:'fixed',exits:[{label:'Done',to:'complete'}],
    body:{entry:'n1',nodes:[body]}};
  const prepare=()=>({workflow:graph.configure({title:'Loop',goal:'Verify',structured:true,entry:'n1',nodes:[loop]},[role,backup]),messages:[]});
  const chat=prepare();
  await run(chat,async attempt=>attempt.roleId===role.id?unavailable:receipt(1));
  assert.equal(chat.workflow.status,'complete');
  assert.deepEqual(chat.workflow.attempts.map(a=>[a.roleId,a.path.at(-1).round]),
    [[role.id,1],[backup.id,1],[role.id,2],[backup.id,2]]);

  const blocked=prepare();
  await run(blocked,async()=>({...unavailable,stopConfirmed:false}));
  assert.equal(blocked.workflow.status,'needs_check');
  assert.equal(blocked.workflow.stopUnconfirmed,true);
  assert.equal(blocked.workflow.attempts.length,1);
});

test('Single-exit nodes hand off reports without a routing marker and reuse prior reports on resume',async()=>{
  for (const structured of [false,true]) {
    const draft={title:'Handoff',entry:'n1',structured,nodes:[
      node('n1','Implement',1,[['Done','n2']]),node('n2','Verify',1,[['Reviewed','complete']]),
    ]};
    const report='Implemented the change. The next role still needs to verify it.';
    const chat=fixture(draft);
    await run(chat,async (_attempt,prompt)=>{
      assert.match(prompt,/No exit marker is needed/);
      return {status:'complete',text:report};
    });
    assert.equal(chat.workflow.status,'complete');
    assert.deepEqual(chat.workflow.attempts.map(attempt=>attempt.evidence),[report,report]);

    const stopped=fixture(draft);
    stopped.workflow.status='needs_check';
    stopped.workflow.attempts=[{id:'prior-attempt',nodeIndex:0,roleId:role.id,status:'complete'}];
    stopped.messages=[{kind:'assistant',workflowAttemptId:'prior-attempt',status:'complete',text:report+'\nWORKFLOW: NEEDS_USER'}];
    assert.equal(graph.continueReportedNode(stopped),true);
    assert.equal(stopped.workflow.status,'queued');
    assert.equal(stopped.workflow.attempts[0].evidence,report);
    await run(stopped,async (_attempt,prompt)=>{
      assert.match(prompt,/Current (?:node|workflow path): Verify/);
      assert.match(prompt,/Implemented the change/);
      return {status:'complete',text:'Review evidence'};
    });
    assert.equal(stopped.workflow.status,'complete');
    assert.equal(stopped.workflow.attempts.length,2);
  }
});

test('A single exit still stops on an explicit blocker, an empty report or a failed run',async()=>{
  const draft={title:'Handoff',entry:'n1',nodes:[node('n1','Implement',1,[['Done','complete']])]};
  for (const result of [
    {status:'complete',text:'Access is required\nWORKFLOW: BLOCKED'},
    {status:'complete',text:'WORKFLOW: NEEDS_USER'},
    {status:'failed',text:'Partial implementation evidence'},
    {status:'complete',warningCode:'CLAUDE_PERMISSION_DENIED',text:'Could not edit protected file'},
  ]) {
    const chat=fixture(draft);
    await run(chat,async()=>result);
    assert.equal(chat.workflow.status,'needs_check');
    assert.equal(chat.workflow.attempts[0].outcome,undefined);
    chat.messages=[{kind:'assistant',workflowAttemptId:chat.workflow.attempts[0].id,...result}];
    assert.equal(graph.continueReportedNode(chat),false);
  }
});

test('Multiple exits are evaluated against the configured criteria and require a supported decision',async()=>{
  const draft={title:'Review',entry:'n1',nodes:[node('n1','Verify',1,[
    ['All checks pass','complete'],['A functional regression remains','unresolved'],
  ])]};
  const chat=fixture(draft);
  await run(chat,async (_attempt,prompt)=>{
    assert.match(prompt,/meaning of the user-defined exit conditions/);
    assert.match(prompt,/1\. All checks pass/);
    assert.match(prompt,/2\. A functional regression remains/);
    return receipt(2,'The restart still drops the setting');
  });
  assert.equal(chat.workflow.status,'unresolved');
  assert.equal(chat.workflow.attempts[0].outcome,'A functional regression remains');

  for (const text of ['The restart still drops the setting','Observed evidence\nWORKFLOW: EXIT 9','Observed evidence\nWORKFLOW: NEEDS_USER']) {
    const ambiguous=fixture(draft);
    await run(ambiguous,async()=>({status:'complete',text}));
    assert.equal(ambiguous.workflow.status,'needs_check');
    assert.equal(graph.continueReportedNode(ambiguous),false);
  }
});
