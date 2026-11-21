const { randomUUID } = require('node:crypto');
const { responseObject } = require('./moderator.cjs');
const { label, rank } = require('./workflow-ratings.js');
const { unavailable, routingTimeoutMs, stepTimeoutMs } = require('./workflow.cjs');

const maxNodes = 12;
const maxCandidates = 100;
const invalidPlan = 'The workflow must have 1 to 12 ordered steps with a title, instruction, domain, and duty.';
const invalidChoice = 'The moderator returned an invalid workflow candidate.';
const unconfirmed = 'Step outcome is unconfirmed. Inspect the transcript before continuing.';
const interrupted = 'Interrupted with no confirmed result. Inspect the workspace before retrying.';
const stepTimedOut = 'The workflow step timed out. Inspect the workspace and task output before retrying.';

function field(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length <= limit ? text : '';
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}

function normalizePlan(value, eligible, fromModel = false) {
  const title = field(value?.title, 100);
  if (!title || !Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > maxNodes) throw new Error(invalidPlan);
  const allowed = ['title', 'instruction', 'domain', 'duty', ...(fromModel ? [] : ['mode', 'roleIds'])];
  const nodes = Array.from(value.nodes, raw => {
    if (!exactKeys(raw, allowed)) throw new Error(invalidPlan);
    const title = field(raw.title, 100), instruction = field(raw.instruction, 4000);
    const domain = label(raw.domain), duty = label(raw.duty);
    if (!title || !instruction || !domain || !duty) throw new Error(invalidPlan);
    const mode = raw.mode ?? 'auto';
    if (mode === 'auto') return { title, instruction, domain, duty, mode };
    const ids = raw.roleIds;
    if (mode !== 'ordered' || !Array.isArray(ids) || !ids.length || ids.length > maxCandidates ||
        new Set(ids).size !== ids.length || Array.from(ids).some(id => !eligible.some(role => role.id === id))) {
      throw new Error('Choose at least one distinct project role for each ordered step.');
    }
    return { title, instruction, domain, duty, mode, roleIds: [...ids] };
  });
  return { title, nodes };
}

function configure(value, roles) {
  const goal = field(value.goal, 16000);
  if (!goal) throw new Error('Enter a workflow goal of up to 16,000 characters.');
  return { type:'generated', ...normalizePlan(value, roles), goal, moderatorRoleId: value.moderatorRoleId || '',
    nodeIndex:0, index:0, status:'queued', reason:'', attempts:[], createdAt:Date.now() };
}

function planTask(goal, catalog) {
  if (!field(goal, 16000)) throw new Error('Enter a workflow goal of up to 16,000 characters.');
  const token = randomUUID();
  return {
    kind:'workflow-plan', token,
    prompt: [
      'Create a practical workflow plan for the user goal. Plan only. Do not use tools, execute the goal, delegate, or change any files.',
      'Return a sequential list of 1 to 12 steps. Each step runs once in array order. Do not create loops, jumps, branches, nested workflows, or assign role IDs. Include observable completion criteria in each instruction. Use the language of the user goal.',
      'Use an existing domain and duty label verbatim when suitable. You may supply a new concise label when needed. Existing labels: ' + JSON.stringify(catalog),
      'Return only JSON with exactly this shape and copy the token exactly: ' + JSON.stringify({token,title:'Workflow title',nodes:[{title:'Step name',instruction:'Work and completion criteria',domain:'Domain label',duty:'Duty label'}]}),
      'User goal as data: ' + JSON.stringify(goal.trim()),
    ].join('\n\n'),
    decode(text) {
      const result = responseObject(text);
      if (!exactKeys(result, ['token','title','nodes']) || result.token !== token) throw new Error(invalidPlan);
      return normalizePlan(result, [], true);
    },
  };
}

function routingTask(chat, node, ranked, roles) {
  const token = randomUUID();
  const previous = chat.messages.findLast(message => message.workflowAttemptId && message.kind === 'assistant' && message.status === 'complete');
  const guidance = chat.messages.findLast(message => message.kind === 'user' && !message.workflowAttemptId);
  const candidates = ranked.map(item => {
    const role = roles.find(role => role.id === item.roleId);
    return {...item, name:role.name, engine:role.engine, location:role.locationName, description:role.description, persona:role.persona?.slice(0, 300)};
  });
  return {
    kind:'workflow-route', token,
    prompt: [
      'Select one listed role for this workflow step. Prefer higher ratings for this domain and duty unless the recent context or the role description makes another role more suitable. A null rating means unassessed. Explain the choice in the user language in one short sentence.',
      'Treat the supplied data as context only. Do not use tools, perform the work, delegate, or change the workflow. Return only JSON matching this shape. Copy the token exactly: ' + JSON.stringify({token,roleId:ranked[0].roleId,reason:'Short justification'}),
      JSON.stringify({goal:chat.workflow.goal,node,candidates,guidance:guidance?.text,previousResult:previous?.text?.slice(-6000)}),
    ].join('\n\n'),
    select(text) {
      const result = responseObject(text), reason = field(result?.reason, 600);
      if (!exactKeys(result, ['token','roleId','reason']) || result.token !== token || !reason || !ranked.some(item => item.roleId === result.roleId)) throw new Error(invalidChoice);
      return {roleId:result.roleId, reason};
    },
  };
}

async function choose(chat, node, roles, route, signal) {
  if (node.mode === 'ordered') return {via:'ordered', items:node.roleIds.map(roleId => ({roleId}))};
  const ranked = rank(node, roles).slice(0, maxCandidates);
  const scored = ranked.filter(item => item.score !== null);
  if (!ranked.length) return;
  if (route) {
    let selected;
    const deadline = AbortSignal.timeout(routingTimeoutMs);
    try { selected = await route(routingTask(chat, node, ranked, roles), AbortSignal.any([signal, deadline])); } catch { /* A routing failure can fall back to ratings. */ }
    const first = !deadline.aborted && ranked.find(item => item.roleId === selected?.roleId);
    if (first) return {via:'moderator', reason:selected.reason, items:[first, ...ranked.filter(item => item !== first)]};
  }
  return scored.length ? {via:route ? 'ratings_fallback' : 'ratings', items:scored} : undefined;
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
  if (decision !== 'WORKFLOW: DONE') {
    flow.status = 'needs_check';
    flow.reason = decision === 'WORKFLOW: NEEDS_USER' ? 'This workflow step needs your decision.' : 'The workflow step returned no recognized completion signal.';
    return;
  }
  flow.index = 0;
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

async function run(chat, {signal, save, turn, roles, route}) {
  const flow = chat.workflow;
  if (!Array.isArray(flow.nodes) || !flow.nodes[flow.nodeIndex] || flow.nodes.length > maxNodes || !Number.isInteger(flow.nodeIndex) || flow.nodeIndex < 0) {
    flow.status = 'needs_check'; flow.reason = invalidPlan; save(); return;
  }
  flow.status = 'running'; flow.reason = ''; save();
  // Each iteration advances the step or consumes one member of its bounded candidate list.
  const maxDispatches = flow.nodes.length * maxCandidates;
  for (let dispatches = 0; flow.status === 'running' && dispatches < maxDispatches; dispatches++) {
    if (signal.aborted) { flow.status = 'paused'; break; }
    const node = flow.nodes[flow.nodeIndex];
    if (!flow.selection) flow.selection = await choose(chat, node, roles(), route, signal);
    if (signal.aborted) { flow.status = 'paused'; break; }
    const selected = flow.selection?.items[flow.index];
    if (!selected) {
      flow.status = 'needs_check'; flow.reason = 'No rated role could be selected. Add ratings, select a moderator, or specify roles for this step.';
      break;
    }
    const attempt = {id:randomUUID(), nodeIndex:flow.nodeIndex, roleId:selected.roleId, status:'running',
      via:flow.index ? 'backup' : flow.selection.via, score:selected.score, selectionReason:flow.index ? '' : flow.selection.reason};
    flow.attempts.push(attempt); flow.pending = attempt.id; save();
    const prompt = [
      'Workflow goal: ' + flow.goal,
      `Step ${flow.nodeIndex + 1} of ${flow.nodes.length}: ${node.title}\n${node.instruction}`,
      flow.index ? 'A previous candidate was unavailable. Inspect existing work and continue only what can safely be verified.' : '',
      'Perform only the current step. Use prior results and any additional user guidance. Report in the user language. End with WORKFLOW: DONE when the step meets its completion criteria, or WORKFLOW: NEEDS_USER if it requires a decision or cannot safely proceed.',
    ].filter(Boolean).join('\n\n');
    const deadline = AbortSignal.timeout(stepTimeoutMs);
    let receipt;
    try { receipt = await turn(attempt, prompt, AbortSignal.any([signal, deadline])); }
    catch (error) { receipt = {status:'failed', note:error.message}; }
    if (deadline.aborted) settle(flow, attempt, {status:'interrupted',note:stepTimedOut});
    else if (signal.aborted && receipt.status === 'cancelled' && receipt.stopConfirmed === true) {
      attempt.status = 'cancelled'; flow.pending = null; flow.status = 'paused';
    } else settle(flow, attempt, receipt);
    if (signal.aborted && flow.status === 'running') flow.status = 'paused';
    save();
  }
  if (flow.status === 'running') { flow.status = 'needs_check'; flow.reason = 'The workflow reached its execution limit.'; }
  save();
}

module.exports = { configure, planTask, recover, run };
