const {historyFor} = require('./conversations.cjs');
const {messageText} = require('./attachment-text.js');
const {publishedStatuses, allNodes} = require('./structured-workflow.cjs');

const activeStatuses = new Set(['queued', 'running']);
const resumableStatuses = new Set(['paused', 'needs_check', 'unavailable']);
const activeRun = chat => chat?.workflowRuns?.find(run => activeStatuses.has(run.status));
const sourceIds = graph => graph.structured
  ? [...new Set(allNodes(graph).filter(node => node.kind === 'context').map(node => node.sourceChatId))] : [];

function freeze(chat, at) {
  const visible = chat.workflow && !publishedStatuses.has(chat.workflow.status)
    ? [] : historyFor({...chat, ignoreModeratorMemory:true}, {}, true);
  const messages = visible.map(message => ({
    id:message.id, kind:message.kind, roleName:message.roleName, status:message.status, at:message.at,
    text:messageText(message), note:message.note,
  }));
  return {name:chat.name, at, messages};
}

function context(chat, flow, attemptId) {
  const external = flow.activeSources?.filter(id => id !== chat.id).flatMap(id => {
    const source = flow.sourceSnapshots[id];
    const label = '群聊上文 · '+source.name+' · '+new Date(source.at).toLocaleString('zh-CN');
    return [{kind:'assistant',status:'complete',roleName:label,text:'以下为启动时保存的群聊上文，共 '+source.messages.length+' 条。'},
      ...source.messages.map(message => ({...message,kind:'assistant',
        roleName:label+' / '+(message.kind === 'user' ? '用户' : message.roleName || '助手')}))];
  }) || [];
  const steps = chat.messages.filter(message => message.workflowRunId === flow.id &&
    (!message.workflowInstruction || message.workflowAttemptId === attemptId));
  return [...flow.baseSnapshot.messages, ...external, ...steps];
}

function publish(store, chat, flow) {
  if (flow.publishedAt || !publishedStatuses.has(flow.status)) return false;
  flow.publishedAt = Math.max(Date.now(), (chat.messages.at(-1)?.at || 0) + 1);
  const status = {complete:'已完成',unresolved:'未解决',round_limit:'已达轮次上限'}[flow.status];
  const reasons = {'All workflow steps completed.':'全部步骤已完成。','Acceptance criteria passed.':'已通过验收。',
    'Rework is still required at the shared limit.':'已达到返工上限，仍有问题待修复。'};
  const last = flow.attempts.findLast(attempt => attempt.outcome || attempt.status==='complete');
  const title = last?.path?.at(-1).title || flow.nodes?.[last?.nodeIndex]?.title || last?.roleName;
  const text = ['工作流「'+flow.title+'」'+status+'。', reasons[flow.reason]||flow.reason,
    title&&'最终步骤：'+title+'。'+(last.outcome&&last.outcome!==flow.reason?' '+last.outcome:'')].filter(Boolean).join('\n');
  const updatedAt=chat.updatedAt;
  try {
    store.message(chat.id, {kind:'assistant',roleName:'工作流结果',status:'complete',text,at:flow.publishedAt,
      workflowRunId:flow.id,workflowResult:true,workflowTitle:flow.title});
  } catch (error) {
    delete flow.publishedAt;
    const result=chat.messages.at(-1);
    if (result?.workflowResult&&result.workflowRunId===flow.id) chat.messages.pop();
    chat.updatedAt=updatedAt;
    throw error;
  }
  return true;
}

module.exports = {activeRun, resumableStatuses, sourceIds, freeze, context, publish};
