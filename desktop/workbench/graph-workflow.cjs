const { randomUUID } = require('node:crypto');
const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');

const terminals = new Set(['complete', 'unresolved']);
function field(value, max, error) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(error);
  return value.trim();
}

function validate(value) {
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
    if (!Array.isArray(node.exits) || !node.exits.length || node.exits.length > 8) throw new Error('每个节点需要 1 到 8 个出口。');
    const exits = node.exits.map(exit => {
      const label = field(exit?.label, 200, '请说明每个出口的判断条件（最多 200 字）。');
      if (!ids.has(exit.to) && !terminals.has(exit.to)) throw new Error('请为每个出口选择目标。');
      return { label, to:exit.to };
    });
    if (new Set(exits.map(exit=>exit.label)).size !== exits.length) throw new Error('同一节点的出口条件不能重复。');
    const position = v => Number.isFinite(v) ? Math.max(-10000, Math.min(10000,v)) : 0;
    return {id:node.id,title,instruction,roleId:typeof node.roleId === 'string' ? node.roleId : '',
      localOnly:node.localOnly === true, limit:node.limit, x:position(node.x), y:position(node.y), exits};
  });
  const reachable = new Set([value.entry]);
  for (const id of reachable) {
    for (const exit of nodes.find(n=>n.id===id).exits) if (ids.has(exit.to)) reachable.add(exit.to);
  }
  if (reachable.size !== nodes.length) throw new Error('有节点无法从起点到达，请检查连线。');
  if (!nodes.some(n=>n.exits.some(exit=>terminals.has(exit.to)))) throw new Error('请至少设置一个结束出口。');
  return {title, entry:value.entry, nodes};
}

function configure(value, roles) {
  const template = validate(value);
  for (const node of template.nodes) {
    const role = roles.find(r=>r.id===node.roleId);
    if (!role || (node.localOnly && role.locationId !== 'local')) throw new Error('请为「'+node.title+'」选择可用的'+(node.localOnly?'本机':'项目')+'角色。');
  }
  return {type:'graph', ...template, goal:field(value.goal,16000,'请填写本次任务目标（最多 16000 字）。'),
    nodeIndex:template.nodes.findIndex(n=>n.id===template.entry), visits:{}, attempts:[], status:'queued', reason:'', createdAt:Date.now()};
}

function settle(flow, attempt, receipt) {
  flow.pending = null;
  const node = flow.nodes[attempt.nodeIndex];
  attempt.status = receipt?.status || 'interrupted';
  if (receipt?.status !== 'complete' || receipt.warningCode === 'CLAUDE_PERMISSION_DENIED') {
    flow.status = 'needs_check';
    flow.reason = '节点未取得已确认的结果，请查看运行记录后重试。';
    return;
  }
  const lines = (receipt.text || '').trim().split(/\r?\n/);
  const signal = lines.pop()?.trim();
  const decision = /^WORKFLOW: EXIT ([1-8])$/.exec(signal);
  const exit = decision && node.exits[Number(decision[1])-1];
  const evidence = lines.join('\n').trim();
  if (!exit || !evidence) {
    flow.status = 'needs_check';
    flow.reason = signal === 'WORKFLOW: NEEDS_USER' ? '节点无法选择出口，请查看输出并补充说明。' : '结果缺少依据或有效的出口编号，请查看节点输出。';
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
  if (flow.status !== 'running') return;
  flow.status = 'queued';
  if (!flow.pending) return;
  const attempt = flow.attempts.find(a=>a.id===flow.pending);
  const receipt = chat.messages.find(m=>m.kind==='assistant' && m.workflowAttemptId===flow.pending);
  if (attempt) settle(flow,attempt,receipt);
  else { flow.pending=null; flow.status='needs_check'; flow.reason='缺少节点执行记录，请核对后重试。'; }
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
  return ['Task goal: '+flow.goal, 'Current node: '+node.title, node.instruction,
    'Prior node reports: '+JSON.stringify(reports), previous && 'Incoming result: '+previous.evidence,
    guidance && 'Additional user guidance: '+guidance,
    'Perform this node now. Base the outcome on observed evidence. For local tests run the checks and report their commands, results or observed UI behavior. Never claim a pass for a skipped or unavailable check.',
    'Select the matching numbered outcome. Give evidence in the language of the goal, then end on a separate line with WORKFLOW: EXIT N (replace N with its number). If none applies, end with WORKFLOW: NEEDS_USER.',
    ...node.exits.map((exit,i)=>(i+1)+'. '+exit.label)].filter(Boolean).join('\n\n');
}

async function run(chat,{turn,save,signal}) {
  const flow=chat.workflow;
  flow.status='running'; flow.reason=''; save();
  const builder=new StateGraph(Annotation.Root({next:Annotation()}));
  const destination = () => flow.status==='running' ? flow.nodes[flow.nodeIndex].id : END;
  for (const node of flow.nodes) {
    builder.addNode(node.id, async () => {
      if (signal.aborted) { flow.status='paused'; save(); return {next:END}; }
      const attempt={id:randomUUID(),nodeIndex:flow.nodeIndex,roleId:node.roleId,status:'running'};
      flow.pending=attempt.id; flow.attempts.push(attempt); save();
      let receipt;
      try { receipt=await turn(attempt,promptFor(chat,node),signal); }
      catch (error) { receipt={status:'failed',note:error.message}; }
      if (signal.aborted && receipt?.status==='cancelled' && receipt.stopConfirmed) {
        attempt.status='cancelled'; flow.pending=null; flow.status='paused';
      } else settle(flow,attempt,receipt);
      if (signal.aborted && flow.status==='running') flow.status='paused';
      save(); return {next:destination()};
    });
  }
  builder.addConditionalEdges(START,s=>s.next);
  for (const node of flow.nodes) builder.addConditionalEdges(node.id,s=>s.next);
  await builder.compile().invoke({next:destination()}, {recursionLimit:2+flow.nodes.reduce((sum,n)=>sum+n.limit,0)});
}

module.exports = {validate,configure,run,recover};
