const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { settings: proxySettings } = require('./proxy.cjs');
const conversations = require('./conversations.cjs');
const {isVendor}=require('./vendor-agents.cjs');
const {engine:geminiWebEngine}=require('./gemini-web.cjs');
const id = () => crypto.randomUUID();
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + id();
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function text(value, limit = 200) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
class Store {
  constructor(directory, root) {
    this.directory = directory;
    this.file = path.join(directory, 'workspace.json');
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    else {
      let old; try { old = JSON.parse(fs.readFileSync(path.join(root, '.runtime/desktop/state.json'), 'utf8')); } catch {}
      let connection; try { connection = require('../config.cjs').connectionSettings(root); } catch {}
      const remote = connection ? { id: 'relay-server', name: 'Relay VPS', type: 'ssh', os: 'linux', control: 'ssh', managed: true,
        host: connection.target.split('@')[1], username: connection.target.split('@')[0], port: connection.sshPort, keyPath: connection.keyPath } : null;
      const roles = [
        { id: id(), name: '铃音', avatar: 0, description: '开发搭档', persona: '', examples: '', engine: 'codex', provider: 'native', locationId: 'local', model: '', effort: 'medium', permission: 'workspace-write', executable: '' },
        { id: id(), name: '代码专家', avatar: 1, description: '代码审查与实现', persona: '', examples: '', engine: 'claude', provider: 'native', locationId: remote?.id || 'local', model: '', effort: '', permission: 'acceptEdits', executable: '' },
        { id: id(), name: '游戏顾问', avatar: 2, description: '玩法与系统讨论', persona: '', examples: '', engine: 'codex', provider: 'native', locationId: 'local', model: '', effort: 'medium', permission: 'workspace-write', executable: '' },
      ];
      const projects = (old?.projects || []).map(p => ({ id: p.id, name: p.name, roleIds: roles.map(r => r.id), directories: (p.locations || [{ kind: 'local', path: p.localPath }, { kind: 'remote', path: p.path }]).filter(d => d.path && (d.kind === 'local' || remote)).map(d => ({ locationId: d.kind === 'local' ? 'local' : remote.id, path: d.path })), legacy: true }));
      if (!projects.length) projects.push({ id: id(), name: '我的项目', roleIds: roles.map(r => r.id), directories: [{ locationId: 'local', path: root }] });
      this.state = { version: 1, projects, roles, locations: [{ id: 'local', name: '本机', type: 'local', os: 'windows', control: 'ssh' }, ...(remote ? [remote] : [])], chats: [], settings: { keepAwake: true, maxJobs: 3 } };
      this.save();
    }
    if (!['light', 'dark', 'system'].includes(this.state.settings.theme)) this.state.settings.theme = 'system';
    for (const chat of this.state.chats) {
      if(chat.nativeSessions)for(const record of Object.values(chat.nativeSessions))if(record.status==='submitting')record.status='uncertain';
      conversations.initialize(chat, this.state.roles);
      require('./input-queue.cjs').initialize(chat);
      for (const message of chat.messages) if (message.status === 'running' && (!chat.localTask || message.localTaskId !== chat.localTask.id)) { message.status = 'interrupted'; message.note = 'App closed before completion. The partial response is preserved.'; }
      for (const message of chat.messages) if (message.status === 'submitting') { message.status='unconfirmed';message.note='CLI submission was not confirmed. Restore this message to retry.'; }
    }
    this.save();
  }
  save() { clearTimeout(this.saveTimer); this.saveTimer = null; atomic(this.file, this.state); }
  scheduleSave() { if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 700); }
  snapshot() { return structuredClone(this.state); }
  get(kind, value) {
    const item = this.state[kind]?.find(x => x.id === value);
    if (!item) throw new Error('The selected item no longer exists.');
    return item;
  }
  saveRole(value) {
    const previous = value.id ? this.get('roles', value.id) : { id: id() };
    const isGeminiWeb = value.engine === geminiWebEngine;
    if (!['codex', 'claude', 'opencode', geminiWebEngine].includes(value.engine) && !isVendor(value.engine)) throw new Error('Choose a supported agent.');
    if (!['native', 'openai', 'gemini', 'deepseek','moonshot'].includes(value.provider)) throw new Error('Choose a supported provider.');
    if (value.provider !== 'native' && value.engine !== 'codex') throw new Error('API providers currently use the Codex adapter.');
    const location = this.get('locations', value.locationId);
    if(isGeminiWeb && location.id !== 'local') throw new Error('Gemini Web uses the local browser.');
    if(isVendor(value.engine) && location.type!=='local')throw new Error('These official account agent adapters currently run on the local machine.');
    if (value.provider !== 'native' && location.type !== 'local') throw new Error('API providers currently run locally. Native agents support SSH.');
    if (!text(value.name)) throw new Error('Enter a role name.');
    const permission = value.permission || (previous.engine === value.engine && (['codex','claude'].includes(previous.engine) || isVendor(previous.engine)) ? previous.permission : '') || 'workspace-write';
    const allowedPermissions=value.engine==='claude'?['read-only','workspace-write','danger-full-access','acceptEdits']:['read-only','workspace-write','danger-full-access'];
    if ((['codex','claude'].includes(value.engine) || isVendor(value.engine)) && !allowedPermissions.includes(permission)) throw new Error('Choose a supported agent permission mode.');
    const avatarId = value.avatarId === undefined ? (previous.avatarId || '') : value.avatarId;
    if (typeof avatarId !== 'string' || (avatarId && !/^(?:[a-f0-9]{32}|preset-[a-z0-9-]{1,40})$/.test(avatarId))) throw new Error('Choose a valid local avatar.');
    const next = { ...previous, name: text(value.name, 60), description: text(value.description), avatar: Math.max(0, Math.min(2, Number(value.avatar) || 0)), persona: text(value.persona, 30000), examples: text(value.examples, 30000), engine: value.engine, provider: value.provider, locationId: location.id, model: text(value.model), effort: text(value.effort, 20), executable: text(value.executable, 2000), baseUrl: text(value.baseUrl, 2000), permission: value.engine === 'codex' ? permission : 'acceptEdits' };
    if(value.engine==='claude'||isVendor(value.engine))next.permission=permission;
    if(['kimi','cursor'].includes(value.engine))next.effort='';
    next.allowLocationTools = value.allowLocationTools !== false;
    if (value.workflowRatings !== undefined) next.workflowRatings = require('./workflow-ratings.js').normalize(value.workflowRatings);
    if(isGeminiWeb) Object.assign(next, {model:'', effort:'', executable:'', baseUrl:'', permission:'read-only', allowLocationTools:false});
    next.avatarId = avatarId;
    next.proxyMode = value.proxyMode ?? previous.proxyMode ?? 'inherit';
    if (!['inherit', 'direct', 'proxy'].includes(next.proxyMode)) throw new Error('Choose a supported role proxy mode.');
    const supportsDesktopLogin = next.engine === 'codex' && next.provider === 'native' && location.type === 'local';
    const source = value.codexLoginSource ?? (supportsDesktopLogin ? previous.codexLoginSource : 'isolated') ?? 'isolated';
    if (!['isolated','desktop'].includes(source) || (source === 'desktop' && !supportsDesktopLogin)) throw new Error('Desktop login reuse requires a local native Codex role.');
    next.codexLoginSource = source;
    const desktopTools=value.codexDesktopTools??previous.codexDesktopTools??true;
    if(typeof desktopTools!=='boolean')throw new Error('Choose whether to inherit desktop MCP servers and plugins.');
    next.codexDesktopTools=desktopTools;
    if (next.baseUrl) { const u = new URL(next.baseUrl); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('Use an HTTPS API base URL without credentials.'); }
    const index = this.state.roles.findIndex(r => r.id === next.id);
    if (index < 0) this.state.roles.push(next); else this.state.roles[index] = next;
    this.save(); return next;
  }
  saveLocation(value) {
    if (value.id === 'local') throw new Error('The built-in local location cannot be edited.');
    const previous = value.id ? this.get('locations', value.id) : { id: id() };
    if (!text(value.name) || !/^[a-zA-Z0-9._:-]+$/.test(value.host || '') || !/^[a-zA-Z0-9._-]+$/.test(value.username || '') || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('Enter a name, SSH host, user, and valid port.');
    if (!['ssh', 'windows-mcp'].includes(value.control) || !['linux', 'windows'].includes(value.os)) throw new Error('Choose the operating system and control method.');
    if (value.control === 'windows-mcp' && value.os !== 'windows') throw new Error('Windows-MCP requires a Windows desktop location.');
    const next = { ...previous, name: text(value.name, 60), type: 'ssh', host: value.host, username: value.username, port: value.port, keyPath: text(value.keyPath, 2000), os: value.os, control: value.control, mcpUrl: text(value.mcpUrl, 2000) };
    if (next.control === 'windows-mcp') {
      const u = new URL(next.mcpUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Enter the Windows-MCP HTTP endpoint without embedded credentials.');
    }
    // A managed location is bound to the original .env, never silently retarget it.
    if (previous.managed && ['host', 'username', 'port', 'keyPath'].some(k => next[k] !== previous[k])) throw new Error('Edit the original Relay server connection from the classic interface. Add a new location for another server.');
    const index = this.state.locations.findIndex(l => l.id === next.id);
    next.proxy = proxySettings(value.proxy ?? previous.proxy);
    if (index < 0) this.state.locations.push(next); else this.state.locations[index] = next;
    this.save(); return next;
  }
  saveLocationProxy(id, value) { const location = this.get('locations', id); location.proxy = proxySettings(value); this.save(); return location; }
  saveProject(value) {
    const previous = value.id ? this.get('projects', value.id) : { id: id() };
    const name = text(value.name, 100);
    if (!name || /[()（）]/.test(name)) throw new Error('Project names cannot contain parentheses.');
    if (!Array.isArray(value.directories) || !value.directories.length || value.directories.length > 12) throw new Error('Configure between 1 and 12 directories.');
    const directories = value.directories.map(d => {
      const location = this.get('locations', d.locationId); const folder = text(d.path, 2000);
      if (!folder || /[\0\r\n]/.test(folder) || (location.type === 'local' && !path.isAbsolute(folder)) || (location.os === 'linux' && !/^(?:\/|~\/)/.test(folder))) throw new Error('Enter an absolute project directory for each location.');
      return { locationId: location.id, path: folder };
    });
    const next = { ...previous, name, directories, roleIds: [...new Set(value.roleIds || [])].filter(r => this.state.roles.some(x => x.id === r)) };
    const index = this.state.projects.findIndex(p => p.id === next.id);
    if (index < 0) this.state.projects.push(next); else this.state.projects[index] = next;
    this.save(); return next;
  }
  createChat(value, seed = {}) {
    const project = this.get('projects', value.projectId);
    const roleIds = this.chatRoles(value.roleIds);
    const defaultReplyRoleIds = conversations.defaultReplies(value.defaultReplyRoleIds, roleIds);
    const chat = { id: id(), projectId: project.id, name: text(value.name, 100) || (roleIds.length > 1 ? '项目讨论组' : this.get('roles', roleIds[0]).name), roleIds, ...require('./moderator.cjs').settings(value,null,roleIds), messages: [], draft: '', unread: false, updatedAt: Date.now() };
    chat.defaultReplyRoleIds = defaultReplyRoleIds;
    Object.assign(chat, seed);
    conversations.initialize(chat, this.state.roles);
    project.roleIds = [...new Set([...project.roleIds, ...roleIds])];
    this.state.chats.unshift(chat); this.save(); return chat;
  }
  chatRoles(values) {
    if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => typeof value !== 'string' || !this.state.roles.some(role => role.id === value))) throw new Error('Choose at least one existing role.');
    return [...new Set(values)];
  }
  saveChat(value) {
    const chat = this.get('chats', value.id);
    const project = this.get('projects', chat.projectId);
    const roleIds = this.chatRoles(value.roleIds);
    const defaultReplyRoleIds = conversations.defaultReplies(value.defaultReplyRoleIds, roleIds, chat.defaultReplyRoleIds);
    const moderation=require('./moderator.cjs').settings(value,chat,roleIds);
    if(moderation.moderatorRoleId!==chat.moderatorRoleId)delete chat.moderatorMemory;
    Object.assign(chat,moderation);
    chat.name = text(value.name, 100) || chat.name;
    chat.roleIds = roleIds;
    chat.defaultReplyRoleIds = defaultReplyRoleIds;
    conversations.initialize(chat, this.state.roles);
    project.roleIds = [...new Set([...project.roleIds, ...roleIds])];
    this.save(); return chat;
  }
  message(chatId, value) {
    const chat = this.get('chats', chatId); const message = { id: id(), at: Date.now(), ...value };
    chat.messages.push(message); chat.updatedAt = message.at; this.save(); return message;
  }
  saveChatRole(chatId, roleId, value) {
    const chat = this.get('chats', chatId);
    if (!chat.roleIds.includes(roleId)) throw new Error('Choose a participant in this chat.');
    if (typeof value.model !== 'string' || value.model.length > 200 || /[\0\r\n]/.test(value.model) || typeof value.effort !== 'string' || !/^(?:[a-z][a-z0-9_-]{0,31})?$/.test(value.effort)) throw new Error('Enter a valid model and effort.');
    conversations.initialize(chat, this.state.roles);
    chat.roleSettings[roleId] = { model: value.model.trim(), effort: value.effort };
    this.save(); return chat;
  }
  saveChatFlow(chatId, relayReplies) {
    if (typeof relayReplies !== 'boolean') throw new Error('Choose a conversation flow.');
    const chat = this.get('chats', chatId); chat.relayReplies = relayReplies; this.save(); return chat;
  }
  saveChatDiscussion(chatId,value){
    const maxRounds=require('./discussion.cjs').limit(value.maxRounds);if(typeof value.autoStop!=='boolean')throw new Error('Choose whether AI may end the discussion early.');
    const chat=this.get('chats',chatId);chat.maxRounds=maxRounds;chat.autoStop=value.autoStop;this.save();return chat;
  }
  saveChatOrder(chatId, roleIds) {
    const chat = this.get('chats', chatId);
    if (!Array.isArray(roleIds) || roleIds.length !== chat.roleIds.length || new Set(roleIds).size !== roleIds.length || roleIds.some(id => !chat.roleIds.includes(id))) throw new Error('Reorder existing participants only.');
    chat.roleIds = [...roleIds]; this.save(); return chat;
  }
}
module.exports = { Store, atomic, id };
