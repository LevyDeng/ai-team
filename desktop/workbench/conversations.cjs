const { effectiveRole } = require('./chat-settings.js');
function initialize(chat, roles) {
  const selected = new Set(Array.isArray(chat.defaultReplyRoleIds) ? chat.defaultReplyRoleIds : []);
  chat.defaultReplyRoleIds = chat.roleIds.filter(id => selected.has(id));
  chat.roleSettings ||= {};
  if(!Array.isArray(chat.draftAttachments))chat.draftAttachments=[];
  chat.relayReplies = chat.relayReplies !== false;
  if(!Number.isInteger(chat.maxRounds)||chat.maxRounds<1||chat.maxRounds>50)chat.maxRounds=1;
  chat.autoStop=chat.autoStop!==false;
  Object.assign(chat,require('./moderator.cjs').settings({},chat,chat.roleIds));
  for (const id of chat.roleIds) if (!chat.roleSettings[id]) {
    const role = roles.find(role => role.id === id);
    chat.roleSettings[id] = { model: role?.model || '', effort: role?.effort || '' };
  }
  return chat;
}
function historyFor(chat, role, summary = false) {
  const messages=chat.messages.filter(message => !message.moderatorTask&&['user', 'assistant','skill'].includes(message.kind) && (message.text||message.attachments?.length||message.note) && !['running','submitting','unconfirmed'].includes(message.status) &&
    (summary || chat.relayReplies !== false || message.branchContext || message.kind === 'user' || message.kind==='skill'&&(!message.callerRoleId||message.callerRoleId===role.id)||message.roleId === role.id)).map(message=>message.kind==='skill'?{...message,kind:'assistant',roleName:'Skill /'+message.command,text:[message.text,message.note].filter(Boolean).join('\n')}:message);
  return chat.ignoreModeratorMemory?messages:require('./moderator.cjs').applyMemory(chat,messages);
}
function defaultReplies(value, roleIds, previous) {
  if (value !== undefined) {
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !roleIds.includes(id)))
      throw new Error('Choose default reply roles from this chat.');
    return roleIds.filter(id => value.includes(id));
  }
  const retained = roleIds.filter(id => previous?.includes(id));
  return retained;
}
function replyRoleIds(chat) {
  const selected = defaultReplies(undefined, chat.roleIds, chat.defaultReplyRoleIds);
  return selected.length ? selected : [...chat.roleIds];
}
module.exports = { initialize, effectiveRole, historyFor, defaultReplies, replyRoleIds };
