const {randomUUID} = require('node:crypto');

function futureTime(at, now = Date.now()) {
  if (!Number.isSafeInteger(at) || at <= now || at > 8.64e15) throw new Error('请选择一个未来的日期和时间。');
  return at;
}

function entry(kind, at, value) {
  return {id:randomUUID(), kind, at:futureTime(at), value};
}

function due(chats, now) {
  return chats.filter(chat => !chat.disbandedAt).flatMap(chat => (chat.scheduledTasks || [])
    .filter(task => !task.error && task.at <= now).map(task => ({chat, task})))
    .sort((a, b) => a.task.at - b.task.at);
}

function view(task) {
  const {id, kind, at, error, value} = task;
  return {id, kind, at, error, title:kind === 'message' ? value.text.slice(0, 240) : value.title || value.definition?.title,
    ...(kind === 'message' ? {files:value.files.map(file => file.name), roleIds:value.roleIds} : {})};
}

module.exports = {futureTime, entry, due, view};
