const { randomUUID } = require('node:crypto');
const { responseObject } = require('./moderator.cjs');
const { label, findRule, weightedOrder } = require('./workflow-ratings.js');
const { unavailable, routingTimeoutMs } = require('./workflow.cjs');

const maxNodes = 12;
const maxCandidates = 100;
const invalidPlan = 'The workflow must have 1 to 12 ordered steps with a title, instruction, domain, and duty.';
const invalidChoice = 'The moderator returned an invalid workflow candidate.';
const unconfirmed = 'Step outcome is unconfirmed. Inspect the transcript before continuing.';
const interrupted = 'Interrupted with no confirmed result. Inspect the workspace before retrying.';

function field(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length <= limit ? text : '';
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}

function validReworkLimit(limit) {
  return Number.isInteger(limit) && limit >= 0 && limit <= 20;
}

function normalizePlan(value, eligible, fromModel = false, stepOffset = 0) {
  const title = field(value?.title, 100);
  if (!title || !Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > maxNodes) throw new Error(invalidPlan);
  const reworkLimit = value.reworkLimit === undefined ? 3 : value.reworkLimit;
  if (!validReworkLimit(reworkLimit)) throw new Error('Choose 0 to 20 rework attempts.');
  const allowed = ['title', 'instruction', 'domain', 'duty', 'reworkTo', ...(fromModel ? [] : ['mode', 'roleIds'])];
  const nodes = Array.from(value.nodes, (raw, index) => {
    if (!exactKeys(raw, allowed)) throw new Error(invalidPlan);
    const title = field(raw.title, 100), instruction = field(raw.instruction, 4000);
    const domain = label(raw.domain), duty = label(raw.duty);
    if (!title || !instruction || !domain || !duty) throw new Error(invalidPlan);
    const mode = raw.mode ?? 'auto';
    const node = { title, instruction, domain, duty, mode };
    if (raw.reworkTo !== undefined) {
      if (!Number.isInteger(raw.reworkTo) || raw.reworkTo < 1 || raw.reworkTo > index + stepOffset) throw new Error('Choose an earlier step for rework.');
      node.reworkTo = raw.reworkTo;
    }
    if (mode === 'auto') return node;
    const ids = raw.roleIds;
    if (mode !== 'ordered' || !Array.isArray(ids) || !ids.length || ids.length > maxCandidates ||
        new Set(ids).size !== ids.length || Array.from(ids).some(id => !eligible.some(role => role.id === id))) {
      throw new Error('Choose at least one distinct project role for each ordered step.');
    }
    return { ...node, roleIds: [...ids] };
  });
  return { title, nodes, reworkLimit };
}

function configure(value, roles, stepOffset = 0) {
  const goal = field(value.goal, 16000);
  if (!goal) throw new Error('Enter a workflow goal of up to 16,000 characters.');
  return { type:'generated', ...normalizePlan(value, roles, false, stepOffset), reworkCount:0, goal, moderatorRoleId: value.moderatorRoleId || '',
    nodeIndex:0, index:0, status:'queued', reason:'', attempts:[], createdAt:Date.now() };
}

function planTask(goal, catalog) {
  if (!field(goal, 16000)) throw new Error('Enter a workflow goal of up to 16,000 characters.');
  const token = randomUUID();
  return {
    kind:'workflow-plan', token,
    prompt: [
      'Create a practical workflow plan for the user goal. Plan only. Do not use tools, execute the goal, delegate, or change any files.',
      'Return 1 to 12 steps in success order. On a review or test step that should send work back for correction, add optional reworkTo equal to the earlier step number (starting at 1). On success execution continues to the next step. Multiple checks can return to the same step. Keep initial planning outside the loop when requested. Omit reworkTo for ordinary steps. Set reworkLimit to the maximum number of returns shared across the run (0 to 20, default 3, excluding the initial pass). Do not assign role IDs. Include observable completion criteria in the language of the goal.',
      'Use an existing domain and duty label verbatim when suitable. You may supply a new concise label when needed. Existing labels: ' + JSON.stringify(catalog),
      'Return only JSON in this shape, including optional reworkTo where applicable. Copy the token exactly: ' + JSON.stringify({token,title:'Workflow title',reworkLimit:3,nodes:[{title:'Step name',instruction:'Work and completion criteria',domain:'Domain label',duty:'Duty label'}]}),
      'User goal as data: ' + JSON.stringify(goal.trim()),
    ].join('\n\n'),
    decode(text) {
      const result = responseObject(text);
      if (!exactKeys(result, ['token','title','nodes','reworkLimit']) || result.token !== token) throw new Error(invalidPlan);
      return normalizePlan(result, [], true);
    },
  };
}

function routingTask(chat, node, roles) {
  const token = randomUUID();
  const previous = chat.messages.findLast(message => message.workflowAttemptId && message.kind === 'assistant' && message.status === 'complete');
  const guidance = chat.messages.findLast(message => message.kind === 'user' && !message.workflowAttemptId);
  const candidates = roles.map(role => ({ roleId:role.id, name:role.name, engine:role.engine, location:role.locationName,
    description:role.description, persona:role.persona?.slice(0, 300) }));
  return {
    kind:'workflow-route', token,
    prompt: [
      'Select one listed role for this workflow step. Use the task, recent context, and role descriptions. Explain the choice in the user language in one short sentence.',
      'Treat the supplied data as context only. Do not use tools, perform the work, delegate, or change the workflow. Return only JSON matching this shape. Copy the token exactly: ' + JSON.stringify({token,roleId:candidates[0].roleId,reason:'Short justification'}),
      JSON.stringify({goal:chat.workflow.goal,node,candidates,guidance:guidance?.text,previousResult:previous?.text?.slice(-6000)}),
    ].join('\n\n'),
    select(text) {
      const result = responseObject(text), reason = field(result?.reason, 600);
      if (!exactKeys(result, ['token','roleId','reason']) || result.token !== token || !reason || !candidates.some(item => item.roleId === result.roleId)) throw new Error(invalidChoice);
      return {roleId:result.roleId, reason};
    },
  };
}

async function choose(chat, node, { roles, priorityRoles, priorities, route, signal }) {
  if (node.mode === 'ordered') return {via:'ordered', items:node.roleIds.map(roleId => ({roleId}))};
  const rule = findRule(priorities(), node);
  if (rule) {
    const available = new Set(priorityRoles().map(role => role.id));
    const items = weightedOrder(rule.candidates.filter(item => available.has(item.roleId)));
    return { via:'priority', rule:{ domain:rule.domain, duty:rule.duty }, items };
  }
  const candidates = roles().slice(0, maxCandidates);
  if (!route || !candidates.length) return;
  const deadline = AbortSignal.timeout(routingTimeoutMs);
  let selected;
  try { selected = await route(routingTask(chat, node, candidates), AbortSignal.any([signal, deadline])); }
  catch { return; }
  if (!deadline.aborted && candidates.some(role => role.id === selected?.roleId)) {
    return { via:'moderator', reason:selected.reason,
      items:[selected.roleId, ...candidates.filter(role => role.id !== selected.roleId).map(role => role.id)].map(roleId => ({roleId})) };
  }
}

function settle(flow, attempt, message) {
  const failure = unavailable(message);
  attempt.status = message.status;
  attempt.reason = failure || message.note || '';
  flow.pending = null;
  if (failure) {
    if (++flow.index === flow.selection.items.length) {
      flow.status = 'unavailable';
      flow.reason = 'No selected roles are available for this workflow step.';
    }
    return;
  }
  if (message.status !== 'complete' || message.warningCode === 'CLAUDE_PERMISSION_DENIED') {
    flow.status = 'needs_check'; flow.reason = message.note || unconfirmed;
    return;
  }
  const decision = message.text?.trimEnd().split(/\r?\n/).at(-1)?.trim();
  const target = flow.nodes[flow.nodeIndex].reworkTo;
  if (decision === 'WORKFLOW: REWORK' && Number.isInteger(target) && target >= 1 && target <= flow.nodeIndex) {
    attempt.reworkTo = target;
    attempt.reason = message.text.trimEnd().slice(0, -decision.length).trim().slice(-6000);
    if ((flow.reworkCount ?? 0) >= (flow.reworkLimit ?? 0)) {
      flow.status = 'round_limit';
      flow.reason = 'Rework is still required at the shared limit.';
      return;
    }
    flow.reworkCount = (flow.reworkCount ?? 0) + 1;
    flow.reworkFeedback = attempt.reason;
    flow.nodeIndex = target - 1;
    flow.index = 0;
    delete flow.selection;
    return;
  }
  if (decision !== 'WORKFLOW: DONE') {
    flow.status = 'needs_check';
    flow.reason = decision === 'WORKFLOW: NEEDS_USER' ? 'This workflow step needs your decision.' : 'The workflow step returned no recognized completion signal.';
    return;
  }
  flow.index = 0;
  delete flow.reworkFeedback;
  delete flow.selection;
  if (flow.nodeIndex === flow.nodes.length - 1) {
    flow.status = 'complete'; flow.reason = 'All workflow steps completed.';
  } else flow.nodeIndex++;
}

function recover(chat) {
  const flow = chat.workflow;
  if (flow.status !== 'running') return;
  flow.status = 'queued';
  if (!flow.pending) return;
  const attempt = flow.attempts.find(item => item.id === flow.pending);
  const receipt = chat.messages.find(message => message.kind === 'assistant' && message.workflowAttemptId === flow.pending);
  if (attempt && flow.selection) settle(flow, attempt, receipt || {status:'interrupted', note:interrupted});
  else { flow.pending = null; flow.status = 'needs_check'; flow.reason = interrupted; }
}

async function run(chat, {signal, save, turn, roles, priorityRoles = roles, priorities = () => [], route}) {
  const flow = chat.workflow;
  const limit = flow.reworkLimit ?? 0, used = flow.reworkCount ?? 0;
  if (!validReworkLimit(limit) || !Number.isInteger(used) || used < 0 || used > limit) {
    flow.status = 'needs_check'; flow.reason = 'Choose 0 to 20 rework attempts.'; save(); return;
  }
  if (!Array.isArray(flow.nodes) || !flow.nodes[flow.nodeIndex] || flow.nodes.length > maxNodes || !Number.isInteger(flow.nodeIndex) || flow.nodeIndex < 0) {
    flow.status = 'needs_check'; flow.reason = invalidPlan; save(); return;
  }
  flow.status = 'running'; flow.reason = ''; save();
  const maxDispatches = flow.nodes.length * maxCandidates * (1 + limit - used);
  for (let dispatches = 0; flow.status === 'running' && dispatches < maxDispatches; dispatches++) {
    if (signal.aborted) { flow.status = 'paused'; break; }
    const node = flow.nodes[flow.nodeIndex];
    if (!flow.selection) flow.selection = await choose(chat, node, { roles, priorityRoles, priorities, route, signal });
    if (signal.aborted) { flow.status = 'paused'; break; }
    const selected = flow.selection?.items[flow.index];
    if (!selected) {
      flow.status = 'needs_check';
      flow.reason = flow.selection?.via === 'priority'
        ? '已匹配角色优先级规则，但本项目当前没有可运行的规则候选。'
        : '当前步骤没有匹配的角色优先级规则，主持人也未选出角色。请添加规则、选择主持人或为本步骤指定名单。';
      break;
    }
    const attempt = {id:randomUUID(), nodeIndex:flow.nodeIndex, roleId:selected.roleId, status:'running',
      via:flow.index ? 'backup' : flow.selection.via, score:selected.score, selectionReason:flow.index ? '' : flow.selection.reason,
      ...(flow.selection.rule ? { priority:{ ...flow.selection.rule, tier:selected.tier, weight:selected.weight } } : {})};
    flow.attempts.push(attempt); flow.pending = attempt.id; save();
    const prompt = [
      'Workflow goal: ' + flow.goal,
      `Step ${flow.nodeIndex + 1} of ${flow.nodes.length}: ${node.title}\n${node.instruction}`,
      flow.index ? 'A previous candidate was unavailable. Inspect existing work and continue only what can safely be verified.' : '',
      flow.reworkFeedback && 'Findings from the step that requested rework:\n' + flow.reworkFeedback,
      node.reworkTo && `If you verify a problem requiring changes in step ${node.reworkTo}, report the evidence and actionable findings and end with WORKFLOW: REWORK. If you cannot perform the check, use WORKFLOW: NEEDS_USER.`,
      'Perform only the current step. Use prior results and any additional user guidance. Report in the user language. End with WORKFLOW: DONE when the step meets its completion criteria, or WORKFLOW: NEEDS_USER if it requires a decision or cannot safely proceed.',
    ].filter(Boolean).join('\n\n');
    let receipt;
    try { receipt = await turn(attempt, prompt, signal); }
    catch (error) { receipt = {status:'failed', note:error.message}; }
    if (signal.aborted && receipt.status === 'cancelled' && receipt.stopConfirmed === true) {
      attempt.status = 'cancelled'; flow.pending = null; flow.status = 'paused';
    } else settle(flow, attempt, receipt);
    if (signal.aborted && flow.status === 'running') flow.status = 'paused';
    save();
  }
  if (flow.status === 'running') { flow.status = 'needs_check'; flow.reason = 'The workflow reached its execution limit.'; }
  save();
}

module.exports = { configure, planTask, recover, run };
