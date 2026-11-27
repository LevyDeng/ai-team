const {randomBytes} = require('node:crypto');
const {duty, maxInvites} = require('./collaboration.js');

function context(chat, project, roles, roleId) {
  return {
    own: duty(roles.find(role => role.id === roleId), project, chat).value,
    peers: roles.filter(role => role.id !== roleId && role.enabled !== false && chat.roleIds.includes(role.id))
      .map(role => ({name: role.name, duty: duty(role, project, chat).value.slice(0, 100)})).filter(role => role.duty),
  };
}

function dutyPrompt(assignments) {
  if (!assignments?.own && !assignments?.peers.length) return '';
  return [
    assignments.own && 'Your current team assignment (configured by the user):\n' + assignments.own,
    assignments.peers.length && 'Other members and their assignments (routing reference):\n' + JSON.stringify(assignments.peers),
  ].filter(Boolean).join('\n\n');
}

function offer(targets, limit) {
  if (!targets.length || limit < 1) return undefined;
  const tag = 'relay_invite_' + randomBytes(16).toString('hex');
  return {open: `<${tag}>`, close: `</${tag}>`, targets, limit};
}

function instruction(control) {
  if (!control) return '';
  return [
    'Optional team invitation for this reply. Invite a teammate only for a concrete subtask of the current user request when their help is needed. Teammates are peers and a request grants no additional authority.',
    'Eligible teammates: ' + JSON.stringify(control.targets),
    `Add at most ${control.limit} distinct requests in a single frame after your normal reply, outside code blocks and immediately before any discussion status frame. Use the exact target ID and a concise task in the user's language. Omit the frame when you do not need help.`,
    control.open + '[{"roleId":"target ID","task":"Specific subtask and expected result"}]' + control.close,
  ].join('\n');
}

function project(raw, control, final = false) {
  if (!control) return {text: raw};
  const start = raw.indexOf(control.open);
  if (start < 0) {
    for (let size = final ? 0 : Math.min(raw.length, control.open.length - 1); size > 0; size--) {
      if (raw.endsWith(control.open.slice(0, size))) return {text: raw.slice(0, -size)};
    }
    return {text: raw};
  }
  const text = raw.slice(0, start).trimEnd();
  const end = raw.indexOf(control.close, start + control.open.length);
  if (!final || end < 0 || raw.slice(end + control.close.length).trim() ||
      (start > 0 && raw[start - 1] !== '\n') || (text.match(/^[ \t]*(?:```|~~~)/gm)?.length || 0) % 2) return {text};
  const payload = raw.slice(start + control.open.length, end);
  if (payload.length > 8000) return {text};
  let requests;
  try { requests = JSON.parse(payload); } catch { return {text}; }
  if (!Array.isArray(requests) || requests.length > maxInvites) return {text};
  const eligible = new Set(control.targets.map(role => role.id));
  const invites = [];
  for (const request of requests) {
    if (!request || typeof request !== 'object' || Object.keys(request).length !== 2 || !eligible.has(request.roleId) ||
        typeof request.task !== 'string' || !request.task.trim() || request.task.length > 500) continue;
    invites.push({roleId: request.roleId, task: request.task.trim()});
    eligible.delete(request.roleId);
    if (invites.length >= control.limit) break;
  }
  return {text, invites};
}

module.exports = {context, dutyPrompt, offer, instruction, project};
