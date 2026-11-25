const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
const structured = require('./structured-workflow.cjs');
const nodeRoles = require('./graph-workflow-roles.cjs');
const {decisionFor, exitInstructions} = require('./graph-workflow-exits.cjs');

const terminals = new Set(['complete', 'unresolved']);
function field(value, max, error) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(error);
  return value.trim();
}

const position = value => Number.isFinite(value) ? Math.max(-10000, Math.min(10000,value)) : 0;
function exitsFor(exits, ids, allowedTerminals) {
  if (!Array.isArray(exits) || !exits.length || exits.length > 8) throw new Error('每个节点需要 1 到 8 个出口。');
  const normalized = exits.map(exit => {
    const label = field(exit?.label, 200, '请说明每个出口的判断条件（最多 200 字）。');
    if (!ids.has(exit.to) && !allowedTerminals.has(exit.to)) throw new Error('请为每个出口选择目标。');
    return {label, to:exit.to};
  });
  if (new Set(normalized.map(exit=>exit.label)).size !== normalized.length) throw new Error('同一节点的出口条件不能重复。');
  return normalized;
}

function validate(value) {
  if (value?.structured === true) return structured.validate(value, {field, position, exitsFor});
  const title = field(value?.title, 100, '请填写工作流名称（最多 100 字）。');
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 24) throw new Error('请设置 1 到 24 个节点。');
  const ids = new Set(value.nodes.map(node => node?.id));
  if (ids.size !== value.nodes.length || [...ids].some(id => typeof id !== 'string' || !/^n[1-9]\d{0,8}$/.test(id)) || !ids.has(value.entry)) {
    throw new Error('请检查节点编号并选择起点。');
  }
  const nodes = value.nodes.map(node => {
    const title = field(node.title, 100, '请为每个节点填写名称（最多 100 字）。');
    const instruction = field(node.instruction, 4000, '请为每个节点填写任务与判断标准（最多 4000 字）。');
    if (!Number.isInteger(node.limit) || node.limit < 1 || node.limit > 50) throw new Error('每个节点的执行上限须为 1 到 50 次。');
    const exits = exitsFor(node.exits, ids, terminals);
    return {id:node.id,title,instruction,...nodeRoles.roleFields(node),
      limit:node.limit, x:position(node.x), y:position(node.y), exits};
  });
  const reachable = new Set([value.entry]);
  for (const id of reachable) {
    for (const exit of nodes.find(n=>n.id===id).exits) if (ids.has(exit.to)) reachable.add(exit.to);
  }
  if (reachable.size !== nodes.length) throw new Error('有节点无法从起点到达，请检查连线。');
  if (!nodes.some(n=>n.exits.some(exit=>terminals.has(exit.to)))) throw new Error('请至少设置一个结束出口。');
  return {title, entry:value.entry, nodes};
}

function configure(value, roles, {optionalGoal = false} = {}) {
  const template = validate(value);
  for (const node of structured.allNodes(template)) {
    if (node.kind === 'loop' || node.kind === 'context') continue;
    const candidates = nodeRoles.roleIds(node);
    if (!node.roleId || !roles.some(role=>role.enabled!==false && candidates.includes(role.id) && (!node.localOnly || role.locationId === 'local'))) {
      throw new Error('请为「'+node.title+'」选择可用的'+(node.localOnly?'本机':'项目')+'角色。');
    }
  }
  const goal = optionalGoal && typeof value.goal === 'string' && !value.goal.trim()
    ? '' : field(value.goal,16000,'请填写本次任务目标（最多 16000 字）。');
  const cursor = template.structured ? {frames:[{nodeId:template.entry,round:0}],activeSources:[]}
    : {nodeIndex:template.nodes.findIndex(n=>n.id===template.entry),visits:{}};
  return {type:'graph', ...template, ...cursor, goal, attempts:[], status:'queued', reason:'', createdAt:Date.now()};
}

function settle(flow, attempt, receipt) {
  flow.pending = null;
  const node = flow.nodes[attempt.nodeIndex];
  attempt.status = receipt?.status || 'interrupted';
  const {exit, evidence, reason} = decisionFor(node, receipt);
  if (!exit) {
    flow.status = 'needs_check';
    flow.reason = reason;
    if (flow.id && receipt?.stopConfirmed === false) flow.stopUnconfirmed = true;
    return;
  }
  attempt.outcome = exit.label;
  attempt.target = exit.to;
  attempt.evidence = evidence.slice(-4000);
  flow.visits[node.id] = (flow.visits[node.id] || 0) + 1;
  if (terminals.has(exit.to)) {
    flow.status = exit.to;
    flow.reason = exit.label;
    return;
  }
  const next = flow.nodes.findIndex(n=>n.id===exit.to);
  if ((flow.visits[exit.to] || 0) >= flow.nodes[next].limit) {
    flow.status = 'round_limit';
    flow.reason = '「'+flow.nodes[next].title+'」已达到执行上限，最后结论为「'+exit.label+'」。';
    return;
  }
  flow.nodeIndex = next;
}

function recover(chat) {
  const flow = chat.workflow;
  if (flow.structured) return structured.recover(chat);
  if (flow.status !== 'running') return;
  flow.status = 'queued';
  if (!flow.pending) return;
  const attempt = flow.attempts.find(a=>a.id===flow.pending);
  const receipt = chat.messages.find(m=>m.kind==='assistant' && m.workflowAttemptId===flow.pending);
  if (attempt) nodeRoles.settleAttempt(flow,flow.nodes[attempt.nodeIndex],attempt,receipt,(item,result)=>settle(flow,item,result));
  else { flow.pending=null; delete flow.nodeCandidateIndex; flow.status='needs_check'; flow.reason='缺少节点执行记录，请核对后重试。'; }
}

function continueReportedNode(chat) {
  const flow = chat.workflow;
  if (flow.status !== 'needs_check' || flow.stopUnconfirmed || flow.pending) return false;
  const attempt = flow.attempts.at(-1);
  if (!attempt || attempt.status !== 'complete' || attempt.outcome) return false;
  const node = flow.structured ? structured.current(flow).at(-1)?.node : flow.nodes[flow.nodeIndex];
  if (node?.exits.length !== 1) return false;
  const receipt = chat.messages.find(message=>message.kind === 'assistant' && message.workflowAttemptId === attempt.id);
  if (!decisionFor(node,receipt).exit) return false;
  Object.assign(flow,{status:'running',pending:attempt.id,reason:''});
  recover(chat);
  return true;
}

function promptFor(chat, node) {
  const flow = chat.workflow;
  const latest = new Map();
  for (const attempt of flow.attempts) {
    if (!attempt.outcome) continue;
    latest.delete(attempt.nodeIndex);
    latest.set(attempt.nodeIndex,attempt);
  }
  const entryReport = latest.get(flow.nodes.findIndex(item=>item.id===flow.entry));
  const recent = [...latest.values()].filter(attempt=>attempt!==entryReport).slice(-5);
  const reports = [entryReport,...recent].filter(Boolean).map(a=>({
    node:flow.nodes[a.nodeIndex].title,outcome:a.outcome,evidence:a.evidence.slice(-1600),
  }));
  const previous = flow.attempts.findLast(a=>a.outcome);
  const guidance = chat.messages.findLast(m=>m.kind==='user' && !m.workflowAttemptId)?.text;
  return ['Task goal: '+(flow.goal || 'Apply the current node to the conversation at workflow start.'), 'Current node: '+node.title, node.instruction,
    'Prior node reports: '+JSON.stringify(reports), previous && 'Incoming result: '+previous.evidence,
    guidance && 'Additional user guidance: '+guidance,
    'Perform this node now. Base the outcome on observed evidence. For local tests run the checks and report their commands, results or observed UI behavior. Never claim a pass for a skipped or unavailable check.',
    ...exitInstructions(node)].filter(Boolean).join('\n\n');
}

async function run(chat,{turn,save,signal}) {
  const flow=chat.workflow;
  if (flow.structured) return structured.run(chat, {turn,save,signal});
  flow.status='running'; flow.reason=''; save();
  const builder=new StateGraph(Annotation.Root({next:Annotation()}));
  const destination = () => flow.status==='running' ? flow.nodes[flow.nodeIndex].id : END;
  for (const node of flow.nodes) {
    builder.addNode(node.id, async () => {
      if (signal.aborted) { flow.status='paused'; save(); return {next:END}; }
      await nodeRoles.runAttempt(flow,node,{nodeIndex:flow.nodeIndex},promptFor(chat,node),{turn,save,signal},
        (attempt,receipt)=>settle(flow,attempt,receipt));
      return {next:destination()};
    });
  }
  builder.addConditionalEdges(START,s=>s.next);
  for (const node of flow.nodes) builder.addConditionalEdges(node.id,s=>s.next);
  await builder.compile().invoke({next:destination()}, {recursionLimit:2+flow.nodes.reduce((sum,n)=>sum+n.limit*nodeRoles.roleIds(n).length,0)});
}

const roleIds = graph => [...new Set(structured.allNodes(graph).flatMap(nodeRoles.roleIds))];

module.exports = {validate,configure,run,recover,roleIds,continueReportedNode};
