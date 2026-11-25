const {randomUUID} = require('node:crypto');
const {backupHandover, unavailable} = require('./workflow.cjs');

const roleIds = node => [node.roleId, ...(node.backupRoleIds || [])].filter(Boolean);

function roleFields(node) {
  const roleId = typeof node.roleId === 'string' ? node.roleId : '';
  const backupRoleIds = node.backupRoleIds ?? [];
  if (!Array.isArray(backupRoleIds) || backupRoleIds.length > 99 ||
      backupRoleIds.some(id => typeof id !== 'string' || !id.trim() || id === roleId) ||
      new Set(backupRoleIds).size !== backupRoleIds.length) {
    throw new Error('请为节点选择互不重复的执行角色和替补角色（最多 99 位替补）。');
  }
  return {roleId, localOnly:node.localOnly === true, ...(backupRoleIds.length ? {backupRoleIds:[...backupRoleIds]} : {})};
}

function settleAttempt(flow, node, attempt, receipt, settle, allowFallback = true) {
  const stoppingUnconfirmed = receipt?.stopConfirmed === false ||
    ['REMOTE_STOP_UNCONFIRMED','CLI_SHUTDOWN_STALLED'].includes(receipt?.errorCode);
  const failure = allowFallback && node.backupRoleIds?.length && receipt && !stoppingUnconfirmed && unavailable(receipt);
  if (failure) {
    attempt.status = receipt.status;
    attempt.reason = failure;
    flow.pending = null;
    const next = (flow.nodeCandidateIndex ?? 0) + 1;
    if (next < roleIds(node).length) flow.nodeCandidateIndex = next;
    else {
      delete flow.nodeCandidateIndex;
      flow.status = 'unavailable';
      flow.reason = '「'+node.title+'」的执行角色和替补角色均不可用，请检查角色后重试。';
    }
    return;
  }
  delete flow.nodeCandidateIndex;
  settle(attempt, receipt);
}

async function runAttempt(flow, node, fields, prompt, {turn, save, signal}, settle) {
  const index = flow.nodeCandidateIndex ?? 0;
  const attempt = {id:randomUUID(), ...fields, roleId:roleIds(node)[index], status:'running'};
  flow.pending = attempt.id;
  flow.attempts.push(attempt);
  save();
  let receipt;
  try { receipt = await turn(attempt, index ? backupHandover+'\n\n'+prompt : prompt, signal, node); }
  catch (error) { receipt = {status:'failed', note:error.message, errorCode:error.code}; }
  if (signal.aborted && receipt?.status === 'cancelled' && receipt.stopConfirmed) {
    attempt.status = 'cancelled';
    flow.pending = null;
    flow.status = 'paused';
  } else settleAttempt(flow, node, attempt, receipt, settle, !signal.aborted);
  if (signal.aborted && flow.status === 'running') flow.status = 'paused';
  save();
}

module.exports = {roleIds, roleFields, settleAttempt, runAttempt};
