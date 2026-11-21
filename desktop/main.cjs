const { app, BrowserWindow, ipcMain, Menu, shell, dialog, clipboard, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Backend } = require('./backend.cjs');
const { selection, validateSelection } = require('./models.cjs');
const { KeepAwake } = require('./keep-awake.cjs');
const { connectionSettings, saveConnectionSettings } = require('./config.cjs');
const { ClipboardImages, readClipboardImage } = require('./clipboard-images.cjs');
const { MessageOutbox } = require('./message-outbox.cjs');
const { localRoot, resolveProjectPath } = require('./project-paths.cjs');
const { ProjectTerminals, validateLocations, projectFiles } = require('./project-tools.cjs');
const root = path.resolve(__dirname, '..');
const smokeMode = process.argv.includes('--smoke-test');
require('./windows-launch.cjs').configureWindowsLaunch(app,{root,classic:true,disabled:smokeMode});
const dataDir = path.join(root, '.runtime', 'desktop');
const stateFile = path.join(dataDir, 'state.json');
const unreadFile = path.join(dataDir, 'unread.json');
const historyDir = path.join(dataDir, 'history');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(historyDir, { recursive: true });
const outbox = new MessageOutbox(path.join(dataDir, 'outgoing'));
app.setPath('userData', path.join(dataDir, smokeMode ? 'smoke-browser' : 'browser'));
const backend = new Backend(root);
const projectTerminals = new ProjectTerminals(backend, (event) => broadcast('project-terminal', event));
const stagedFilesByWindow = new Map();
const clipboardImages = new ClipboardImages(path.join(dataDir, 'clipboard-images'));
clipboardImages.prepare();
const unreadSessions = new Map();
const unreadRevisions = new Map();
const historyRefreshes = new Map();
const sessionChanges = new Set();
const deletingProjects = new Set();
const sendingSessions = new Set();
let settingsApplying = false;
let quitting = false;
let quitReady = false;
const maxFiles = 8;
const maxFileBytes = 16 * 1024 * 1024;
const maxBatchBytes = 32 * 1024 * 1024;
let state;
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = null; }
if (!state || !Array.isArray(state.projects) || !Array.isArray(state.sessions)) state = { projects: [{ id: crypto.randomUUID(), name: '个人工作区', path: '~/claude-workspace' }], sessions: [] };
for (const project of state.projects) if (project.name === 'Personal workspace') project.name = '个人工作区';
for (const session of state.sessions) {
  session.name = session.name.replace(/^Conversation (\d+)$/, '对话 $1');
  if (!['claude', 'codex'].includes(session.provider)) session.provider = 'claude';
  try { Object.assign(session, selection(session)); } catch { session.model = ''; session.effort = ''; }
}
state.assistantDefaults ||= {};
if (!Array.isArray(state.projectArchive)) state.projectArchive = [];
backend.forceControl = state.forceControl === true;
for (const provider of ['claude', 'codex']) {
  try { state.assistantDefaults[provider] = selection(state.assistantDefaults[provider]); }
  catch { state.assistantDefaults[provider] = { model: '', effort: '' }; }
}
try {
  const savedUnread = JSON.parse(fs.readFileSync(unreadFile, 'utf8'));
  for (const session of state.sessions) {
    const count = savedUnread[session.id];
    if (Number.isInteger(count) && count > 0) { unreadSessions.set(session.id, Math.min(count, 99)); unreadRevisions.set(session.id, crypto.randomUUID()); }
  }
} catch {}
function saveUnread() {
  const temporary = `${unreadFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(unreadSessions)));
  fs.renameSync(temporary, unreadFile);
}
const save = () => { const temp = stateFile + '.tmp'; fs.writeFileSync(temp, JSON.stringify(state, null, 2)); fs.renameSync(temp, stateFile); backend.setKnownSessions(state.sessions); broadcast('workspace', state); };
backend.setKnownSessions(state.sessions);
function broadcast(channel, payload) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('relay:' + channel, payload); }
const keepAwake = new KeepAwake(root, { enabled: (state.keepAwake ?? state.keepAwakeForeground) !== false, disabled: smokeMode, changed: (value) => broadcast('keep-awake', value), log: (value) => backend.log(value) });
backend.on('status', (value) => broadcast('status', value));
backend.on('log', (value) => broadcast('log', value));
backend.on('monitor', (value) => broadcast('monitor', value));
backend.on('session-connections', (value) => broadcast('session-connections', value));
for (const event of ['data', 'ended', 'capacity']) backend.on(event, (value) => { const window = BrowserWindow.fromId(value.owner); if (window && !window.isDestroyed()) window.webContents.send('relay:' + event, value); });
function describeCapacity(value, ownerId) {
  return { ...value, active: value.active.map((entry) => {
    const archived = state.projectArchive.find((record) => record.sessions.some((item) => item.id === entry.id && item.provider === entry.provider));
    const session = state.sessions.find((item) => item.id === entry.id && item.provider === entry.provider) || archived?.sessions.find((item) => item.id === entry.id && item.provider === entry.provider);
    const project = state.projects.find((item) => item.id === session?.projectId) || archived?.project;
    const channelOwner = backend.channels.get(entry.id)?.owner;
    return { ...entry, name: session?.name || `远端对话 ${entry.id.slice(0, 8)}`, projectName: project?.name || entry.projectPath || '其他项目',
      otherWindow: Boolean(channelOwner && channelOwner !== ownerId) };
  }) };
}
backend.on('capacity-check', async ({ id, owner }) => {
  const client = backend.client;
  const session = state.sessions.find((entry) => entry.id === id);
  if (!client || !session) return;
  try {
    const capacity = await backend.activeSessions(id, session.provider);
    const window = BrowserWindow.fromId(owner);
    if (client === backend.client && !capacity.available && window && !window.isDestroyed()) window.webContents.send('relay:capacity', { id, capacity: describeCapacity(capacity, owner) });
  } catch {}
});
function updateUnread() {
  const count = [...unreadSessions.values()].reduce((total, value) => total + value, 0);
  const icon = count ? nativeImage.createFromPath(path.join(__dirname, 'assets', `badge-${Math.min(count, 9)}.png`)) : null;
  for (const window of BrowserWindow.getAllWindows()) {
    if (process.platform === 'win32') window.setOverlayIcon(icon, count ? `${count} completed conversations` : '');
    window.webContents.send('relay:unread', { counts: Object.fromEntries(unreadSessions), revisions: Object.fromEntries(unreadRevisions) });
  }
}
backend.on('completed', ({ id }) => {
  if (!state.sessions.some((session) => session.id === id)) return;
  unreadSessions.set(id, Math.min((unreadSessions.get(id) || 0) + 1, 99));
  unreadRevisions.set(id, crypto.randomUUID());
  saveUnread();
  shell.beep();
  updateUnread();
  broadcast('completed', { id });
});
function owner(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  const url = event.senderFrame?.url || '';
  if (!window || url !== require('node:url').pathToFileURL(path.join(__dirname, 'index.html')).href) throw new Error('Untrusted window.');
  return window.id;
}
function handle(name, fn) { ipcMain.handle('relay:' + name, async (event, ...args) => { const id = owner(event); if (quitting) throw new Error('Relay Desk is closing.'); return fn(id, ...args); }); }
handle('snapshot', () => ({ workspace: state, status: backend.snapshot(), unread: Object.fromEntries(unreadSessions), unreadRevisions: Object.fromEntries(unreadRevisions), keepAwake: keepAwake.snapshot() }));
handle('keep-awake', (_id, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Invalid keep-awake setting.');
  state.keepAwake = enabled;
  delete state.keepAwakeForeground;
  save();
  keepAwake.setEnabled(enabled);
  return keepAwake.snapshot();
});
handle('connect', (_id, passphrase) => backend.connect(typeof passphrase === 'string' ? passphrase : ''));
handle('disconnect', () => backend.stop());
handle('settings-get', () => connectionSettings(root));
handle('settings-key-pick', async (id) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromId(id), { title: '选择 SSH 私钥文件', properties: ['openFile'] });
  return result.canceled ? null : result.filePaths[0];
});
handle('settings-save', async (_id, value) => {
  if (settingsApplying || backend.connecting || backend.controlChanging) throw new Error('Wait for the current connection change to finish.');
  const previous = connectionSettings(root);
  const previousRemotePort = backend.remotePort;
  const settings = saveConnectionSettings(root, value);
  const changed = previous.target !== settings.target || previous.sshPort !== settings.sshPort || previous.keyPath !== settings.keyPath;
  settingsApplying = true;
  backend.settingsChanging = true; backend.update({});
  let applyError = '';
  try {
    if (changed && backend.client) {
      await backend.reconnectSettings(typeof value.passphrase === 'string' ? value.passphrase : '', previous.target === settings.target ? previousRemotePort : null);
    } else if (backend.status.ssh === 'ready' && backend.status.tunnel === 'ready') {
      await backend.syncDesktopSettings(); backend.update({});
    } else {
      await backend.connect(typeof value.passphrase === 'string' ? value.passphrase : '');
    }
  } catch (error) {
    applyError = error.message;
  } finally { settingsApplying = false; backend.settingsChanging = false; backend.update({}); }
  return { saved: true, applied: !applyError, settings, status: backend.snapshot(), error: applyError };
});
handle('active-sessions', async (id, targetId = null) => {
  const target = state.sessions.find((session) => session.id === targetId);
  return describeCapacity(await backend.activeSessions(target?.id, target?.provider), id);
});
handle('release-session', async (id, sessionId, provider) => {
  const active = await backend.activeSessions();
  const target = active.active.find((entry) => entry.id === sessionId && entry.provider === provider);
  if (!target) return;
  if (target.starting) throw new Error('This conversation is still starting. Refresh the active list shortly.');
  const channelOwner = backend.channels.get(sessionId)?.owner || id;
  await backend.endSession(sessionId, channelOwner, provider);
});
handle('refresh-usage', (_id, provider) => backend.refreshUsage(provider, true));
handle('force-control', async (_id, enabled) => {
  try { return await backend.setForceControl(enabled); }
  finally { state.forceControl = backend.forceControl; save(); }
});
handle('assistant-defaults', (_id, provider, value) => {
  if (!['claude', 'codex'].includes(provider)) throw new Error('Invalid assistant provider.');
  const settings = validateSelection(value, backend.catalog[provider]);
  state.assistantDefaults[provider] = settings;
  save();
  return settings;
});
handle('project-add', async (_id, value) => {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || typeof value.path !== 'string' || !/^(~\/|\/)/.test(value.path) || /[\r\n\0]/.test(value.path) || value.path.length > 1000 || value.path === '/') throw new Error('Enter a name and an absolute or ~/ remote project path.');
  if (/[()\uFF08\uFF09]/u.test(value.name)) throw new Error('Project names cannot contain parentheses.');
  const project = { id: crypto.randomUUID(), name: value.name.trim(), path: value.path.trim(), localPath: await localRoot(value.localPath || '') };
  state.projects.push(project); save(); return project;
});
handle('project-folder-pick', async (id) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromId(id), { title: '选择本地项目目录', properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
function requireProject(projectId) {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project || deletingProjects.has(projectId)) throw new Error('Project not found.');
  return project;
}
handle('project-folder-save', async (_id, projectId, value) => {
  const project = requireProject(projectId);
  const locations = await validateLocations(value);
  if (!state.projects.includes(project)) throw new Error('Project not found.');
  const previous = { localPath: project.localPath, localPathRevision: project.localPathRevision, locations: project.locations };
  const folder = locations.find((entry) => entry.kind === 'local')?.path || '';
  if ((project.localPath || '') !== folder) project.localPathRevision = crypto.randomUUID();
  Object.assign(project, { localPath: folder, locations });
  try { save(); } catch (error) { Object.assign(project, previous); throw error; }
  return project;
});
async function openProjectItem(target) {
  // Only open document/media associations; reveal other files without executing them.
  const info = await fs.promises.stat(target);
  if (!info.isDirectory() && !/\.(html?|md|txt|json|yaml|yml|toml|ini|log|csv|pdf|png|jpe?g|gif|webp|bmp|ico|mp4|mkv|mov|webm|mp3|wav|ogg|flac)$/i.test(target)) { shell.showItemInFolder(target); return; }
  const error = await shell.openPath(target);
  if (error) throw new Error('Unable to open the local project path.');
}
handle('project-path-open', async (_id, projectId, value) => {
  await openProjectItem(await resolveProjectPath(requireProject(projectId).localPath, value));
});
handle('project-move', (_id, projectId, targetId, before) => {
  const project = requireProject(projectId);
  requireProject(targetId);
  if (projectId === targetId || typeof before !== 'boolean') return;
  const previous = state.projects;
  const projects = previous.filter((entry) => entry.id !== projectId);
  projects.splice(projects.findIndex((entry) => entry.id === targetId) + (before ? 0 : 1), 0, project);
  state.projects = projects;
  try { save(); } catch (error) { state.projects = previous; throw error; }
});
handle('project-files', async (_id, projectId, location, parts, operation) => {
  if (!['list', 'preview', 'open'].includes(operation) || (operation === 'open' && location?.kind !== 'local')) throw new Error('Invalid file operation.');
  const result = await projectFiles(backend, requireProject(projectId), location, parts, operation);
  if (operation === 'open') return openProjectItem(result.path);
  return result;
});
handle('project-terminals', () => projectTerminals.list());
handle('project-terminal-open', async (_id, projectId, location) => {
  const project = requireProject(projectId);
  const id = await projectTerminals.open(project, location);
  if (!state.projects.includes(project)) projectTerminals.close(id);
  return id;
});
handle('project-terminal-input', (_id, id, data) => projectTerminals.input(id, data));
handle('project-terminal-resize', (_id, id, cols, rows) => projectTerminals.resize(id, cols, rows));
handle('project-terminal-close', (_id, id) => projectTerminals.close(id));
handle('project-delete-preview', async (id, projectId) => {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) throw new Error('Project not found.');
  const sessions = state.sessions.filter((entry) => entry.projectId === projectId);
  let active = [], remoteKnown = false;
  if (backend.status.ssh === 'ready') {
    try {
      const value = describeCapacity(await backend.activeSessions(), id);
      active = value.active.filter((entry) => sessions.some((session) => session.id === entry.id && session.provider === entry.provider));
      remoteKnown = true;
    } catch {}
  }
  return { project, conversationCount: sessions.length, active, remoteKnown };
});
handle('project-delete', async (_id, projectId, stopActive = false) => {
  if (typeof stopActive !== 'boolean') throw new Error('Invalid project deletion option.');
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) throw new Error('Project not found.');
  if (deletingProjects.has(projectId) || settingsApplying || state.sessions.some((entry) => entry.projectId === projectId && sessionChanges.has(entry.id))) throw new Error('Wait for the current project or connection change to finish.');
  deletingProjects.add(projectId);
  try {
    const sessions = state.sessions.filter((entry) => entry.projectId === projectId);
    const ids = new Set(sessions.map((entry) => entry.id));
    if (stopActive) {
      const current = await backend.activeSessions();
      for (const entry of current.active.filter((entry) => sessions.some((session) => session.id === entry.id && session.provider === entry.provider))) {
        if (entry.starting) throw new Error('This conversation is still starting. Refresh the active list shortly.');
        await backend.endSession(entry.id, backend.channels.get(entry.id)?.owner || _id, entry.provider);
      }
    }
    const previous = state;
    state = { ...state, projectArchive: [...state.projectArchive, { project, sessions, removedAt: Date.now() }],
      projects: state.projects.filter((entry) => entry.id !== projectId), sessions: state.sessions.filter((entry) => !ids.has(entry.id)) };
    try { save(); } catch (error) { state = previous; throw error; }
    projectTerminals.closeProject(projectId);
    for (const id of ids) {
      const channel = backend.channels.get(id);
      if (channel) { channel.intentionalClose = true; channel.finish(); channel.stream.close(); }
      unreadSessions.delete(id);
      unreadRevisions.delete(id);
    }
    for (const staged of stagedFilesByWindow.values()) for (const [id, file] of staged) if (ids.has(file.sessionId)) { clipboardImages.remove(file); staged.delete(id); }
    saveUnread(); updateUnread();
    return { projectId, stopped: stopActive, retainedRemoteFiles: true };
  } finally { deletingProjects.delete(projectId); }
});
handle('session-add', (_id, projectId, provider = 'claude') => {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) throw new Error('Choose a project first.');
  if (deletingProjects.has(projectId)) throw new Error('This project is being removed.');
  if (!['claude', 'codex'].includes(provider)) throw new Error('Invalid assistant provider.');
  const number = state.sessions.filter((entry) => entry.projectId === projectId).length + 1;
  const settings = validateSelection(state.assistantDefaults[provider], backend.catalog[provider]);
  const session = { id: crypto.randomUUID(), projectId, provider, ...settings, name: `对话 ${number}`, createdAt: Date.now() };
  state.sessions.unshift(session); save(); return session;
});
handle('session-open', async (id, sessionId, dimensions = {}) => {
  if (settingsApplying) throw new Error('Wait for the current connection change to finish.');
  if (sessionChanges.has(sessionId)) throw new Error('Session settings are changing. Wait for reconnection.');
  const session = state.sessions.find((entry) => entry.id === sessionId);
  const project = state.projects.find((entry) => entry.id === session?.projectId);
  if (!session || !project) throw new Error('Session not found.');
  if (deletingProjects.has(project.id)) throw new Error('This project is being removed.');
  const capacity = await backend.activeSessions(session.id, session.provider, { reclaimIdle: true });
  if (!capacity.available) return { opened: false, capacity: describeCapacity(capacity, id) };
  await backend.openSession({ ...session, projectPath: project.path }, id, dimensions);
  const releasedCount = capacity.released?.length || 0;
  if (releasedCount) backend.log(`Released ${releasedCount} completed, detached desktop process(es) to admit the requested conversation. History was retained.`);
  return { opened: true, releasedCount };
});
handle('session-settings', async (id, sessionId, value) => {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) throw new Error('Session not found.');
  if (deletingProjects.has(session.projectId)) throw new Error('This project is being removed.');
  if (sessionChanges.has(sessionId)) throw new Error('Session settings are changing. Wait for reconnection.');
  if (backend.status.tunnel !== 'ready') throw new Error('Connect to the server first.');
  const settings = validateSelection(value, backend.catalog[session.provider]);
  if (session.model === settings.model && session.effort === settings.effort) return session;
  sessionChanges.add(sessionId);
  try {
    await backend.endSession(sessionId, id, session.provider);
    Object.assign(session, settings);
    save();
    return session;
  } finally { sessionChanges.delete(sessionId); }
});
handle('session-read', (_id, sessionId, revision, completion = null) => {
  if (!state.sessions.some((session) => session.id === sessionId)) return;
  if (!revision || unreadRevisions.get(sessionId) !== revision) return;
  const latest = backend.completionTokens.get(sessionId);
  if (completion !== null && latest && completion !== latest) return;
  if (unreadSessions.delete(sessionId)) { unreadRevisions.delete(sessionId); saveUnread(); updateUnread(); }
});
handle('session-history', async (_id, sessionId, refresh = true) => {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) throw new Error('Session not found.');
  const cacheFile = path.join(historyDir, `${sessionId}.json`);
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  if (refresh === false) return withOutgoing({ ...(cached || { messages: [], completion: '' }), syncState: 'cached' }, sessionId);
  if (historyRefreshes.has(sessionId)) return withOutgoing(await historyRefreshes.get(sessionId), sessionId);
  const operation = (async () => {
    if (backend.snapshot().ssh === 'ready') {
      try {
        if (!sendingSessions.has(sessionId)) {
          const pending = outbox.list(sessionId).filter((item) => item.status !== 'accepted' && item.digest).at(-1);
          if (pending) { try { await confirmOutgoing(pending); } catch {} }
        }
        // Rebuild older display caches once so previously imported internal summaries disappear.
        const historyCursor = cached?.historyFormatVersion === 2 ? cached.cursor : null;
        const result = await backend.readHistory(sessionId, session.provider, historyCursor, cached?.completion || '');
        if (result.found === false) return { ...(cached || { messages: [], completion: '' }), syncState: cached ? 'missing' : 'fresh' };
        const merge = Boolean(historyCursor && result.cursor && !result.reset);
        const history = {
          messages: merge ? [...(cached.messages || []), ...(result.messages || [])].slice(-100) : result.messages || [],
          completion: result.completion || (result.reset ? '' : cached?.completion || ''),
          cursor: result.cursor || null,
          historyFormatVersion: result.historyFormatVersion || 1,
          updatedAt: Date.now(),
        };
        const temporary = `${cacheFile}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(history));
        fs.renameSync(temporary, cacheFile);
        return { ...history, syncState: 'fresh' };
      } catch (error) {
        if (!cached) throw error;
        return { ...cached, syncState: 'error', syncError: error.message };
      }
    }
    return { ...(cached || { messages: [], completion: '' }), syncState: 'offline' };
  })();
  historyRefreshes.set(sessionId, operation);
  try { return withOutgoing(await operation, sessionId); } finally { if (historyRefreshes.get(sessionId) === operation) historyRefreshes.delete(sessionId); }
});
function withOutgoing(history, sessionId) {
  // Recovery copies belong to Send history, not the chronological remote transcript.
  return { ...history, messages: (history.messages || []).filter((message) => !message.localId) };
}
async function confirmOutgoing(record) {
  if (!record.checkpoint || !record.digest || record.status === 'accepted') return record.status === 'accepted';
  const connection = backend.snapshot().connection;
  if (record.server !== `${connection.username}@${connection.host}:${connection.sshPort}`) return false;
  const receipt = await backend.messageReceipt(record.sessionId, record.provider, { digest: record.digest, checkpoint: record.checkpoint });
  if (!receipt.accepted) return false;
  const accepted = outbox.update(record.sessionId, record.id, { status: 'accepted', recordedAt: receipt.recordedAt });
  rememberProjectContext(accepted);
  return true;
}
function projectLocationContext(session) {
  const project = state.projects.find((entry) => entry.id === session.projectId);
  if (!project || (!project.localPath && !project.localPathRevision)) return null;
  const connection = backend.snapshot().connection;
  const location = { windowsProjectRoot: project.localPath || null, remoteHostProjectFolder: project.path };
  const key = crypto.createHash('sha256').update(JSON.stringify([
    'project-location-v1', project.id, project.localPathRevision || '', location,
    session.provider, connection.username, connection.host, connection.sshPort,
  ])).digest('hex');
  const text = '\n\n<relay-desk-project-context>\nProject location context supplied by Relay Desk for this conversation. Use this location for project-relative paths until it is updated.\n'
    + JSON.stringify(location, null, 2)
    + '\nThe Windows root is on the user\'s computer, not this Linux server or container. Use Windows-MCP to access it; resolve relative project file paths against that root. The remote host folder is a separate location and does not imply that Windows files were uploaded or synchronized. If windowsProjectRoot is null, the local folder setting has been cleared; ask for the Windows location when needed. Do not change working directories or copy files just because of this context.\n</relay-desk-project-context>';
  return { key, text };
}
function rememberProjectContext(record) {
  if (!record.projectContextKey) return;
  const session = state.sessions.find((entry) => entry.id === record.sessionId);
  if (!session || session.projectContextKey === record.projectContextKey) return;
  // A late receipt for an older location must not acknowledge a newer setting.
  if (projectLocationContext(session)?.key !== record.projectContextKey) return;
  const previous = session.projectContextKey;
  session.projectContextKey = record.projectContextKey;
  try { save(); }
  catch {
    session.projectContextKey = previous;
    backend.log('Unable to persist project context delivery; it will be supplied again on the next message.');
  }
}
handle('message-records', async (_id, sessionId, refresh = false) => {
  if (!state.sessions.some((entry) => entry.id === sessionId)) throw new Error('Session not found.');
  if (refresh && backend.status.ssh === 'ready' && !sendingSessions.has(sessionId)) {
    for (const record of outbox.list(sessionId).filter((item) => item.status !== 'accepted' && item.digest).slice(-3)) {
      try { await confirmOutgoing(record); } catch { break; }
    }
  }
  return outbox.publicRecords(sessionId);
});
handle('message-prepare', (id, sessionId, userText, fileIds, previousId = null) => {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session || deletingProjects.has(session.projectId)) throw new Error('Session not found.');
  if (typeof userText !== 'string' || userText.length > 60000 || !Array.isArray(fileIds) || fileIds.length > maxFiles) throw new Error('Invalid outgoing message.');
  const staged = stagedFilesByWindow.get(id) || new Map();
  const attachments = fileIds.map((fileId) => staged.get(fileId));
  if (attachments.some((file) => !file || file.sessionId !== sessionId)) throw new Error('Attachment references expired. Add them again.');
  const summaries = attachments.map(({ id: fileId, name, kind, sizeBytes }) => ({ id: fileId, name, kind, sizeBytes }));
  const previous = previousId && outbox.list(sessionId).find((item) => item.id === previousId);
  if (previous && previous.text === userText && previous.provider === session.provider && JSON.stringify(previous.attachments) === JSON.stringify(summaries)) return previous;
  return outbox.prepare(sessionId, session.provider, userText, summaries);
});
handle('session-rename', (_id, sessionId, name) => {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session || typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Enter a session name.');
  session.name = name.trim(); save();
});
handle('session-end', (id, sessionId) => {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) throw new Error('Session not found.');
  return backend.endSession(sessionId, id, session.provider);
});
handle('input', (id, sessionId, data) => {
  if (sessionChanges.has(sessionId)) throw new Error('Session settings are changing. Wait for reconnection.');
  return backend.input(sessionId, id, data);
});
handle('clipboard-write', (_id, value) => {
  if (typeof value !== 'string' || !value || value.length > 2000000) throw new Error('Invalid clipboard text.');
  return clipboard.writeText(value);
});
handle('clipboard-read-text', () => clipboard.readText());
handle('open-link', (_id, value) => {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid web link.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS web links can be opened.');
  return shell.openExternal(url.href);
});
async function stageLocalFiles(ownerId, sessionId, paths) {
  if (!state.sessions.some((session) => session.id === sessionId)) throw new Error('请先选择一个对话。');
  if (!Array.isArray(paths) || !paths.length || paths.length > maxFiles) throw new Error('每次最多选择 8 个文件。');
  const additions = [];
  for (const filePath of paths) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.length > 2048 || /[\x00-\x1f]/.test(filePath)) throw new Error('无法读取拖入文件的本机路径。');
    const info = await fs.promises.stat(filePath);
    if (!info.isFile()) throw new Error('目前只能添加文件，暂不支持文件夹。');
    if (info.size > maxFileBytes) throw new Error(`“${path.basename(filePath)}”超过 16 MiB。为保护小服务器，请改为指定需要查看的内容。`);
    additions.push({ id: crypto.randomUUID(), sessionId, path: filePath, name: path.basename(filePath), sizeBytes: info.size });
  }
  const current = stagedFilesByWindow.get(ownerId) || new Map();
  if (current.size + additions.length > maxFiles) throw new Error('请先发送或移除已添加的文件；一个窗口最多暂存 8 个文件。');
  const batchSize = [...current.values(), ...additions].reduce((sum, file) => sum + file.sizeBytes, 0);
  if (batchSize > maxBatchBytes) throw new Error('待发送文件总大小超过 32 MiB。请先移除一些文件。');
  for (const file of additions) current.set(file.id, file);
  stagedFilesByWindow.set(ownerId, current);
  return additions.map(({ id, name, sizeBytes }) => ({ id, name, sizeBytes }));
}
handle('file-stage', (id, sessionId, paths) => stageLocalFiles(id, sessionId, paths));
handle('clipboard-image', async (id, sessionId) => {
  if (!state.sessions.some((session) => session.id === sessionId)) throw new Error('请先选择一个对话。');
  const image = await readClipboardImage(clipboard, nativeImage);
  const window = BrowserWindow.fromId(id);
  if (!window || window.isDestroyed()) throw new Error('The window was closed before the image could be attached.');
  // Recheck capacity after the asynchronous clipboard read; another attachment may have arrived.
  const current = stagedFilesByWindow.get(id) || new Map();
  if (current.size >= maxFiles) throw new Error('一个窗口最多暂存 8 个附件，请先发送或移除一些附件。');
  const protectedPaths = new Set([...stagedFilesByWindow.values()].flatMap((files) => [...files.values()].map((file) => file.path)));
  const file = { ...clipboardImages.stage(image, protectedPaths), id: crypto.randomUUID(), sessionId };
  if ([...current.values(), file].reduce((sum, entry) => sum + entry.sizeBytes, 0) > maxBatchBytes) {
    clipboardImages.remove(file);
    throw new Error('待发送附件总大小超过 32 MiB，请先移除一些附件。');
  }
  current.set(file.id, file);
  stagedFilesByWindow.set(id, current);
  const { path: _path, sessionId: _sessionId, ...preview } = file;
  return preview;
});
handle('file-pick', async (id, sessionId) => {
  const window = BrowserWindow.fromId(id);
  const result = await dialog.showOpenDialog(window, { title: '选择本机文件（仅发送路径）', buttonLabel: '添加路径', properties: ['openFile', 'multiSelections'] });
  return result.canceled ? [] : stageLocalFiles(id, sessionId, result.filePaths);
});
handle('file-discard', (id, fileIds) => {
  const staged = stagedFilesByWindow.get(id);
  if (!staged || !Array.isArray(fileIds)) return;
  for (const fileId of fileIds) if (typeof fileId === 'string') {
    clipboardImages.remove(staged.get(fileId));
    staged.delete(fileId);
  }
});
handle('send-message', async (id, sessionId, userText, fileIds, outgoingId) => {
  if (sendingSessions.has(sessionId)) throw new Error('A message is already being submitted to this conversation.');
  if (sessionChanges.has(sessionId)) throw new Error('Session settings are changing. Wait for reconnection.');
  if (typeof userText !== 'string' || !Array.isArray(fileIds) || fileIds.length > maxFiles || fileIds.some((fileId) => typeof fileId !== 'string')) throw new Error('Invalid outgoing message.');
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session || deletingProjects.has(session.projectId)) throw new Error('Session not found.');
  const text = userText.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const record = outbox.list(sessionId).find((item) => item.id === outgoingId);
  if (!record || record.text !== text || record.provider !== session.provider) throw new Error('Save the outgoing message backup before sending.');
  const releaseFiles = () => {
    const staged = stagedFilesByWindow.get(id);
    for (const fileId of fileIds) {
      const file = staged?.get(fileId);
      if (!file || file.sessionId !== sessionId) continue;
      try { clipboardImages.remove(file); staged.delete(fileId); }
      catch { backend.log('Unable to remove an accepted message attachment from the staging cache.'); }
    }
  };
  if (record.status === 'accepted') { rememberProjectContext(record); releaseFiles(); return { accepted: true, id: record.id, alreadyAccepted: true }; }
  if (record.status === 'submitted') { rememberProjectContext(record); releaseFiles(); return { submitted: true, id: record.id, alreadySubmitted: true }; }
  sendingSessions.add(sessionId);
  let transmitted = false;
  try {
    let alreadyAccepted = false;
    if (record.digest) { try { alreadyAccepted = await confirmOutgoing(record); } catch {} }
    if (alreadyAccepted) {
      releaseFiles(); return { accepted: true, id: record.id, alreadyAccepted: true };
    }
    const staged = stagedFilesByWindow.get(id) || new Map();
    const files = fileIds.map((fileId) => staged.get(fileId));
    if (files.some((file) => !file || file.sessionId !== sessionId)) throw new Error('Attachment references expired. Add them again.');
    if (!text.trim() && !files.length) throw new Error('Enter a message or attach a file.');
    for (const file of files) {
      const info = await fs.promises.stat(file.path);
      if (!info.isFile() || info.size > maxFileBytes) throw new Error('An attached file changed or is too large. Add it again.');
      file.sizeBytes = info.size;
    }
    if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > maxBatchBytes) throw new Error('Attachments exceed the 32 MiB batch limit.');
    const prompt = text.trim() ? text : 'Inspect the attached images or referenced files and describe their content.';
    const localFiles = files.filter((file) => file.kind !== 'clipboard-image');
    const images = files.filter((file) => file.kind === 'clipboard-image');
    const attachment = localFiles.length ? '\n\nThese paths refer to files on my Windows computer; the files have not been uploaded. Use Windows-MCP to inspect metadata and small relevant text sections. For binary or media files, prefer metadata or small previews. Do not copy entire files to the server or return their full contents without asking me first.\n' + JSON.stringify(localFiles.map((file) => ({ windowsPath: file.path, sizeBytes: file.sizeBytes })), null, 2) : '';
    const remoteImages = await backend.uploadClipboardImages(sessionId, id, images);
    const imageAttachment = remoteImages.length ? '\n\nClipboard images are available at the following Linux paths inside your current container. Read them with your image-capable file reader to see the images. These are not Windows paths.\n' + JSON.stringify(remoteImages, null, 2) : '';
    const location = projectLocationContext(session);
    // Preserve native slash commands; attach context to the next ordinary task instead.
    const nativeCommand = /^\s*\/[a-z][\w-]*(?:\s|$)/i.test(prompt);
    const projectContext = !nativeCommand && location && session.projectContextKey !== location.key ? location : null;
    const message = prompt + attachment + imageAttachment + (projectContext?.text || '');
    if (message.length > 60000) throw new Error('Please shorten this message to 60,000 characters.');
    const digest = crypto.createHash('sha256').update(message.replace(/\r\n/g, '\n').trim()).digest('hex');
    // Check an uncertain earlier attempt before any explicit retry reaches the terminal.
    for (const previous of outbox.list(sessionId).filter((item) => item.id !== record.id && item.status !== 'accepted' && item.digest === digest).slice(-3)) {
      let confirmed = false;
      try { confirmed = await confirmOutgoing(previous); } catch {}
      if (confirmed) {
        const accepted = outbox.update(sessionId, record.id, { status: 'accepted', recordedAt: previous.recordedAt || Date.now(), projectContextKey: projectContext?.key || null });
        rememberProjectContext(accepted);
        releaseFiles();
        return { accepted: true, id: record.id, alreadyAccepted: true };
      }
    }
    let checkpoint = null;
    try {
      const value = await backend.messageReceipt(sessionId, session.provider, { action: 'checkpoint' });
      if (Array.isArray(value.positions) && Number.isFinite(value.createdAt)) checkpoint = value;
    } catch {}
    const connection = backend.snapshot().connection;
    outbox.update(sessionId, record.id, { status: 'sending', digest, checkpoint, projectContextKey: projectContext?.key || null,
      server: `${connection.username}@${connection.host}:${connection.sshPort}` });
    transmitted = true;
    await backend.submitInput(sessionId, id, '\x1b[200~' + message + '\x1b[201~');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await backend.submitInput(sessionId, id, '\r');
    const submitted = outbox.update(sessionId, record.id, { status: 'submitted' });
    rememberProjectContext(submitted);
    backend.markTaskRunning(sessionId);
    releaseFiles();
    return { submitted: true, id: record.id };
  } catch (error) {
    // The durable copy survives transport failures, app closure, and lost IPC replies.
    outbox.update(sessionId, record.id, { status: transmitted ? 'unconfirmed' : 'failed' });
    throw error;
  } finally { sendingSessions.delete(sessionId); }
});
handle('resize', (id, sessionId, cols, rows) => backend.resize(sessionId, id, cols, rows));
handle('mcp-reconnect', async (id, sessionId) => {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session || session.provider !== 'claude') throw new Error('MCP reconnect requires a connected Claude conversation.');
  if (sendingSessions.has(sessionId) || sessionChanges.has(sessionId) || settingsApplying) throw new Error('Wait for the current conversation operation to finish.');
  if (backend.status.mcp !== 'ready' || backend.status.tunnel !== 'ready') throw new Error('Restore Windows MCP and the SSH tunnel before reconnecting Claude MCP.');
  sendingSessions.add(sessionId);
  try {
    await backend.submitInput(sessionId, id, '\x1b[200~/mcp reconnect windows-mcp\x1b[201~');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await backend.submitInput(sessionId, id, '\r');
    return { submitted: true };
  } finally { sendingSessions.delete(sessionId); }
});
handle('new-window', () => { createWindow(); });
handle('show-env', () => shell.showItemInFolder(path.join(root, '.env')));
handle('show-logs', () => shell.openPath(path.join(root, 'logs')));

function createWindow() {
  const window = new BrowserWindow({ width: 1320, height: 900, minWidth: 980, minHeight: 700, show: !process.argv.includes('--smoke-test'), title: 'Relay Desk', backgroundColor: '#181b20', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const windowId = window.id;
  window.webContents.once('did-finish-load', updateUnread);
  window.on('closed', () => {
    backend.detachOwner(windowId);
    for (const file of stagedFilesByWindow.get(windowId)?.values() || []) {
      try { clipboardImages.remove(file); } catch (error) { backend.log(error.message); }
    }
    stagedFilesByWindow.delete(windowId);
  });
  window.loadFile(path.join(__dirname, 'index.html'));
  if (process.argv.includes('--smoke-test')) {
    window.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message); });
    window.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const result = await window.webContents.executeJavaScript(`({ title: document.querySelector('h1').textContent, buttons: [...document.querySelectorAll('button')].map(x => x.textContent.trim()), projects: document.querySelectorAll('.project-item').length, ready: Boolean(window.relay) })`);
        if (!result.ready || !result.projects || result.title !== '你的远程工作区') throw new Error('Desktop did not initialize.');
        fs.writeFileSync(path.join(dataDir, 'smoke.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(dataDir, 'preview.png'), (await window.webContents.capturePage()).toPNG());
        const cachedSession = state.sessions.find((session) => fs.existsSync(path.join(historyDir, `${session.id}.json`)));
        if (cachedSession) {
          const expectedHistory = JSON.parse(fs.readFileSync(path.join(historyDir, `${cachedSession.id}.json`), 'utf8')).messages.length;
          await window.webContents.executeJavaScript(`activateSession(${JSON.stringify(cachedSession.id)})`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          const historyCount = await window.webContents.executeJavaScript("document.querySelectorAll('.history-message').length");
          if (historyCount !== expectedHistory) throw new Error('Saved conversation history did not render completely.');
          const historyView = await window.webContents.executeJavaScript(`(() => { document.getElementById('history-toggle').click(); return { historyVisible: !document.getElementById('history-panel').hidden, terminalHidden: document.getElementById('terminal-host').hidden, height: document.getElementById('history-panel').clientHeight, fontSize: getComputedStyle(document.querySelector('.history-message-body')).fontSize }; })()`);
          if (!historyView.historyVisible || !historyView.terminalHidden || historyView.height < 150 || parseFloat(historyView.fontSize) < 18) throw new Error('Conversation history did not fill the output area at a readable size.');
          const terminalView = await window.webContents.executeJavaScript(`(() => { document.getElementById('history-toggle').click(); return { historyHidden: document.getElementById('history-panel').hidden, terminalVisible: !document.getElementById('terminal-host').hidden }; })()`);
          if (!terminalView.historyHidden || !terminalView.terminalVisible) throw new Error('Terminal view did not return after closing history.');
        }
        if (process.argv.includes('--live-ui')) {
          await window.webContents.executeJavaScript('window.relay.connect()');
          const session = await window.webContents.executeJavaScript('(async () => window.relay.addSession((await window.relay.snapshot()).workspace.projects[0].id))()');
          await window.webContents.executeJavaScript(`window.relay.renameSession(${JSON.stringify(session.id)}, 'Desktop connection check')`);
          await window.webContents.executeJavaScript(`activateSession(${JSON.stringify(session.id)}, { connectSession: true })`);
          await new Promise((resolve) => setTimeout(resolve, 9000));
          const connected = await window.webContents.executeJavaScript(`({ state: document.getElementById('session-state').textContent, canvas: document.querySelectorAll('.xterm-screen canvas').length, composer: !document.getElementById('composer-area').hidden, notice: document.getElementById('notice').textContent })`);
          if (!connected.composer || !connected.state.includes('已连接')) throw new Error('Remote conversation UI failed to open.');
          fs.writeFileSync(path.join(dataDir, 'live-ui.json'), JSON.stringify(connected, null, 2));
          fs.writeFileSync(path.join(dataDir, 'connected-preview.png'), (await window.webContents.capturePage()).toPNG());
          await backend.endSession(session.id, window.id);
          state.sessions = state.sessions.filter((entry) => entry.id !== session.id);
          save();
        }
        backend.stop();
        app.exit(0);
      } catch (error) { console.error(error); backend.stop(); app.exit(1); }
    });
  }
  return window;
}
if (!smokeMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => createWindow());
  app.whenReady().then(() => {
    keepAwake.start();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '文件', submenu: [{ label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() }, { type: 'separator' }, { label: '退出', role: 'quit' }] }, { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] }, { label: '视图', submenu: [{ label: '重新加载', role: 'reload' }, { label: '开发者工具', role: 'toggleDevTools' }, { label: '重置缩放', role: 'resetZoom' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }] }]));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    projectTerminals.closeAll();
    keepAwake.dispose();
    // Keep SSH alive for bounded cleanup; any unfinished cleanup is retried next launch.
    let deadline;
    Promise.race([
      backend.prepareForExit(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Exit idle cleanup timed out; retrying next launch.')), 12000); }),
    ]).catch((error) => backend.log(error.message)).finally(() => {
      clearTimeout(deadline);
      quitReady = true;
      backend.stop();
      app.quit();
    });
  });
}
