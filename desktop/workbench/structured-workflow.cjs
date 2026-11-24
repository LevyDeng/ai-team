const {randomUUID} = require('node:crypto');

const publishedStatuses = new Set(['complete', 'unresolved', 'round_limit']);
const loopEnds = ['iteration_end', 'loop_break'];

function validate(graph, {field, position, exitsFor}, depth = 0) {
  const title = field(graph?.title, 100, '请填写工作流名称（最多 100 字）。');
  if (!Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > 24) {
    throw new Error('每层画板需要 1 到 24 个节点。');
  }
  const ids = new Set(graph.nodes.map(node => node?.id));
  if (ids.size !== graph.nodes.length || [...ids].some(id => typeof id !== 'string' || !/^n[1-9]\d{0,8}$/.test(id)) || !ids.has(graph.entry)) {
    throw new Error('请检查节点编号并连接入口。');
  }
  const terminals = depth ? loopEnds : ['complete', 'unresolved'];
  const nodes = graph.nodes.map(node => {
    const base = {
      id: node.id,
      title: field(node.title, 100, '请为每个节点填写名称（最多 100 字）。'),
      x: position(node.x), y: position(node.y),
      exits: exitsFor(node.exits, ids, new Set(terminals)),
    };
    switch (node.kind) {
      case 'loop': {
        if (depth >= 3) throw new Error('循环最多可嵌套三层。');
        if (!Number.isInteger(node.rounds) || node.rounds < 1 || node.rounds > 50) {
          throw new Error('循环轮次必须在 1 到 50 之间。');
        }
        if (!['fixed', 'until'].includes(node.mode) || base.exits.length !== (node.mode === 'fixed' ? 1 : 2)) {
          throw new Error('请连接循环的全部外部出口。');
        }
        const body = validate({...node.body, title:base.title}, {field, position, exitsFor}, depth + 1);
        return {...base, kind:'loop', rounds:node.rounds, mode:node.mode, body};
      }
      case 'context':
        if (base.exits.length !== 1) throw new Error('请为群聊上文节点连接一个出口。');
        return {...base, kind:'context', sourceChatId:field(node.sourceChatId, 100, '请选择上文来源群聊。')};
      case 'role':
      case undefined:
        return {...base, kind:'role', instruction:field(node.instruction, 4000, '请为角色节点填写任务与判断标准（最多 4000 字）。'),
          roleId:typeof node.roleId === 'string' ? node.roleId : '', localOnly:node.localOnly === true};
      default: throw new Error('无法识别工作流节点类型。');
    }
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  const costs = new Map(), active = new Set();
  function cost(id) {
    if (!byId.has(id)) return 0;
    if (active.has(id)) throw new Error('同一画板不能直接连成环，请使用循环节点。');
    if (costs.has(id)) return costs.get(id);
    active.add(id);
    const node = byId.get(id);
    const result = (node.kind === 'loop' ? 1 + node.rounds * node.body.maxSteps : 1) +
      Math.max(...node.exits.map(exit => cost(exit.to)));
    active.delete(id);
    costs.set(id, result);
    return result;
  }
  const maxSteps = cost(graph.entry);
  if (costs.size !== nodes.length) throw new Error('有节点无法从入口到达，请检查连线。');
  if (maxSteps > 2000) throw new Error('工作流最多允许执行 2000 步，请减少循环轮数或节点数。');
  return {title, structured:true, entry:graph.entry, nodes, maxSteps};
}

function allNodes(graph) {
  return graph.nodes.flatMap(node => node.kind === 'loop' ? [node, ...allNodes(node.body)] : [node]);
}

function current(flow) {
  let graph = flow;
  return flow.frames.map(({nodeId, round}) => {
    const node = graph.nodes.find(item => item.id === nodeId);
    graph = node.body;
    return {node, round};
  });
}

function advance(flow, exit) {
  const {frames} = flow;
  while (loopEnds.includes(exit.to)) {
    const parent = current(flow).at(-2).node;
    const frame = frames.at(-1);
    if (exit.to === 'iteration_end' && frame.round < parent.rounds) {
      frame.nodeId = parent.body.entry;
      frame.round++;
      return;
    }
    frames.pop();
    const exhausted = exit.to === 'iteration_end' && parent.mode === 'until';
    exit = parent.exits[Number(exhausted)];
  }
  if (publishedStatuses.has(exit.to)) {
    flow.status = exit.to;
    flow.reason = exit.label;
  } else frames.at(-1).nodeId = exit.to;
}

function settle(flow, attempt, receipt, decisionFor) {
  flow.pending = null;
  attempt.status = receipt?.status || 'interrupted';
  const node = current(flow).at(-1).node;
  const decision = decisionFor(node, receipt);
  if (!decision.exit) {
    flow.status = 'needs_check';
    flow.reason = decision.reason;
    if (receipt?.stopConfirmed === false) flow.stopUnconfirmed = true;
    return;
  }
  const {exit, evidence} = decision;
  Object.assign(attempt, {outcome:exit.label, target:exit.to, evidence:evidence.slice(-4000)});
  advance(flow, exit);
}

async function run(chat, {turn, save, signal}, decisionFor) {
  const flow = chat.workflow;
  flow.status = 'running';
  flow.reason = '';
  save();
  while (flow.status === 'running' && !signal.aborted) {
    const path = current(flow), {node} = path.at(-1);
    if (node.kind === 'loop') {
      flow.frames.push({nodeId:node.body.entry, round:1});
    } else if (node.kind === 'context') {
      if (!flow.sourceSnapshots?.[node.sourceChatId]) {
        flow.status = 'needs_check';
        flow.reason = '缺少来源群聊的上下文快照。';
      } else {
        if (!flow.activeSources.includes(node.sourceChatId)) flow.activeSources.push(node.sourceChatId);
        advance(flow, node.exits[0]);
      }
    } else {
      const attempt = {id:randomUUID(), roleId:node.roleId, status:'running',
        path:path.map(({node, round}) => ({id:node.id, title:node.title, round}))};
      flow.pending = attempt.id;
      flow.attempts.push(attempt);
      save();
      const guidance = path.map(({node, round}) => node.title + (round ? ' (iteration '+round+')' : '')).join(' / ');
      const previous = flow.attempts.findLast(item => item.outcome);
      const prompt = [
        'Task goal: '+(flow.goal || 'Apply the current node to the conversation at workflow start.'),
        'Current workflow path: '+guidance, node.instruction,
        previous && 'Incoming result: '+previous.evidence,
        'Perform the current node. Use the conversation and earlier steps as context. Report evidence in the language of the task. End on a separate line with WORKFLOW: EXIT N, using the number below, or WORKFLOW: NEEDS_USER if none applies.',
        ...node.exits.map((exit, index) => (index+1)+'. '+exit.label),
      ].filter(Boolean).join('\n\n');
      let receipt;
      try { receipt = await turn(attempt, prompt, signal, node); }
      catch (error) { receipt = {status:'failed', note:error.message}; }
      if (signal.aborted && receipt?.status === 'cancelled' && receipt.stopConfirmed) {
        attempt.status = 'cancelled';
        flow.pending = null;
        flow.status = 'paused';
      } else {
        settle(flow, attempt, receipt, decisionFor);
        if (flow.status === 'needs_check' && receipt?.note && !flow.stopUnconfirmed) flow.reason += '\n'+receipt.note;
      }
    }
    if (signal.aborted && flow.status === 'running') flow.status = 'paused';
    save();
  }
  if (flow.status === 'running') {
    flow.status = 'paused';
    save();
  }
}

function recover(chat, decisionFor) {
  const flow = chat.workflow;
  if (flow.status !== 'running') return;
  flow.status = 'queued';
  if (!flow.pending) return;
  const attempt = flow.attempts.find(item => item.id === flow.pending);
  const receipt = chat.messages.find(message => message.kind === 'assistant' && message.workflowAttemptId === flow.pending);
  if (attempt) settle(flow, attempt, receipt, decisionFor);
  else {
    flow.pending = null;
    flow.status = 'needs_check';
    flow.reason = '缺少节点执行记录，请核对后重试。';
  }
}

module.exports = {validate, allNodes, current, run, recover, publishedStatuses};
