const executorArg = process.argv.indexOf('--local-task-executor');
if (executorArg !== -1) { require('./local-executor-entry.cjs').launch(process.argv[executorArg + 1]); }
else if (process.argv.includes('--legacy')) { require('../main.cjs'); } else {
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage, safeStorage, nativeTheme, net, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const localExecutor = require('./local-executor.cjs');
const { pathToFileURL } = require('node:url');
const { Store, messagePreview } = require('./store.cjs');
const { messageData, messageView, readMessageDetail } = require('./workspace-db.cjs');
const { isDeepStrictEqual } = require('node:util');
const { Vault, Locations } = require('./locations.cjs');
const { setupSshKey } = require('./ssh-key-setup.cjs');
const { Agents, findExecutable } = require('./agents.cjs');
const { ClaudeUpdater } = require('./claude-update.cjs');
const { CliUpdates } = require('./cli-updates.cjs');
const { AppReleaseUpdate, portableRoot, portableBoot } = require('./app-release-update.cjs');
const { Avatars } = require('./avatars.cjs');
const { ModelCatalogs } = require('./model-catalogs.cjs');
const { Usage } = require('./usage.cjs');
const { ProxyRouter, environment: proxyEnvironment } = require('./proxy.cjs');
const themes = require('./themes.js');
const { effectiveRole } = require('./conversations.cjs');
const { projectGuestIds, resolve: resolveMentions } = require('./mentions.js');
const { formatMissingProjectDirectories } = require('./project-directories.cjs');
const { findProjectPaths, messagePaths } = require('./path-resolution.cjs');
const pathLinks = require('../path-links.js');
const { usesDesktopLogin } = require('./desktop-login.cjs');
const { requireCodexLogin } = require('./native-auth.cjs');
const vendors = require('./vendor-agents.cjs');
const remoteAntigravity = require('./remote-antigravity.cjs');
const discussion = require('./discussion.cjs');
const scheduledTasks = require('./scheduled-tasks.cjs');
const { Backend } = require('../backend.cjs');
const { KeepAwake } = require('../keep-awake.cjs');
const { ProjectTerminals, projectFiles } = require('../project-tools.cjs');
const { ClipboardImages, readClipboardImage } = require('../clipboard-images.cjs');
const { Attachments }=require('./attachments.cjs');
const {GeminiWeb, engine:geminiWebEngine, home:geminiWebHome}=require('./gemini-web.cjs');
const { SlackChat, engine: slackChatEngine, maxText: slackMaxText, tokenKey: slackTokenKey, userToken: slackUserToken } = require('./slack-chat.cjs');
const root = path.resolve(__dirname, '../..');
const smoke = process.argv.includes('--workbench-smoke');
const smokeRun=smoke&&/^[0-9]{1,12}$/.test(process.env.RELAY_SMOKE_RUN||'')?'-'+process.env.RELAY_SMOKE_RUN:'';
const data = smoke ? path.join(root, '.runtime/workbench-smoke'+smokeRun) : path.join(root, '.runtime/workbench');
const portable = portableRoot(root, app);
const updateBoot = portableBoot(portable);
if (updateBoot.recovery) {
  dialog.showErrorBox('AI 小队正在更新', '请等更新完成后再打开。若更新意外中断，请运行以下文件恢复：\n\n' + updateBoot.recovery);
  app.exit(1);
  return;
}
require('../windows-launch.cjs').configureWindowsLaunch(app,{root,disabled:smoke});app.setPath('userData', path.join(data, 'browser'));
if (!smoke && !app.requestSingleInstanceLock()) app.quit(); else {
let store;
try { store = new Store(data, root, { keepOpen: true }); }
catch (error) {
  console.error('Could not open the workspace:', error);
  if (!updateBoot.job) dialog.showErrorBox('无法打开 AI 小队工作区', '无法读取或迁移本机工作区。请检查目录权限和磁盘空间。\n\n' + data + '\n' + error.message);
  app.exit(1);
  return;
}
const vault = new Vault(data, safeStorage); const backend = new Backend(root, { shareControlMode:true });
const locationName = id => store.state.locations.find(location => location.id === id)?.name || id;
try { backend.forceControl=JSON.parse(fs.readFileSync(path.join(root,'.runtime/desktop/state.json'),'utf8')).forceControl===true; } catch {}
const avatars = new Avatars(path.join(data, 'avatars'), nativeImage);
const themeBackground = (preference = store.state.settings.theme) => themes.resolve(preference, nativeTheme.shouldUseDarkColors).background;
nativeTheme.themeSource = themes.themeSource(store.state.settings.theme);
nativeTheme.on('updated', () => {
  const background = themeBackground();
  for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(background);
});
const running = new Map(); const terminalManagers = new Map();
const antigravitySetups = new Set();
const localLogins = new Set();
let confirmingQuit = false, quitting = false, quitReady = false, workbenchWindow, displayedBadgeCount;
// Chromium's network stack follows the user's system proxy; Node fetch does not.
const providerFetch = (input, options) => net.fetch(input, options);
const chatById = id => store.state.chats.find(chat => chat.id === id);
const network = new ProxyRouter(store, { app, session });
const emit = () => {
  const windows = BrowserWindow.getAllWindows();
  if (!windows.length) return;
  const value = snapshot();
  for (const w of windows) w.webContents.send('desk:state', value);
};
const sendMessage = ({ chatId, message }) => {
  const chat = chatById(chatId);
  if (!chat || message.workflowInstruction) return;
  const value = { chatId, message: messageView(message), updatedAt: chat.updatedAt,
    atEnd: chat.messages.findLast(item=>!item.workflowInstruction)?.id === message.id,
    lastMessage: messagePreview(chat.messages.findLast(item => !item.moderatorTask&&!item.workflowInstruction)) };
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('desk:message', value);
};
const publishMessage = event => {
  if (!event) { emit(); return; }
  sendMessage(event);
};
const locations = new Locations(store, vault, backend, async (location, fingerprint) => {
  const result = await dialog.showMessageBox({ type: 'question', buttons: ['取消', '信任并连接'], defaultId: 0, cancelId: 0, title: '验证 SSH 主机', message: `${location.username}@${location.host}:${location.port}`, detail: `首次连接此主机，请核对服务器指纹：\n\n${fingerprint}\n\n仅在确认指纹正确后信任。` }); return result.response === 1;
}, emit);
const agents = new Agents(store, vault, locations, publishMessage, { fetch: providerFetch, network });
const geminiWeb = new GeminiWeb({store, emit:agents.emit, open:url=>shell.openExternal(url), copy:writeClipboardText,readClipboard:readClipboardText});
const slackChat = new SlackChat({store, vault, emit:publishMessage, fetchFor:role=>network.fetchFor(role)});
const attachments=new Attachments(store);
const images = new ClipboardImages(path.join(data, 'images')); images.prepare(attachments.protectedPaths());
const imageSource={read:()=>readClipboardImage(clipboard,nativeImage)};
const messageImages=new (require('./message-images.cjs').MessageImages)({store,nativeImage});
const keepAwake = new KeepAwake(root, { enabled: store.state.settings.keepAwake, disabled: smoke, changed: emit, log: () => {} });
const claudeUpdater = new ClaudeUpdater(root, store, backend, locations, emit);
const appReleaseUpdate = new AppReleaseUpdate({
  version: require('../package.json').version, request: providerFetch, open: url => shell.openExternal(url), directory: portable,
});
const updateNetworkRole = { locationId: 'local', baseUrl: 'https://registry.npmjs.org' };
const cliUpdates = new CliUpdates({
  store, file: path.join(data, 'cli-updates.json'), resolveExecutable: localExecutable,
  busyRoles: engine => store.state.roles.filter(role => role.engine === engine && role.locationId === 'local' &&
    (busyRole(role.id) || localLogins.has(role.id) || store.state.chats.some(chat => chat.localTask?.roleId === role.id) ||
      [...quotaConsole.sessions.values()].some(entry => entry.roleId === role.id))).map(role => role.name),
  fetchLocal: () => network.fetchFor(updateNetworkRole),
  npmEnvironment: () => network.environmentFor(updateNetworkRole, process.env),
  remote: claudeUpdater, changed: emit,
});
const modelCatalogs = new ModelCatalogs({ directory: data, store, vault, locations, backend, agents, fetch: providerFetch, network });
const accountUsage = new Usage({store,vault,agents,locations,backend,network,emit});
const quotaConsole=new (require('./quota-console.cjs').QuotaConsole)({store,agents,network,spawn:(...args)=>require('node-pty').spawn(...args)});
const interactiveStates=new Map();
const interactiveAgents=new (require('./interactive-agent.cjs').InteractiveAgents)({store,vault,agents,locations,network,busy:id=>running.has(id)||inputQueue.dispatching.has(id)||Boolean(groupWorkflows.activeRun(chatById(id)))||chatById(id)?.workflowRuns?.some(run=>run.stopUnconfirmed),count:()=>running.size,spawn:(...args)=>require('node-pty').spawn(...args),message:sendMessage,completed:chatId=>notifications.complete(chatId),emit:event=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('desk:agent-terminal',event);if(event.type==='state'){const info=event.info,previous=interactiveStates.get(info.id);interactiveStates.set(info.id,info.taskState);if(['running','waiting'].includes(previous)&&['completed','interrupted','failed'].includes(info.taskState))inputQueue.settled(info.chatId,info.taskState==='completed'?'complete':info.taskState==='interrupted'?'paused':'failed');if(info.state==='ended')inputQueue.pause(info.chatId,'terminal_ended');inputQueue.kick(info.chatId);emit();updateBadges();}}});
const skills=new (require('./skills.cjs').Skills)({store,vault,network,nativeImage,locations,fetch:providerFetch,emit:sendMessage});agents.skills=skills;
function inputBusy(id, ignoreWorkflowQueue=false){return running.has(id)||store.state.chats.some(chat=>chat.id===id&&
  (chat.localTask?.stopUnconfirmed||chat.workflowRuns?.some(run=>run.stopUnconfirmed||!ignoreWorkflowQueue&&run.status==='queued')))||
  [...skills.jobs.values()].some(job=>job.chatId===id)||interactiveAgents.list().some(entry=>entry.chatId===id&&entry.state!=='ended'&&!(entry.state==='ready'&&entry.inputReady&&!['running','waiting'].includes(entry.taskState)));}
function forceStopTarget(chat, terminals) {
  const job=running.get(chat.id);
  if(job?.forceStopId)return {id:job.forceStopId, stopping:Boolean(job.forceStopping)};
  if(chat.localTask?.stopUnconfirmed)return {id:chat.localTask.id, unconfirmed:true};
  const terminal=terminals.find(entry=>entry.chatId===chat.id&&entry.state!=='ended'&&
    (entry.state==='opening'||entry.forceStopping||['running','waiting'].includes(entry.taskState)));
  if(terminal)return {id:terminal.id, terminal:true, stopping:Boolean(terminal.forceStopping)};
}
function interruptChat(id) {
  const job = running.get(id);
  if (job) { job.controller.abort(); if (job.taskId) skills.closeTask(job.taskId); return true; }
  if (interactiveAgents.interrupt(id)) return true;
  const activeSkills = [...skills.jobs].filter(([, job]) => job.chatId === id);
  for (const [skillId] of activeSkills) skills.cancel(id, skillId);
  return activeSkills.length > 0;
}
const inputQueue=new (require('./input-queue.cjs').InputQueue)({store,busy:inputBusy,start:startSend,changed:emit,
  accept:(chat,value)=>{if(!value.summary){if(chat.draft===value.text)chat.draft='';attachments.consume(chat.id,value.files);}},
  interrupt:id=>{if(!interruptChat(id))throw new Error('当前任务暂时无法中断，排队消息已保留。');}});
const notifications=new (require('./notifications.cjs').CompletionNotifications)({store,
  busy:id=>running.has(id)||[...skills.jobs.values()].some(job=>job.chatId===id)||interactiveAgents.list().some(entry=>entry.chatId===id&&entry.state!=='ended'&&['running','waiting'].includes(entry.taskState)),
  changed:emit,render:renderBadges,
  attention:()=>{if(!smoke){shell.beep();if(workbenchWindow&&!workbenchWindow.isFocused())workbenchWindow.flashFrame(true);}}
});
backend.on('status', emit);
function snapshot() {
  const value = store.summary();
  const executables = new Map();
  value.roles = value.roles.map(r => {
    const virtual = r.engine === geminiWebEngine || r.engine === slackChatEngine || r.locationId !== 'local';
    if (!virtual) executables.set(r.id, localExecutable(r));
    return { ...r, avatarId: r.avatarId || avatars.defaultId(r.engine), avatarUrl: avatars.get(r.avatarId || avatars.defaultId(r.engine)), hasKey: vault.has('api:' + r.id), hasSlackKey: vault.has(slackTokenKey(r.id)), available: virtual || Boolean(executables.get(r.id)) };
  });
  value.connectionStatus = locations.status(); value.running = Object.fromEntries([...running].map(([id, job]) => [id, { roleId: job.roleId, round: job.round, rounds: job.rounds, phase:job.phase||'participant', stopping: job.controller.signal.aborted, workflowRunId:job.workflowRunId }]));
  value.inputBusy=Object.fromEntries(value.chats.map(chat=>[chat.id,inputBusy(chat.id)]));
  const terminals=interactiveAgents.list();
  value.forceStops=Object.fromEntries(value.chats.map(chat=>[chat.id,forceStopTarget(chat,terminals)]));
  value.mcp = { ssh: backend.status.ssh, mcp: backend.status.mcp, tunnel: backend.status.tunnel, mcpOwned:backend.status.mcpOwned, tunnelOwned:backend.status.tunnelOwned, forceControl:backend.appliedForceControl };
  value.claudeUpdate = claudeUpdater.snapshot();
  value.cliUpdates = cliUpdates.snapshot(executables);
  value.accountUsage = accountUsage.snapshot();
  value.skills=skills.list();
  value.skillSources=skills.system.sources();
  value.appVersion = require('../package.json').version;
  return value;
}
const quitBlockedCommands = new Set(['workflow-create', 'workflow-resume', 'workflow-plan', 'workflow-group-start', 'workflow-group-resume', 'terminal-open', 'role-login']);
function handle(name, fn, withSender=false) {
  ipcMain.handle('desk:' + name, async (event, ...args) => {
    if (event.senderFrame?.url !== pathToFileURL(path.join(__dirname, 'index.html')).href) throw new Error('Untrusted sender.');
    if (quitting && quitBlockedCommands.has(name)) throw new Error('ai-team is closing.');
    const result = await (withSender?fn(event.sender,...args):fn(...args)); return result;
  });
}
function busyRole(id) { return [...running.values()].some(job => job.roleId === id || job.roleIds.includes(id))||interactiveAgents.list().some(e=>e.roleId===id&&e.state!=='ended'); }
function localExecutable(role) { try { return findExecutable(role); } catch { return ''; } }
function ensureCliReady(role) {
  if (cliUpdates.isInstalling(role)) throw new Error('角色「' + role.name + '」使用的 CLI 正在更新，请稍后重试。');
}
function updateBadges() {
  return notifications.refresh();
}
function restoreBadges() {
  displayedBadgeCount = undefined;
  updateBadges();
}
function renderBadges(count) {
  if (count === displayedBadgeCount) return;
  if(process.platform==='win32'){
    if(workbenchWindow){
      const icon=count?nativeImage.createFromPath(path.join(__dirname,'../assets/badge-'+Math.min(9,count)+'.png')):null;
      workbenchWindow.setOverlayIcon(icon,count?'有 '+count+' 个未读会话':'');
    }
  }else app.setBadgeCount(count);
  displayedBadgeCount = count;
  if(!count)workbenchWindow?.flashFrame(false);
}
handle('snapshot', snapshot);
handle('project-select', id => store.selectProject(id));
handle('project-order', (order, direction) => store.sortProjects(order, direction));
handle('project-search', (id, query) => store.searchProject(id, query));
handle('chat-messages', (id, cursor) => store.messagePage(id, cursor));
handle('chat-search', (id, query, offset) => store.searchMessages(id, query, offset));
handle('other-chats-search', (id, query, offset) => store.searchOtherChats(id, query, offset));
handle('message-details', (id, messageId, field) => {
  const message = store.get('chats', id).messages.find(item => item.id === messageId);
  if (!message) throw new Error('找不到这条消息。');
  if (field === 'activities') return readMessageDetail(message, field) || [];
  if (field === 'terminal') return readMessageDetail(message, field) || [message.thinking && '[Reasoning summary]\r\n' + message.thinking, message.text, message.note].filter(Boolean).join('\r\n\r\n');
  throw new Error('无法读取此消息详情。');
});
handle('chat-runs', id => store.get('chats', id).messages.filter(message => message.kind === 'assistant')
  .map(({id, roleId, roleName, at, status, errorCode, workflowAttemptId}) => ({id, roleId, roleName, at, status, errorCode, workflowAttemptId, kind:'assistant'})));
handle('skill-get',id=>skills.read(id));
handle('skill-sources-save',async value=>{await skills.system.saveSources(value);emit();return skills.system.sources();});
handle('skill-enabled',(id,enabled)=>{skills.setEnabled(id,enabled);emit();return true;});
handle('skill-models',(value,options)=>skills.models(value,options));
handle('skill-save',value=>{const result=skills.save(value);emit();return result;});
handle('skill-delete',id=>{skills.remove(id);emit();});
handle('skill-cancel',(chatId,id)=>skills.cancel(chatId,id));
handle('account-usage', async roleId => { ensureCliReady(store.get('roles', roleId)); await accountUsage.request(roleId); return snapshot(); });
handle('usage-guide', (sender,roleId) => {
  const role=store.get('roles',roleId);
  if(role.enabled===false)return;
  ensureCliReady(role);
  if(role.engine==='antigravity'&&role.provider==='native'&&role.locationId==='local')return quotaConsole.open(roleId,sender);
  const url=accountUsage.guide(roleId);
  if(url)return shell.openExternal(url);
},true);
for(const method of ['action','screen','resize','stop'])handle('quota-'+method,(sender,...args)=>quotaConsole[method](sender,...args),true);
handle('claude-cli', async action => {
  try { return await claudeUpdater.request(action); }
  catch (error) {
    console.warn('Server Claude CLI operation failed:', error.message);
    throw new Error('服务器 Claude Code 操作未完成，请检查 SSH 连接后重试。');
  }
});
handle('cli-update-preference', (key, value) => cliUpdates.savePreference(key, value));
handle('app-update-check', () => appReleaseUpdate.check());
handle('app-update-download', () => appReleaseUpdate.download());
handle('app-update-status', () => appReleaseUpdate.status());
handle('app-update-prepare', () => appReleaseUpdate.prepare());
handle('app-update-install', () => requestQuit(false, true));
let updateAccepted = false;
handle('app-update-ready', () => {
  if (updateBoot.job && !updateAccepted) fs.writeFileSync(path.join(updateBoot.job, 'ready'), String(process.pid));
});
handle('cli-update-check', engine => engine === undefined ? cliUpdates.runBatch('check') : cliUpdates.check(engine));
handle('cli-update-install', engine => {
  if (quitting || confirmingQuit) throw new Error('工作台正在退出，请稍后重试。');
  return engine === undefined ? cliUpdates.runBatch('install') : cliUpdates.install(engine);
});
handle('models', (input, options) => modelCatalogs.request(input, options));
handle('agent-info', async value => {
  if (!vendors.isVendor(value?.engine)) throw new Error('Choose an official account agent.');
  const location = store.get('locations', value.locationId || 'local');
  if (location.type === 'local') return vendors.info(value);
  if (value.engine === 'custom-acp') throw new Error('自定义 ACP 仅支持本机运行。');
  return remoteAntigravity.runtime(locations, location, String(value.executable || '').trim());
});
handle('agent-guide', (engine, preset) => {
  if (engine === 'custom-acp') {
    if (preset === 'hermes') return shell.openExternal('https://hermes-agent.nousresearch.com/docs/user-guide/features/acp');
    if (preset === 'pi') return shell.openExternal('https://www.npmjs.com/package/pi-acp');
    if (preset === 'dsh') return shell.openExternal('https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.zh.md');
    throw new Error('请选择需要查看安装说明的 ACP 预设。');
  }
  if(!vendors.isVendor(engine))throw new Error('Choose an official account agent.');
  return shell.openExternal(vendors.catalog[engine].docs);
});
handle('agent-install', async engine => {
  if (quitting || confirmingQuit) throw new Error('工作台正在退出，请稍后重试。');
  if (!Object.hasOwn(vendors.packages, engine) && engine !== 'antigravity') throw new Error('请使用该 CLI 的官方安装方式。');
  const result = await cliUpdates.install(engine, { roleEditor: true });
  if (result.status === 'skipped') throw new Error('此 CLI 正在使用或已有操作进行中，请稍后重试。');
  if (result.status === 'failed') throw new Error('安装失败，请检查网络、Node.js 和本机目录权限。');
  return result;
});
handle('role-save', value => {
  if (value.avatarId && !avatars.get(value.avatarId)) throw new Error('The selected avatar no longer exists. Choose it again.');
  const slackToken = value.engine === slackChatEngine && value.slackToken ? slackUserToken(value.slackToken) : '';
  const role = store.saveRole(value);
  if (slackToken) vault.set(slackTokenKey(role.id), slackToken);
  if (role.engine !== slackChatEngine && vault.has(slackTokenKey(role.id))) vault.remove(slackTokenKey(role.id));
  if (value.apiKey && ![geminiWebEngine,slackChatEngine,'custom-acp'].includes(role.engine)) vault.set('api:' + role.id, value.apiKey);
  emit(); return role;
});
handle('role-enabled', (id, enabled) => {
  if (enabled === false && interactiveAgents.list().some(entry => entry.roleId === id && entry.state !== 'ended')) {
    throw new Error('请先结束此角色的交互终端，再禁用角色。');
  }
  const role = store.setRoleEnabled(id, enabled);
  emit();
  return role;
});
handle('workflow-priority-save', (ruleId, value) => {
  const rules = store.updateWorkflowPriority(ruleId, value);
  emit();
  return rules;
});
handle('avatar-list', () => ({ presets: avatars.defaults(), uploads: avatars.list() }));
handle('avatar-upload', async () => {
  const result = await dialog.showOpenDialog({ title: '选择角色头像', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  return avatars.import(result.filePaths[0]);
});
handle('role-delete', id => {
  if (busyRole(id)) throw new Error('请先结束此角色的任务和交互终端。');
  const memberships=store.state.chats.filter(c=>!c.disbandedAt&&c.roleIds.includes(id));
  if (memberships.length) throw new Error('请先从这些对话移除该角色：'+memberships.slice(0,3).map(chat=>chat.name).join('、')+(memberships.length>3?' 等':'')+'。');
  store.get('roles', id); store.state.roles = store.state.roles.filter(r => r.id !== id); for (const p of store.state.projects) p.roleIds = p.roleIds.filter(r => r !== id); vault.remove('api:' + id);
  if (vault.has(slackTokenKey(id))) vault.remove(slackTokenKey(id));
  store.state.workflowPriorities = store.state.workflowPriorities.map(rule => ({...rule,candidates:rule.candidates.filter(candidate => candidate.roleId !== id)})).filter(rule => rule.candidates.length);
  store.save(); emit();
});
handle('location-save', value => {
  const location = store.saveLocation(value); if (value.passphrase) vault.set('ssh:' + location.id, value.passphrase);
  if (value.mcpToken) vault.set('mcp:' + location.id, value.mcpToken);
  locations.disconnect(location.id); emit(); return location;
});
handle('location-proxy-save', (id, proxy) => { const location = store.saveLocationProxy(id, proxy); emit(); return location; });
handle('location-delete', id => {
  if (id === 'local' || id === 'relay-server') throw new Error('Built-in locations cannot be deleted.');
  if (store.state.roles.some(r => r.locationId === id) || store.state.projects.some(p => p.directories.some(d => d.locationId === id))) throw new Error('Remove this location from roles and projects first.');
  locations.disconnect(id); store.state.locations = store.state.locations.filter(l => l.id !== id); vault.remove('ssh:' + id); vault.remove('mcp:' + id); store.save(); emit();
});
handle('location-test', async id => { await locations.connect(id); const location = store.get('locations', id); if (location.type === 'ssh') return await locations.exec(id, location.os === 'linux' ? 'uname -s; command -v python3; command -v claude || true; command -v codex || true; command -v opencode || true' : 'ver'); return 'Local connection ready.'; });
const pendingSshSetups = new Set();
handle('location-setup-ssh-key', async (value, password) => {
  let draft;
  try {
    draft = store.prepareLocation(value);
  } catch (error) {
    throw new Error('请检查位置名称、主机地址、SSH 用户和端口。', { cause: error });
  }
  if (draft.managed || draft.os !== 'linux' || draft.type !== 'ssh') {
    throw new Error('此功能适用于手动添加的 Linux SSH 位置。');
  }
  if (password !== undefined && (typeof password !== 'string' || !password || password.length > 4096)) {
    throw new Error('请输入有效的 SSH 登录密码。');
  }
  const endpoint = JSON.stringify([draft.host.toLowerCase(), draft.port, draft.username]);
  if (pendingSshSetups.has(endpoint)) throw new Error('此 SSH 账号正在配置免密登录，请稍候。');
  const previous = value.id ? store.get('locations', value.id) : undefined;
  const credentialId = 'ssh:' + draft.id;
  const newPassphrase = draft.keyPath && typeof value.passphrase === 'string' ? value.passphrase : '';
  const savedPassphrase = draft.keyPath && draft.keyPath === previous?.keyPath ? vault.get(credentialId) : '';
  if (newPassphrase && !safeStorage.isEncryptionAvailable()) {
    throw new Error('系统凭据加密不可用，无法保存私钥口令。');
  }
  pendingSshSetups.add(endpoint);
  try {
    const result = await setupSshKey(locations, draft, { passphrase: newPassphrase || savedPassphrase || undefined, password });
    if (result.needsPassword) return result;
    if (previous && !store.state.locations.includes(previous)) {
      throw new Error('位置已被修改，请重新打开位置并测试连接。');
    }
    const next = { ...draft, keyPath: result.keyPath };
    const previousPassphrase = vault.get(credentialId);
    const nextPassphrase = newPassphrase || savedPassphrase;
    const updatePassphrase = passphrase => passphrase ? vault.set(credentialId, passphrase) : vault.remove(credentialId);
    if (nextPassphrase !== previousPassphrase) updatePassphrase(nextPassphrase);
    try {
      store.commitLocation(next);
    } catch (error) {
      if (nextPassphrase !== previousPassphrase) updatePassphrase(previousPassphrase);
      throw error;
    }
    if (previous && (newPassphrase || ['host', 'port', 'username', 'keyPath'].some(key => previous[key] !== next[key]))) {
      locations.disconnect(next.id);
    }
    emit();
    return { location: next };
  } finally {
    pendingSshSetups.delete(endpoint);
  }
});
handle('project-save', value => { const result = store.saveProject(value); emit(); return result; });
handle('project-move', (id, offset) => { if (![-1, 1].includes(offset)) return; const p = store.get('projects', id); const index = store.state.projects.indexOf(p); const target = index + offset; if (target >= 0 && target < store.state.projects.length) { store.state.projects.splice(index, 1); store.state.projects.splice(target, 0, p); store.save(); emit(); } });
handle('project-delete', async id => {
  const project = store.get('projects', id);
  const deletableChats = () => {
    const chats = store.state.chats.filter(chat => chat.projectId === id);
    if (running.has(planJobKey(id))) throw new Error('请先结束此项目的工作流生成任务。');
    if (chats.some(chat => inputQueue.dispatching.has(chat.id) || inputBusy(chat.id) || interactiveAgents.active(chat.id))) {
      throw new Error('请先结束此项目的运行任务和交互终端。');
    }
    return chats;
  };
  deletableChats();
  const answer = await dialog.showMessageBox({
    type: 'question', buttons: ['取消', '删除项目并归档'], defaultId: 0, cancelId: 0,
    message: `删除「${project.name}」？`,
    detail: '项目与聊天会从 AI 小队列表移除，并存入本机归档。磁盘上的工作目录和文件将保留。',
  });
  if (answer.response !== 1) return false;
  const {projects, chats:allChats}=store.state;
  if (!projects.some(item=>item.id===id)) return false;
  const chats=deletableChats();
  require('./store.cjs').atomic(path.join(data, 'archive', id + '-' + Date.now() + '.json'), { project:store.get('projects',id), chats });
  store.state.projects=projects.filter(item=>item.id!==id);
  store.state.chats=allChats.filter(chat=>chat.projectId!==id);
  try { store.save(); }
  catch (error) { store.state.projects=projects;store.state.chats=allChats;throw error; }
  for (const manager of terminalManagers.values()) manager.closeProject(id);
  emit(); updateBadges(); return true;
});
handle('chat-add', value => { const chat = store.createChat(value); emit(); return chat; });
const workflowEngine=require('./workflow.cjs');
const generatedWorkflows=require('./generated-workflow.cjs');
const workflowRatings=require('./workflow-ratings.js');
const graphWorkflows=require('./graph-workflow.cjs');
const structuredWorkflows=require('./structured-workflow.cjs');
const groupWorkflows=require('./group-workflows.cjs');
const engineForWorkflow = flow => flow.type === 'graph' ? graphWorkflows : flow.type === 'generated' ? generatedWorkflows : workflowEngine;
handle('workflow-template-save', value=>{
  const template=graphWorkflows.validate(value);
  const previous=store.state.workflowTemplates || [];
  const saved={...template,id:randomUUID()};
  store.state.workflowTemplates=[saved,...previous];
  try { store.save(); } catch (error) { store.state.workflowTemplates=previous; throw error; }
  emit();
  return saved;
});

function workflowProjectRoles(project, roles = project.roleIds.map(id => store.state.roles.find(role => role.id === id))) {
  return roles
    .filter(role => {
      if (!workflowEngine.canModerate(role) || !project.directories.some(directory => directory.locationId === role.locationId)) return false;
      const location = store.state.locations.find(item => item.id === role.locationId);
      return location?.type === 'local' || (location?.os === 'linux' && role.provider === 'native');
    })
    .map(role => ({...role, locationName:locationName(role.locationId)}));
}

function workflowRoleIds(flow) {
  if (flow.type==='graph') return graphWorkflows.roleIds(flow);
  const ids = flow.type === 'generated' ? flow.nodes.flatMap(node => node.roleIds || []) : [...flow.teams.implement, ...flow.teams.review];
  if (flow.moderatorRoleId) ids.push(flow.moderatorRoleId);
  return [...new Set(ids)];
}
function workflowModerationRole(project, id) {
  const role = store.state.roles.find(item => item.id === id);
  if (!workflowEngine.canModerate(role)) throw new Error('请选择已启用且能自动运行的角色担任工作流主持人。');
  if (!project.directories.some(directory => directory.locationId === role.locationId)) {
    throw new Error(formatMissingProjectDirectories(project, [role], locationName));
  }
  return role;
}
const planJobKey = projectId => `workflow-plan:${projectId}`;
handle('workflow-plan',async ({projectId, goal, plannerId, requestId}) => {
  const project = store.get('projects',projectId);
  const planner = workflowModerationRole(project, plannerId), key = planJobKey(project.id);
  ensureCliReady(planner);
  const roles = workflowProjectRoles(project, store.state.roles.filter(role => role.id === plannerId || project.roleIds.includes(role.id)));
  if (!roles.some(role => role.id === plannerId)) throw new Error('此角色无法在当前项目的运行位置生成工作流。');
  if (typeof requestId !== 'string' || requestId.length > 80 || running.has(key) || running.size+interactiveAgents.list().filter(entry=>entry.state!=='ended').length>=store.state.settings.maxJobs) {
    throw new Error('Wait for an available workspace task slot to generate a workflow.');
  }
  const task = generatedWorkflows.planTask(goal, workflowRatings.catalog(store.state.workflowPriorities));
  const controller = new AbortController(), deadline = AbortSignal.timeout(workflowEngine.routingTimeoutMs);
  running.set(key, {phase:'workflow-plan', requestId, controller, roleIds:[plannerId], roleId:plannerId});
  emit();
  try {
    const result = await agents.run(null, planner, project, AbortSignal.any([controller.signal, deadline]), false, {moderatorTask:task});
    if (controller.signal.aborted) return null;
    if (deadline.aborted) throw new Error('Workflow generation timed out. Try again with a shorter goal.');
    if (result.status !== 'complete' || result.warningCode === 'CLAUDE_PERMISSION_DENIED') throw new Error('Workflow generation failed. Check the planner connection, login, and quota.');
    return task.decode(result.text);
  } finally {
    running.delete(key); emit(); setImmediate(pumpWorkflows);
  }
});
handle('workflow-plan-cancel',(projectId,requestId)=>{
  const job = running.get(planJobKey(projectId));
  if (job?.requestId === requestId) job.controller.abort();
});
function pumpWorkflows(){
  if(quitting||running.size+interactiveAgents.list().filter(entry=>entry.state!=='ended').length>=store.state.settings.maxJobs)return;
  const legacyBusy=[...running.values()].some(job=>job.workflow&&!job.workflowRunId);
  const next=store.state.chats.filter(item=>!item.disbandedAt&&!inputBusy(item.id,true)&&!inputQueue.dispatching.has(item.id))
    .map(chat=>({chat,flow:chat.workflow?(legacyBusy?undefined:chat.workflow):groupWorkflows.activeRun(chat)}))
    .filter(({flow})=>flow?.status==='queued' && !workflowRoleIds(flow).some(id =>
      cliUpdates.isInstalling(store.state.roles.find(role => role.id === id))))
    .sort((a,b)=>a.flow.createdAt-b.flow.createdAt)[0];
  if(!next)return;
  const {chat,flow}=next, controller=new AbortController();
  const embedded=Boolean(flow.id);
  const executionChat=embedded?{...chat,workflow:flow,
    get messages(){return chat.messages.filter(message=>message.workflowRunId===flow.id);}}:chat;
  const generated = Array.isArray(flow.nodes);
  const job={workflow:true,workflowRunId:embedded?flow.id:undefined,controller,forceStopId:randomUUID(),
    roleIds:embedded?workflowRoleIds(flow):chat.roleIds,round:generated?(flow.nodeIndex ?? 0)+1:flow.round,rounds:generated?flow.nodes.length:flow.limit};
  running.set(chat.id,job);
  setImmediate(pumpWorkflows);
  const save=()=>{if(!embedded||!groupWorkflows.publish(store,chat,flow))store.save();emit();};
  const currentProject = () => store.get('projects',chat.projectId);
  engineForWorkflow(flow).run(executionChat,{
    signal:controller.signal,save,
    roleEnabled: id => store.state.roles.some(role => role.id === id && role.enabled !== false),
    roles:() => workflowProjectRoles(currentProject()),
    priorityRoles:() => workflowProjectRoles(currentProject(), store.state.roles),
    priorities:() => store.state.workflowPriorities,
    describe(id) {
      const role = store.state.roles.find(item => item.id === id);
      return role && {name:role.name, engine:role.engine, location:locationName(role.locationId), persona:role.persona?.slice(0, 600)};
    },
    route: flow.moderatorRoleId ? async (task, signal) => {
      if (store.state.roles.find(role => role.id === flow.moderatorRoleId)?.enabled === false) return;
      const project = currentProject();
      if (generated && !project.roleIds.includes(flow.moderatorRoleId)) return;
      const role = effectiveRole(chat, workflowModerationRole(project, flow.moderatorRoleId));
      job.phase = 'workflow-route'; job.roleId = role.id; job.round = generated?flow.nodeIndex+1:flow.round; job.taskId = undefined;
      emit();
      const message = await agents.run(chat.id, role, project, signal, false, {moderatorTask:task});
      if (message.status !== 'complete' || signal.aborted) return;
      if (message.warningCode === 'CLAUDE_PERMISSION_DENIED') {
        message.status = 'failed';
        return;
      }
      try {
        const selected = task.select(message.text);
        const result = typeof selected === 'string' ? {roleId:selected} : selected;
        message.moderatorResult = {kind:task.kind, ...result, roleName:store.state.roles.find(item => item.id === result.roleId)?.name};
        message.text = '';
        return selected;
      } catch (error) {
        message.status = 'failed'; message.note = error.message; message.text = '';
      }
    } : undefined,
    async turn(attempt,prompt,signal,structuredNode) {
      job.phase='participant';job.roleId=attempt.roleId;job.round=generated?(attempt.nodeIndex ?? flow.attempts.length-1)+1:attempt.round;job.taskId=attempt.id;
      const role=store.state.roles.find(r=>r.id===attempt.roleId);
      attempt.roleName=role?.name||attempt.roleId;
      if (cliUpdates.isInstalling(role)) return { status:'failed', workflowSubmitted:false, errorCode:'ROLE_UNAVAILABLE',
        note:'此角色使用的 CLI 正在更新，请稍后重试。' };
      if (role?.enabled === false) return {status:'failed',workflowSubmitted:false,errorCode:'ROLE_UNAVAILABLE',note:'角色「'+role.name+'」已禁用。'};
      if(!workflowEngine.canModerate(role))return {status:'failed',workflowSubmitted:false,errorCode:'ROLE_UNAVAILABLE',
        note:flow.type==='graph'?'此角色当前无法自动执行任务。':'Role unavailable for unattended execution.'};
      const project=currentProject();
      if (flow.type==='graph' && (structuredNode || flow.nodes[flow.nodeIndex]).localOnly && role.locationId!=='local') {
        return {status:'failed',workflowSubmitted:false,errorCode:'ROLE_UNAVAILABLE',note:'本机验证节点需要本机角色。'};
      }
      if (generated && !workflowProjectRoles(project, flow.selection?.via === 'priority' ? [role] : undefined).some(candidate=>candidate.id===role.id)) {
        return {status:'failed',workflowSubmitted:false,errorCode:'ROLE_UNAVAILABLE',note:'Role unavailable for unattended execution.'};
      }
      if (!project.directories.some(directory => directory.locationId === role.locationId)) {
        return {status:'failed',workflowSubmitted:false,errorCode:'ROLE_UNAVAILABLE',note:formatMissingProjectDirectories(project, [role], locationName)};
      }
      if (!embedded&&!chat.roleIds.includes(role.id)) chat.roleIds.push(role.id);
      const path=attempt.path || (generated?[{title:flow.nodes[attempt.nodeIndex].title}]:
        [{title:attempt.stage==='review'?'验收':'执行',round:attempt.round}]);
      const step=embedded?{workflowRunId:flow.id,workflowTitle:flow.title,workflowPath:path}:{};
      store.message(chat.id,{kind:'user',text:prompt,status:'accepted',workflowAttemptId:attempt.id,
        ...step,...(embedded?{workflowInstruction:true}:{})});
      emit();
      const closeSkills = () => skills.closeTask(attempt.id);
      signal.addEventListener('abort', closeSkills, {once:true});
      try {
        const context=embedded?{workflowContextRunId:flow.id,workflowTitle:flow.title,workflowPath:path,
          messages:groupWorkflows.context(chat,flow,attempt.id),ignoreModeratorMemory:true,discussion:undefined}:{};
        const receipt=await agents.run(chat.id,effectiveRole(chat,role),project,signal,false,{...context,relayReplies:true,workflowAttemptId:attempt.id,taskId:attempt.id});
        if (embedded&&receipt.stopConfirmed===false&&receipt.status!=='complete'&&
            (signal.aborted||flow.type==='graph'||!workflowEngine.unavailable(receipt))) flow.stopUnconfirmed=true;
        return receipt;
      } finally {
        signal.removeEventListener('abort', closeSkills);
      }
    },
  }).catch(error=>{
    if (!structuredWorkflows.publishedStatuses.has(flow.status)) {
      flow.status='needs_check';flow.reason='工作流执行中断，请查看运行记录后重试。\n'+error.message;
    }
  }).finally(()=>{
    running.delete(chat.id);
    try {
      if (!embedded||!groupWorkflows.publish(store,chat,flow))store.save();
    } catch (error) {
      console.error('Could not save workflow completion:',error);
      if (!flow.publishedAt) {flow.status='needs_check';flow.reason='未能保存运行结果，请检查工作区存储后重试。';}
    }
    if (quitting || !notifications.complete(chat.id,{workflow:true,run:embedded?flow:undefined})) { emit();updateBadges(); }
    if (embedded) inputQueue.kick(chat.id);
    setImmediate(pumpWorkflows);
  });
}

function groupWorkflowChat(id) {
  const chat=activeChat(id);
  if (chat.workflow) throw new Error('请在普通群聊的工作流面板中操作。');
  return chat;
}

function groupWorkflowRun(id, runId) {
  const chat=groupWorkflowChat(id), flow=chat.workflowRuns?.find(run=>run.id===runId);
  if (!flow) throw new Error('找不到这次工作流运行，请重新选择。');
  return {chat,flow};
}

function ensureWorkflowSlot(chat) {
  if (groupWorkflows.activeRun(chat)||inputBusy(chat.id)||inputQueue.dispatching.has(chat.id)||interactiveAgents.active(chat.id)) {
    throw new Error('请先结束此群聊正在运行的任务或交互终端。');
  }
}

function configureGroupWorkflow(chat, value, goal, saving=false) {
  const project=store.get('projects',chat.projectId);
  if (value.type==='generated') return generatedConfiguration({...value,goal:goal||'Use the conversation at workflow start.'},project);
  if (value.type==='teams') {
    if (value.moderatorRoleId) workflowModerationRole(project,value.moderatorRoleId);
    return {type:'teams',title:value.title,...workflowEngine.configure({...value,goal:goal||'Use the conversation at workflow start.'},
      store.state.roles.filter(role=>workflowEngine.canModerate(role)&&project.directories.some(dir=>dir.locationId===role.locationId)))};
  }
  return saving?graphWorkflows.validate(value):graphWorkflows.configure({...value,goal},
    workflowProjectRoles(project,store.state.roles),{optionalGoal:true});
}

handle('workflow-group-save',(id,definitionId,value)=>{
  const chat=groupWorkflowChat(id);
  const previous=chat.workflowDefinitions||[];
  if (definitionId && !previous.some(item=>item.id===definitionId)) throw new Error('找不到要保存的工作流。');
  if (definitionId && groupWorkflows.activeRun(chat)?.definitionId===definitionId) throw new Error('请停止工作流后再编辑。');
  const configured=configureGroupWorkflow(chat,value,'',true);
  const title=typeof configured.title==='string'&&configured.title.trim();
  if (!title||title.length>100) throw new Error('请填写工作流名称（最多 100 字）。');
  const idValue=definitionId||randomUUID();
  let definition={...configured,id:idValue,title};
  if (configured.type==='generated') {
    const {nodes,reworkLimit,moderatorRoleId}=configured;
    definition={id:idValue,type:'generated',title,nodes,reworkLimit,moderatorRoleId};
  } else if (configured.type==='teams') {
    const {teams,moderatorRoleId,criteria,limit}=configured;
    definition={id:idValue,type:'teams',title,teams,moderatorRoleId,criteria,limit};
  }
  if (groupWorkflows.sourceIds(definition).some(source=>!store.state.chats.some(item=>item.id===source))) {
    throw new Error('有来源群聊已删除，请重新选择。');
  }
  chat.workflowDefinitions=definitionId?previous.map(item=>item.id===definitionId?definition:item):[...previous,definition];
  try { store.save(); } catch (error) { chat.workflowDefinitions=previous; throw error; }
  emit();
  return definition;
});

function startGroupWorkflow(id,definitionId,goal='',savedDefinition) {
  const chat=groupWorkflowChat(id);
  ensureWorkflowSlot(chat);
  const definition=savedDefinition || chat.workflowDefinitions?.find(item=>item.id===definitionId);
  if (!definition) throw new Error('请先保存工作流。');
  if (chat.workflowRuns?.some(run=>run.definitionId===definitionId&&groupWorkflows.resumableStatuses.has(run.status))) {
    throw new Error('请先继续或结束这个工作流的上一次运行。');
  }
  if (typeof goal!=='string'||goal.length>16000) throw new Error('任务目标最多 16000 字。');
  const flow=configureGroupWorkflow(chat,definition,goal.trim());
  const at=Date.now();
  const sourceSnapshots=Object.fromEntries(groupWorkflows.sourceIds(flow).map(source=>{
    const sourceChat=store.state.chats.find(item=>item.id===source);
    if (!sourceChat) throw new Error('有来源群聊已删除，请修改上文节点后重试。');
    return [source, source===id?{name:chat.name,at}:groupWorkflows.freeze(sourceChat,at)];
  }));
  const previous=chat.workflowRuns||[];
  Object.assign(flow,{id:randomUUID(),definitionId,sourceSnapshots,baseSnapshot:groupWorkflows.freeze(chat,at)});
  chat.workflowRuns=[...previous,flow];
  if (goal.trim()) {
    const updatedAt=chat.updatedAt;
    try { store.message(id,{kind:'user',text:goal.trim(),status:'accepted',workflowRunId:flow.id,workflowTitle:flow.title}); }
    catch (error) { chat.workflowRuns=previous; chat.messages.pop();chat.updatedAt=updatedAt;throw error; }
  } else {
    try { store.save(); } catch (error) { chat.workflowRuns=previous; throw error; }
  }
  emit();setImmediate(pumpWorkflows);
  return flow.id;
}
handle('workflow-group-start',(id,definitionId,goal='')=>startGroupWorkflow(id,definitionId,goal));
handle('schedule-workflow',(id,definitionId,goal,at)=>{
  const chat=groupWorkflowChat(id), definition=chat.workflowDefinitions?.find(item=>item.id===definitionId);
  if (!definition) throw new Error('请先保存工作流。');
  if (typeof goal !== 'string' || goal.length > 16000) throw new Error('任务目标最多 16000 字。');
  configureGroupWorkflow(chat,definition,goal.trim());
  return addSchedule(chat, scheduledTasks.entry('workflow',at,{definition:structuredClone(definition),goal:goal.trim()}));
});

handle('workflow-group-stop',(id,runId)=>{
  const {chat,flow}=groupWorkflowRun(id,runId);
  if (flow.status==='queued') {
    flow.status='paused';store.save();inputQueue.kick(chat.id);emit();
  } else if (flow.status==='running'&&running.get(id)?.workflowRunId===flow.id) {
    interruptChat(id);emit();
  }
});

handle('workflow-group-resume',(id,runId,guidance='')=>{
  const {chat,flow}=groupWorkflowRun(id,runId);
  ensureWorkflowSlot(chat);
  if (!groupWorkflows.resumableStatuses.has(flow.status)) throw new Error('这次运行当前无法继续。');
  if (typeof guidance!=='string'||guidance.length>16000) throw new Error('补充说明最多 16000 字。');
  if (!guidance.trim() && flow.type==='graph' && graphWorkflows.continueReportedNode({...chat,workflow:flow})) {
    chat.unread=false;
    if (!groupWorkflows.publish(store,chat,flow)) store.save();
    emit();setImmediate(pumpWorkflows);return;
  }
  if (guidance.trim()) store.message(id,{kind:'user',text:guidance.trim(),status:'accepted',workflowRunId:flow.id,workflowTitle:flow.title});
  if (flow.type==='generated'||flow.type==='teams') {
    delete flow.candidateOrder;
    if (flow.selection?.via!=='priority'||flow.status==='unavailable'||!flow.selection.items.length) {
      delete flow.selection;
      flow.index=0;
    }
  }
  flow.pending=null;flow.status='queued';flow.reason='';chat.unread=false;
  store.save();emit();setImmediate(pumpWorkflows);
});

handle('workflow-group-finish',(id,runId)=>{
  const {chat,flow}=groupWorkflowRun(id,runId);
  if (!groupWorkflows.resumableStatuses.has(flow.status)||running.has(id)||flow.stopUnconfirmed) throw new Error('请等待当前步骤确认停止后再结束运行。');
  const {status,reason}=flow;
  flow.status='unresolved';
  flow.reason=flow.reason?'手动结束运行。\n'+flow.reason:'手动结束运行。';
  try { groupWorkflows.publish(store,chat,flow); }
  catch (error) { Object.assign(flow,{status,reason});throw error; }
  emit();inputQueue.kick(id);
});

handle('workflow-group-confirm-stop',(id,runId)=>{
  const {flow}=groupWorkflowRun(id,runId);
  if (running.has(id)||!flow.stopUnconfirmed) throw new Error('请核对这次运行的停止状态。');
  delete flow.stopUnconfirmed;store.save();emit();inputQueue.kick(id);
});
function generatedConfiguration(value, project, stepOffset = 0) {
  const roles = workflowProjectRoles(project, store.state.roles);
  if (!roles.length) throw new Error('请先为已启用角色的运行位置配置项目目录。');
  if (value.moderatorRoleId) {
    workflowModerationRole(project,value.moderatorRoleId);
    if (!roles.some(role => role.id === value.moderatorRoleId)) throw new Error('此角色无法在当前项目的运行位置主持工作流。');
  }
  return generatedWorkflows.configure(value,roles,stepOffset);
}
handle('workflow-create',value=>{
  const project = store.get('projects',value.projectId);
  const generated = value.type === 'generated';
  const graphRoles = value.type === 'graph' ? workflowProjectRoles(project,store.state.roles) : null;
  const workflow = graphRoles ? graphWorkflows.configure(value,graphRoles) :
    generated ? generatedConfiguration(value,project) : workflowEngine.configure(value,store.state.roles.filter(role => role.enabled !== false));
  if (!generated && workflow.moderatorRoleId) workflowModerationRole(project,workflow.moderatorRoleId);
  const roleIds = workflowRoleIds(workflow).filter(id=>!graphRoles || graphRoles.some(role=>role.id===id));
  if (generated) {
    const existing = workflowProjectRoles(project).filter(role => !roleIds.includes(role.id));
    roleIds.push(...existing.slice(0, Math.max(0, 100 - roleIds.length)).map(role => role.id));
    if (!roleIds.length) {
      const configured = new Set(workflow.nodes.filter(node => node.mode === 'auto').flatMap(node =>
        workflowRatings.findRule(store.state.workflowPriorities, node)?.candidates.map(candidate => candidate.roleId) || []));
      roleIds.push(...workflowProjectRoles(project, store.state.roles).filter(role => configured.has(role.id)).slice(0, 100).map(role => role.id));
    }
  }
  if (!roleIds.length) throw new Error('请选择主持人、指定候选角色，或先为项目添加角色。');
  const title=workflow.title||workflow.goal.slice(0,70);
  const seed={workflow};
  if (value.startAt !== undefined) {
    seed.scheduledTasks=[scheduledTasks.entry('standalone',value.startAt,{title})];
    workflow.status='scheduled';
  }
  const chat=store.createChat({projectId:project.id,name:title,roleIds},seed);
  emit();setImmediate(pumpWorkflows);return {id:chat.id,projectId:chat.projectId};
});
handle('workflow-resume',(id,mode,guidance='')=>{
  const chat=activeChat(id),flow=chat.workflow;
  if(!flow||running.has(id)||!['unavailable','paused','needs_check'].includes(flow.status)||
      !((flow.nodes?['retry']:['review','retry']).includes(mode)))throw new Error('Workflow cannot resume from this state.');
  if(typeof guidance!=='string'||guidance.length>16000)throw new Error('Enter up to 16,000 characters of additional guidance.');
  if(guidance.trim())store.message(id,{kind:'user',text:guidance.trim(),status:'accepted'});
  if(mode==='review')flow.stage='review';
  delete flow.candidateOrder;
  if (flow.selection?.via !== 'priority' || flow.status === 'unavailable' || !flow.selection.items.length) {
    delete flow.selection;
    flow.index = 0;
  }
  flow.pending=null;flow.status='queued';flow.reason='';
  chat.unread=false;
  store.save();emit();updateBadges();setImmediate(pumpWorkflows);
});
handle('workflow-generated-update',(id,value)=>{
  const chat=activeChat(id),flow=chat.workflow;
  if(flow?.type!=='generated'||running.has(id)||!['unavailable','needs_check','paused'].includes(flow.status))throw new Error('Teams can be changed while the workflow is stopped.');
  if(!Array.isArray(value.nodes)||value.nodes.length!==flow.nodes.length)throw new Error('The number of steps cannot change after the workflow starts.');
  const project = store.get('projects',chat.projectId);
  const next=generatedConfiguration({...value,goal:flow.goal,reworkLimit:flow.reworkLimit,nodes:value.nodes.slice(flow.nodeIndex)},project,flow.nodeIndex);
  flow.nodes=[...flow.nodes.slice(0,flow.nodeIndex),...next.nodes];
  flow.reworkLimit=next.reworkLimit;
  flow.moderatorRoleId=next.moderatorRoleId;flow.index=0;
  const selected = workflowRoleIds(next);
  chat.roleIds = [...new Set([...chat.roleIds, ...selected])];
  project.roleIds = [...new Set([...project.roleIds, ...selected])];
  delete flow.selection;
  store.save();emit();
});
handle('workflow-teams',(id,teams,moderatorRoleId)=>{
  const chat=activeChat(id),flow=chat.workflow;
  if(!flow||flow.nodes||running.has(id)||!['unavailable','needs_check','paused'].includes(flow.status))throw new Error('Teams can be changed while the workflow is stopped.');
  const updated=workflowEngine.configure({...flow,teams,moderatorRoleId:moderatorRoleId ?? flow.moderatorRoleId},store.state.roles.filter(role => role.enabled !== false));
  if (updated.moderatorRoleId) workflowModerationRole(store.get('projects',chat.projectId), updated.moderatorRoleId);
  flow.teams=updated.teams;flow.moderatorRoleId=updated.moderatorRoleId;flow.index=0;
  delete flow.candidateOrder;
  chat.roleIds=[...new Set([...chat.roleIds,...workflowRoleIds(flow)])];
  store.save();emit();
});
handle('chat-branch',(id,name)=>{
  const source=store.get('chats',id);
  const created=require('./chat-branch.cjs').branch(store,source,name);
  emit();return {id:created.id,projectId:created.projectId};
});
handle('chat-handoff',(sourceId,targetId,recipientIds,prompt)=>{
  const source=store.get('chats',sourceId),target=activeChat(targetId);
  target.draft=require('./chat-branch.cjs').handoffDraft(source,target,store.state.roles,recipientIds,prompt);
  store.save();emit();return {id:target.id,projectId:target.projectId};
});
function activeChat(id) {
  const chat=store.get('chats',id);
  if(chat.disbandedAt)throw new Error('群聊已解散，聊天记录只读。');
  return chat;
}
handle('chat-save', value => { activeChat(value.id);store.saveChat(value); emit(); });
handle('chat-disband', id => {
  const chat=activeChat(id);
  if(chat.roleIds.length<2)throw new Error('只有群聊可以解散。');
  if(inputBusy(id)||interactiveAgents.active(id)||inputQueue.dispatching.has(id))throw new Error('请先结束群聊任务和交互终端。');
  if(chat.inputQueue?.length)throw new Error('请先处理待发送消息。');
  if(chat.scheduledTasks?.length)throw new Error('请先取消此群聊的定时任务。');
  if(chat.draft?.trim()||chat.draftAttachments?.length)throw new Error('请先处理输入框中的草稿和附件。');
  chat.disbandedAt=Date.now();chat.unread=false;store.save();emit();updateBadges();
});
handle('chat-role-settings', (chatId, roleId, value) => {
  activeChat(chatId);
  const chat = store.saveChatRole(chatId, roleId, value);
  emit(); return chat;
});
handle('chat-session-reset',(chatId,roleId)=>{const chat=store.get('chats',chatId);if(!chat.roleIds.includes(roleId))throw new Error('Choose a participant in this chat.');if(running.has(chatId)||interactiveAgents.active(chatId))throw new Error('Pause the discussion and end its interactive terminal before resetting a native session.');if(chat.nativeSessions)delete chat.nativeSessions[roleId];store.save();emit();return snapshot();});
handle('chat-flow', (chatId, value) => { activeChat(chatId);const chat = store.saveChatFlow(chatId, value); emit(); return chat; });
handle('chat-order', (chatId, ids) => { activeChat(chatId);const chat = store.saveChatOrder(chatId, ids); emit(); return chat; });
handle('chat-delete', id => {
  if (inputQueue.dispatching.has(id)||running.has(id)||interactiveAgents.active(id)||[...skills.jobs.values()].some(j=>j.chatId===id)) throw new Error('请先结束此对话中的任务、技能和交互终端。');
  const chat = store.get('chats', id);
  require('./store.cjs').atomic(path.join(data, 'archive', id + '.json'), chat);
  const previous = store.state.chats;
  store.state.chats = previous.filter(c => c.id !== id);
  try { store.save(); }
  catch (error) { store.state.chats = previous; throw error; }
  emit();
  updateBadges();
});
handle('draft', (id, text) => store.saveDraft(activeChat(id), String(text).slice(0, 150000)));
handle('attachment-stage',(id,paths)=>{const files=attachments.add(id,paths);emit();return files;});
handle('attachment-remove',(id,fileId)=>{const files=attachments.remove(id,fileId);emit();return files;});
handle('attachment-restore',(id,messageId)=>{const draft=attachments.restore(id,messageId);emit();return draft;});
handle('chat-discussion',(id,value)=>{activeChat(id);const result=store.saveChatDiscussion(id,value);emit();return result;});
handle('read', id => notifications.read(id));
handle('gemini-web-open', (chatId,roleId) => chatId ? geminiWeb.openChat(chatId,roleId) : shell.openExternal(geminiWebHome));
handle('gemini-web-link', (chatId,roleId,url) => { const result=geminiWeb.saveLink(chatId,roleId,url); emit(); return result; });
handle('gemini-web-open-turn', (chatId,messageId) => geminiWeb.openTurn(chatId,messageId));
handle('gemini-web-clipboard-reply', (chatId,messageId) => geminiWeb.clipboardReply(chatId,messageId));
handle('gemini-web-reply', (chatId,messageId,reply) => geminiWeb.submitReply(chatId,messageId,reply));
function requireEnabledRoles(ids) {
  const disabled = ids.map(id => store.get('roles', id)).filter(role => role.enabled === false);
  if (disabled.length) throw new Error('角色「'+disabled.map(role => role.name).join('、')+'」已禁用，请启用后继续，或改选其他角色。');
}
function prepareInput(value, queued=false){
  const chat=activeChat(value.chatId),project=store.get('projects',chat.projectId);
  if(chat.workflow)throw new Error('Use the workflow controls for this run.');
  const invocation=value.summary||value.plain?null:require('./skills.cjs').parseCommand(value.text,skills.list(),{rejectDisabled:true});
  if(value.roleIds!==undefined&&(!Array.isArray(value.roleIds)||!value.roleIds.length||
    value.roleIds.length>chat.roleIds.length+project.roleIds.length||value.roleIds.some(id=>typeof id!=='string')))throw new Error('请选择发言角色。');
  const available = chat.roleIds.filter(id => store.state.roles.some(role => role.id === id && role.enabled !== false));
  const roleIds=value.roleIds!==undefined?[...new Set(value.roleIds)]:value.roleId==='all'?available:value.roleId?[value.roleId]:require('./conversations.cjs').replyRoleIds(chat, available);
  if (!roleIds.length) throw new Error('此对话没有已启用的角色，请先启用或邀请一位角色。');
  const guests = roleIds.filter(id=>!chat.roleIds.includes(id));
  if (guests.length) {
    const eligible = projectGuestIds(chat,project);
    if (value.summary || project.allowGuestMentions === false || guests.some(id=>!eligible.includes(id))) {
      throw new Error('部分点名角色当前无法在此群聊发言，请检查项目角色和点名设置。');
    }
  }
  requireEnabledRoles(roleIds);
  const files=queued?attachments.validate(value.files||[]):attachments.select(chat.id,value.summary?[]:value.attachmentIds||[]);
  const text=String(value.text||'');if(!text.trim()&&!files.length)throw new Error('Enter a message.');
  if(text.length>150000)throw new Error('Message is too long. Attach a path instead.');
  const requestedRounds=discussion.limit(value.summary?1:value.rounds??chat.maxRounds??1),autoStop=value.autoStop??chat.autoStop??true;
  if(typeof autoStop!=='boolean')throw new Error('Choose whether AI may end the discussion early.');
  const roles = roleIds.map(id=>store.get('roles',id));
  const slackTargets = roles.filter(role => role.engine === slackChatEngine)
    .map(role => ({roleId:role.id, channel:role.slackChannel}));
  const queuedTargets = value.slackTargets || (value.slackTarget ? [value.slackTarget] : []);
  if (queued && (slackTargets.length !== queuedTargets.length || slackTargets.some((target, index) =>
    target.roleId !== queuedTargets[index]?.roleId || target.channel !== queuedTargets[index]?.channel))) {
    throw new Error('待发送消息的 Slack 私信配置已变化。请恢复草稿并重新确认收件人。');
  }
  let slackText;
  if (slackTargets.length) {
    if (files.length || value.summary || invocation || value.mode === 'steer' || interactiveAgents.active(chat.id)) {
      throw new Error('Slack 私信角色支持普通文字发言。请移除附件、技能或结束交互连接后再发送。');
    }
    if (new Set(slackTargets.map(target => target.channel)).size !== slackTargets.length) {
      throw new Error('这次选中的多个角色绑定了同一条 Slack 私信，请只选其中一位。');
    }
    const possibleRoles = [...chat.roleIds, ...projectGuestIds(chat, project)]
      .map(id => store.state.roles.find(role => role.id === id)).filter(Boolean)
      .map(role => ({ ...role, guest: !chat.roleIds.includes(role.id) }));
    const mentions = resolveMentions(text, possibleRoles, chat.defaultReplyRoleIds);
    slackText = queued && typeof value.slackText === 'string' ? value.slackText : mentions.explicit ? mentions.content : text;
    if (!slackText.trim()) throw new Error('请在点名后输入要发给 Slack 角色的文字。');
    if (slackText.length > slackMaxText) throw new Error(`Slack 私信最多支持 ${slackMaxText} 个字符。`);
    if (slackTargets.some(target => !vault.has(slackTokenKey(target.roleId)))) throw new Error('请在角色设置保存 Slack 用户授权令牌。');
  }
  if(invocation?.skill.kind==='image'){if(files.length)throw new Error('首版生图技能仅接收文字；附件已保留，请移除附件或改用聊天发送。');skills.validate(invocation.skill.id,invocation.prompt);}
  else {
    if(files.length&&roles.some(role=>role.engine===geminiWebEngine))throw new Error('Gemini 网页版角色仅支持文字。请移除附件，或改选其他角色。');
    const missingRoles = roles.filter(role => ![geminiWebEngine,slackChatEngine].includes(role.engine) &&
      !project.directories.some(directory => directory.locationId === role.locationId));
    if (missingRoles.length) throw new Error(formatMissingProjectDirectories(project, missingRoles, locationName));
  }
  if(interactiveAgents.active(chat.id)&&(guests.length||roleIds.length!==1||value.summary||store.get('roles',roleIds[0]).engine===geminiWebEngine))throw new Error('交互连接期间，请 @ 一位已连接角色发送。群聊接力请先结束交互连接。');
  return {chat,project,invocation,roleIds,files,text,requestedRounds,autoStop,slackTargets,slackText};
}
function queueInput(prepared, value) {
  const {chat,roleIds,files,text,requestedRounds,autoStop}=prepared;
  const roleSettings=Object.fromEntries(roleIds.map(id=>{
    const role=effectiveRole(chat.roleIds.includes(id)?chat:null,store.get('roles',id));
    return [id,{model:role.model||'',effort:role.effort||'',persona:role.persona||'',examples:role.examples||''}];
  }));
  const slack = prepared.slackTargets.length ? {slackTargets:prepared.slackTargets, slackText:prepared.slackText} : {};
  return {chatId:chat.id,text,files,roleIds,rounds:requestedRounds,autoStop,summary:Boolean(value.summary),roleSettings,...slack,plain:value.plain===true};
}
function submitChat(value) {
  const prepared=prepareInput(value), {chat,roleIds,text}=prepared;
  const input=queueInput(prepared,value);
  if (value.mode === 'steer') {
    if(roleIds.length!==1||input.files.length||value.summary||prepared.invocation)throw new Error('插话只能向一位正在运行的 Codex 角色发送文字。输入内容已保留。');
    const result = interactiveAgents.submit(chat.id,roleIds[0],{text,settings:input.roleSettings[roleIds[0]],steer:true});
    if (chat.draft === text) chat.draft = '';
    store.save(); emit();
    return result;
  }
  return inputQueue.submit(chat.id,input,value.mode||'queue');
}
handle('send', value => submitChat({ ...value, plain: false }));
function addSchedule(chat, task, consumeDraft = false) {
  if (quitting || confirmingQuit) throw new Error('工作台正在退出，请稍后重试。');
  const previous={scheduledTasks:chat.scheduledTasks,draft:chat.draft,draftAttachments:chat.draftAttachments};
  if ((previous.scheduledTasks?.length || 0) >= 20) throw new Error('此对话最多保留 20 项定时任务。');
  chat.scheduledTasks=[...(previous.scheduledTasks||[]),task];
  if (consumeDraft) {
    if (chat.draft===task.value.text) chat.draft='';
    attachments.consume(chat.id,task.value.files);
  }
  try { store.save(); } catch (error) { Object.assign(chat,previous); throw error; }
  emit();
  return {accepted:true, id:task.id};
}
handle('schedule-message',(value,at)=>{
  const request={...value, summary:false, plain:false, mode:'queue'}, prepared=prepareInput(request);
  return addSchedule(prepared.chat, scheduledTasks.entry('message',at,queueInput(prepared,request)), true);
});
handle('schedule-edit',(chatId,taskId,at)=>{
  const chat=activeChat(chatId), previous=chat.scheduledTasks;
  const task=previous?.find(item=>item.id===taskId);
  if (!task) throw new Error('该定时任务已启动或取消。');
  if (at !== null) scheduledTasks.futureTime(at);
  const oldStatus=chat.workflow?.status, oldReason=chat.workflow?.reason;
  chat.scheduledTasks=at===null ? previous.filter(item=>item!==task) : previous.map(item=>item===task ? {...task,at,error:undefined} : item);
  if (at===null && task.kind==='standalone') Object.assign(chat.workflow,{status:'paused',reason:'定时启动已取消。'});
  try { store.save(); } catch (error) {
    chat.scheduledTasks=previous;
    if (chat.workflow) Object.assign(chat.workflow,{status:oldStatus,reason:oldReason});
    throw error;
  }
  emit();
});
function pumpScheduledTasks(now = Date.now()) {
  if (quitting || confirmingQuit) return;
  for (const {chat,task} of scheduledTasks.due(store.state.chats,now)) {
    if (interactiveAgents.active(chat.id)) continue;
    if (task.kind==='message' && (chat.inputQueue?.length||0)>=require('./input-queue.cjs').maxEntries) continue;
    if (task.kind==='workflow' && (groupWorkflows.activeRun(chat)||inputBusy(chat.id)||inputQueue.dispatching.has(chat.id)||
        chat.workflowRuns?.some(run=>run.definitionId===task.value.definition.id&&groupWorkflows.resumableStatuses.has(run.status)))) continue;
    const previous=chat.scheduledTasks;
    chat.scheduledTasks=previous.filter(item=>item!==task);
    try {
      // Each dispatch persists the removal and its durable queue or workflow entry in the same write.
      if (task.kind==='message') {
        prepareInput(task.value,true);
        inputQueue.submit(chat.id,task.value,'queue',{scheduled:true});
      } else if (task.kind==='workflow') {
        startGroupWorkflow(chat.id,task.value.definition.id,task.value.goal,task.value.definition);
      } else {
        chat.workflow.status='queued';
        try { store.save(); } catch (error) { chat.workflow.status='scheduled'; throw error; }
        emit();setImmediate(pumpWorkflows);
      }
    } catch (error) {
      chat.scheduledTasks=previous.map(item=>item===task ? {...item,error:String(error.message).slice(0,500)} : item);
      try { store.save(); } catch (saveError) { chat.scheduledTasks=previous; console.error('Could not persist scheduled task failure:',saveError); }
      emit();
    }
  }
}
handle('queue-resume',(id, confirmedTaskId)=>{
  const chat=store.get('chats',id);
  if(chat.localTask?.stopUnconfirmed){
    if(running.has(id)||confirmedTaskId!==chat.localTask.id)throw new Error('请确认上一个后台任务已经结束，再继续队列。');
    delete chat.localTask;
  }
  return inputQueue.resume(id);
});
handle('queue-pause',id=>inputQueue.pause(id));
handle('queue-remove',(id,entryId)=>inputQueue.remove(id,entryId));
handle('queue-move',(id,entryId,offset)=>inputQueue.move(id,entryId,offset));
handle('queue-now',(id,entryId)=>{
  const {chat}=prepareInput(inputQueue.entry(id,entryId).entry.value,true);
  if (groupWorkflows.activeRun(chat)) throw new Error('请在工作流面板停止当前运行，待发送消息会保留。');
  return inputQueue.now(id,entryId);
});
handle('queue-restore',(id,entryId)=>{
  const {chat,entry}=inputQueue.entry(id,entryId);
  if(chat.draft?.trim()||attachments.files(id).length)throw new Error('Clear the current draft before restoring a queued message.');
  chat.draft=entry.value.text;chat.draftAttachments=entry.value.files.map(file=>({...file,id:require('node:crypto').randomUUID()}));
  inputQueue.remove(id,entryId);return {text:chat.draft,attachments:chat.draftAttachments};
});
async function startSend(value,inputQueueId) {
  const {invocation,roleIds,files,requestedRounds,autoStop,slackTargets,slackText}=prepareInput(value,true);
  const chat = store.get('chats', value.chatId); const project = structuredClone(store.get('projects', chat.projectId));
  if (running.has(chat.id)) throw new Error('This chat is already running. Pause it before sending another task.');
  if(invocation?.skill.kind==='image'){
    if(skills.jobs.size>=2)throw new Error('已有两个技能在执行，请稍候再发送；输入内容已保留。');
    if(value.attachmentIds?.length)throw new Error('首版生图技能仅接收文字；附件已保留，请移除附件或改用聊天发送。');
    skills.validate(invocation.skill.id,invocation.prompt);
    const user=store.message(chat.id,{kind:'user',text:String(value.text),status:'accepted',inputQueueId});const scope=skills.scope(chat.id,null,user.id);emit();
    skills.run(scope,invocation.skill.id,invocation.prompt).then(()=>{notifications.complete(chat.id);inputQueue.settled(chat.id,'complete');},()=>{notifications.complete(chat.id);inputQueue.settled(chat.id,'failed');});store.save();emit();updateBadges();return {accepted:true,messageId:user.id};
  }
  if(interactiveAgents.active(chat.id)){
    if(roleIds.length!==1||value.summary)throw new Error('交互连接期间，请 @ 一位已连接角色发送。群聊接力请先结束交互连接。');
    const text=String(value.text||'');let wireText=require('./attachment-text.js').messageText({text,attachments:files});if(invocation?.skill.kind==='prompt')wireText+='\n\nExplicit skill instructions:\n'+skills.instructions(invocation.skill.id);
    const result=interactiveAgents.submit(chat.id,roleIds[0],{text,wireText,attachments:files,inputQueueId,settings:{...effectiveRole(chat,store.get('roles',roleIds[0])),...value.roleSettings?.[roleIds[0]]}});
    if(invocation?.skill.kind==='prompt')skills.run(skills.scope(chat.id,roleIds[0],result.messageId),invocation.skill.id,invocation.prompt||'Apply the skill to this project.').catch(()=>{});
    store.save();emit();return result;
  }
  if (running.size + interactiveAgents.list().filter(e=>e.state!=='ended').length >= store.state.settings.maxJobs) throw new Error('The concurrent discussion limit has been reached. End an interactive terminal, pause a running chat or adjust Settings.');
  const relay=chat.relayReplies!==false,group=!value.summary&&roleIds.length>1&&relay;
  const hasOtherRoles = slackTargets.length < roleIds.length;
  const rounds=group&&hasOtherRoles?requestedRounds:1;
  const configuredModerator=group&&hasOtherRoles&&chat.roleIds.includes(chat.moderatorRoleId)?store.get('roles',chat.moderatorRoleId):null;
  const moderatorId=workflowEngine.canModerate(configuredModerator)?configuredModerator.id:'';
  const executionRoleIds=[...new Set([...roleIds,...(moderatorId?[moderatorId]:[])])];
  for (const id of executionRoleIds) ensureCliReady(store.get('roles', id));
  if (moderatorId) {
    const moderator = store.get('roles', moderatorId);
    if (!project.directories.some(directory => directory.locationId === moderator.locationId)) {
      throw new Error(formatMissingProjectDirectories(project, [{...moderator, name:`${moderator.name}（主持人）`}], locationName));
    }
  }
  const userMessage = store.message(chat.id, { kind: 'user', text: String(value.text||''), attachments:files, status: 'accepted', summary: Boolean(value.summary), inputQueueId });
  if(!value.summary){chat.maxRounds=requestedRounds;chat.autoStop=autoStop;}chat.lastDiscussion=null;store.save();
  const controller = new AbortController();
  const roles = Object.fromEntries(executionRoleIds.map(id => [id, structuredClone({...effectiveRole(chat, store.get('roles', id)),...value.roleSettings?.[id]})]));
  const context = { relayReplies: relay,taskId:userMessage.id };skills.begin(userMessage.id);
  const selectedRole = roles[roleIds[0]];
  if ((!smoke || process.argv.includes('--local-executor-only')) && roleIds.length === 1 && !value.summary && !invocation &&
      canUseLocalExecutor(selectedRole, project)) {
    const task = {id:userMessage.id, roleId:selectedRole.id, createdAt:Date.now()};
    chat.localTask = task;
    const state = {...store.state, chats:store.state.chats.map(item => item.id === chat.id ? {...item, messages:item.messages.map(messageData)} : {
      id:item.id, projectId:item.projectId, name:item.name, roleIds:item.roleIds, disbandedAt:item.disbandedAt, updatedAt:item.updatedAt,
    })};
    store.save();
    followLocalTask(chat, task, {chatId:chat.id, role:selectedRole, project, state});
    return {accepted:true, messageId:userMessage.id};
  }
  const job = { controller, forceStopId:userMessage.id, roleIds:executionRoleIds, round: 1, rounds, roleId: roleIds[0],phase:'participant',taskId:userMessage.id }; running.set(chat.id, job); emit();updateBadges();
  const moderator=moderatorId?require('./moderator.cjs').coordinator({agents,store,chat,role:roles[moderatorId],project,signal:controller.signal,taskId:userMessage.id,onFallback:()=>{context.ignoreModeratorMemory=true;},onPhase:(phase,round,roleId)=>{job.phase=phase;job.round=round;job.roleId=roleId;emit();}}):null;
  (async () => {
    try {
      if(invocation?.skill.kind==='prompt'){const loaded=await skills.run(skills.scope(chat.id,null,userMessage.id),invocation.skill.id,invocation.prompt||'Apply the skill to this project.');context.skillInstructions=loaded.instructions;}
      const slackRoles = new Set(slackTargets.map(target => target.roleId));
      const failedSlackRoles = [];
      const outcome=await discussion.run({roleIds,rounds,autoStop:group&&autoStop,signal:controller.signal,
        singleTurnRoles:slackRoles,
        continueAfterFailure:roleId=>{
          if (!hasOtherRoles || !slackRoles.has(roleId)) return false;
          failedSlackRoles.push(roles[roleId].name);
          return true;
        },
        beforeRound:moderator?round=>moderator.beforeRound(round,rounds):undefined,
        reviewRound:moderator&&autoStop?round=>moderator.reviewRound(round,rounds):undefined,
        onTurn:(round,roleId)=>{job.round=round;job.roleId=roleId;job.phase=roles[roleId].engine===geminiWebEngine?'web-reply':'participant';emit();},
        runTurn:(roleId,control)=>{
          const role=roles[roleId],turnContext={...context,discussion:control};
          if(role.engine===geminiWebEngine)return geminiWeb.run(chat,role,controller.signal,turnContext,Boolean(value.summary));
          if(role.engine===slackChatEngine)return slackChat.run(chat,role,slackText,controller.signal);
          return agents.run(chat.id,role,structuredClone(project),controller.signal,Boolean(value.summary),turnContext);
        }});
      chat.lastDiscussion={...outcome,automatic:group&&autoStop,moderatorRoleId:moderatorId,userMessageId:userMessage.id,at:Date.now()};
      if (failedSlackRoles.length) {
        const note = 'Slack 角色「' + failedSlackRoles.join('、') + '」未完成回复。';
        chat.lastDiscussion.reason = [outcome.reason, note].filter(Boolean).join(' ');
      }
      if(!group&&outcome.state==='limit')chat.lastDiscussion.state=value.summary?'summary':'answered';
    } catch (error) { chat.lastDiscussion={state:'failed',rounds:Math.max(0,job.round-1),maxRounds:rounds,userMessageId:userMessage.id,at:Date.now()};store.message(chat.id, { kind: 'system', text: error.message, status: 'failed' }); }
    finally {
      running.delete(chat.id);store.save();notifications.complete(chat.id);
      const unconfirmed=controller.signal.aborted&&chat.messages.slice(chat.messages.indexOf(userMessage)+1).some(message=>message.stopConfirmed===false);
      if(unconfirmed){chat.lastDiscussion.stopConfirmed=false;store.save();}
      inputQueue.settled(chat.id,unconfirmed?'stop_unconfirmed':chat.lastDiscussion?.state);
    }
  })();
  return { accepted: true, messageId: userMessage.id };
}
function canUseLocalExecutor(role, project) {
  if (!['codex', 'claude'].includes(role.engine) || role.provider !== 'native' || store.get('locations', role.locationId).type !== 'local') return false;
  if (role.allowLocationTools === false) return true;
  // A worker without a window cannot ask the user to trust a new SSH host.
  return project.directories.every(({locationId}) => {
    const location = store.get('locations', locationId);
    return location.type !== 'ssh' || location.control !== 'ssh' || location.managed || Boolean(locations.known[`[${location.host}]:${location.port}`]);
  });
}
function followLocalTask(chat, task, request) {
  const controller = new AbortController();
  const job={controller,forceStopId:task.id,roleIds:[task.roleId],roleId:task.roleId,round:1,rounds:1,taskId:task.id,localExecutor:true};
  running.set(chat.id, job);
  const received = new Map();
  emit();
  void (async () => {
    let outcome = 'failed', stopConfirmed, finished = false, canRetryStop = false;
    try {
      if (request) await localExecutor.start(data, task, request, app);
      else {
        const stop = localExecutor.readRecord(localExecutor.taskDirectory(data, task.id), 'cancel.json');
        if(stop?.requested){job.forceStopping=Boolean(stop.force);controller.abort();emit();}
      }
      const progress = await localExecutor.follow(data, task, controller.signal, update => {
        if (update.binding) {
          chat.nativeSessions ||= {};
          chat.nativeSessions[task.roleId] = update.binding;
        }
        for (const message of update.messages) {
          if (isDeepStrictEqual(received.get(message.id), message)) continue;
          received.set(message.id, message);
          const existing = chat.messages.find(item => item.id === message.id);
          if (existing) Object.assign(existing, message, {localTaskId:task.id});
          else chat.messages.push({...message, localTaskId:task.id});
          chat.updatedAt = Math.max(chat.updatedAt || 0, message.at);
          publishMessage({ chatId: chat.id, message });
        }
        store.scheduleSave();
      }, {force:()=>job.forceStopping});
      finished = true;
      if (progress.failure) throw new Error(progress.failure);
      outcome = progress.result.status === 'complete' ? 'answered' : progress.result.status === 'cancelled' ? 'paused' : 'failed';
      stopConfirmed = progress.result.stopConfirmed;
      if (progress.result.forced) {
        for (const message of chat.messages) if (message.localTaskId === task.id && message.status === 'running') {
          message.status = 'cancelled'; message.stopConfirmed = true;
        }
      }
    } catch (error) {
      for (const message of chat.messages) if (message.localTaskId === task.id && message.status === 'running') message.status = 'interrupted';
      store.message(chat.id, {kind:'system', text:error.message, status:'failed'});
      canRetryStop = error.code === 'LOCAL_EXECUTOR_STOP_UNCONFIRMED';
      if (controller.signal.aborted || canRetryStop) stopConfirmed = false;
    } finally {
      chat.lastDiscussion = {state:outcome, rounds:outcome === 'answered' ? 1 : 0, maxRounds:1, userMessageId:task.id, at:Date.now(), stopConfirmed};
      if(canRetryStop)chat.localTask={...task,stopUnconfirmed:true};
      else delete chat.localTask;
      running.delete(chat.id);
      store.save();
      if (finished) localExecutor.clear(data, task.id);
      notifications.complete(chat.id);
      inputQueue.settled(chat.id, stopConfirmed === false ? 'stop_unconfirmed' : outcome);
    }
  })();
}
handle('pause', id => {inputQueue.pause(id);interruptChat(id);emit(); });
handle('force-stop', async (id, expected) => {
  const chat=store.get('chats',id),target=forceStopTarget(chat,interactiveAgents.list());
  if(!target||target.id!==expected)throw new Error('任务已更换或结束，请核对后重试。');
  if(target.stopping)return;
  inputQueue.pause(id);
  if(target.terminal){
    try{await interactiveAgents.forceStop(target.id);}catch(error){inputQueue.pause(id,'stop_unconfirmed');throw error;}
    return;
  }
  const job=running.get(id);
  if(target.unconfirmed||job.localExecutor){
    localExecutor.requestStop(data,target.id,true);
    if(target.unconfirmed){
      delete chat.localTask.stopUnconfirmed;
      store.save();
      followLocalTask(chat,chat.localTask);
      return;
    }
  }
  job.forceStopping=true;
  agents.forceStop(id);
  interruptChat(id);
  emit();
});
handle('settings', value => { const n = Number(value.maxJobs); if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error('Choose between 1 and 8 concurrent discussions.'); const theme = value.theme ?? store.state.settings.theme; if (!themes.isValid(theme)) throw new Error('Choose a supported appearance.'); store.state.settings.theme = theme; nativeTheme.themeSource = themes.themeSource(theme); const background = themeBackground(theme); for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(background); store.state.settings.keepAwake = value.keepAwake === true; store.state.settings.maxJobs = n; store.save(); keepAwake.setEnabled(store.state.settings.keepAwake); emit(); });
handle('pick', async (kind, initialPath) => {
  const options = { properties: [kind === 'folder' ? 'openDirectory' : 'openFile', ...(kind === 'files' ? ['multiSelections'] : [])] };
  const validPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value);
  if (kind === 'folder' && validPath(initialPath)) options.defaultPath = initialPath;
  const result = await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  return result.filePaths;
});
async function writeClipboardText(text) { if (typeof clipboard.writeText === 'function') clipboard.writeText(String(text)); else await clipboard.write([{ 'text/plain': String(text) }]); }
handle('copy', writeClipboardText);
async function readClipboardText() { if (typeof clipboard.readText === 'function') return clipboard.readText(); const items = await clipboard.read(); for (const item of items) if (item.types.includes('text/plain')) return (await item.getType('text/plain')).text(); return ''; }
handle('clipboard-text', readClipboardText);
handle('image', async id => {store.get('chats',id);const image=await imageSource.read();if(attachments.files(id).length>=8)throw new Error('Attach at most 8 files per message.');const file=images.stage(image,attachments.protectedPaths());try{const files=attachments.add(id,[file.path],file);emit();return files;}catch(error){images.remove(file);throw error;}});
handle('message-images',(chatId,messageId)=>messageImages.list(chatId,messageId));
handle('message-image-original', (chatId, messageId, sourcePath) => messageImages.original(chatId, messageId, sourcePath));
handle('open', async (filename, projectId, { chatId, messageId, inspect, reveal } = {}) => {
  if (/^https?:\/\//i.test(filename)) {
    const link = pathLinks.target(filename);
    if (link?.kind !== 'web') throw new Error('无法打开此网页地址。');
    return shell.openExternal(link.value);
  }
  const project = store.get('projects', projectId);
  const chat = chatId && chatById(chatId);
  const message = chat?.projectId === projectId && chat.messages.find(item => item.id === messageId);
  const roots = project.directories.filter(directory => directory.locationId === 'local').map(directory => directory.path);
  let result;
  try {
    result = await findProjectPaths(filename, roots, {
      getHints: message ? () => messagePaths(message, readMessageDetail(message, 'activities')) : undefined,
    });
  } catch {
    throw new Error('路径格式无效。请检查盘符、文件名或项目相对路径。');
  }
  if (!inspect && result.candidates.length === 1 && !result.incomplete) {
    const file = result.candidates[0];
    if (reveal && !file.directory) shell.showItemInFolder(file.path);
    else if (await shell.openPath(file.path)) throw new Error('系统无法打开此文件或文件夹，请检查文件关联和访问权限。');
    return;
  }
  if (!result.candidates.length) {
    const remote = project.directories.map((directory, index) => ({ directory, index }))
      .filter(({directory}) => directory.locationId !== 'local');
    const value = pathLinks.normalize(filename);
    const matching = remote.filter(({directory}) => value.startsWith(directory.path.replace(/\/+$/, '') + '/'))
      .sort((a, b) => b.directory.path.length - a.directory.path.length)[0];
    const sameLocation = remote.find(({directory}) => directory.locationId === message?.locationId);
    result.remoteDirectory = (matching || sameLocation || remote[0])?.index;
    result.hasLocalDirectories = roots.length > 0;
  }
  return result;
});
async function tools(projectId, directoryIndex) {
  const project = store.get('projects', projectId); const directory = project.directories[directoryIndex]; if (!directory) throw new Error('Choose a project directory.');
  const location = store.get('locations', directory.locationId); let facade = { log: () => {} };
  let projectPath = directory.path;
  if (location.type !== 'local') {
    if (location.os !== 'linux') throw new Error('Remote file and terminal tools currently require Linux.');
    const client = await locations.connect(location.id); const home = (await locations.exec(location.id, 'printf %s "$HOME"')).trim();
    projectPath = await locations.ensureProjectDirectory(location.id, directory.path, home);
    facade = { client, status: { ssh: 'ready' }, remoteDir: home + '/windows-mcp', exec: command => locations.exec(location.id, command), log: () => {} };
  }
  let manager = terminalManagers.get(location.id);
  if (!manager) { manager = new ProjectTerminals(facade, value => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('desk:terminal', value); }); terminalManagers.set(location.id, manager); }
  else manager.backend = facade;
  const loc = { kind: location.type === 'local' ? 'local' : 'remote', path: projectPath };
  return { manager, facade, project: { ...project, locations: [loc] }, loc };
}
handle('files', async (projectId, directory, parts, operation) => {
  if (!['list', 'read', 'open'].includes(operation)) throw new Error('请选择有效的文件操作。');
  const t = await tools(projectId, directory);
  return projectFiles(t.facade, t.project, t.loc, parts, operation);
});
handle('file-explorer', async (projectId, directoryIndex, parts) => {
  const project = store.get('projects', projectId);
  const directory = project.directories[directoryIndex];
  if (directory?.locationId !== 'local') throw new Error('资源管理器只能打开本机项目目录。');
  const location = {kind:'local', path:directory.path};
  let target, isDirectory;
  try {
    ({path:target} = await projectFiles(null, {locations:[location]}, location, parts, 'open'));
    isDirectory = (await fs.promises.stat(target)).isDirectory();
  } catch {
    throw new Error('无法访问此文件或文件夹，请刷新列表后重试。');
  }
  if (isDirectory) {
    const error = await shell.openPath(target);
    if (error) throw new Error('无法在资源管理器中打开此文件夹。');
  } else {
    shell.showItemInFolder(target);
  }
});
handle('terminals', () => [...terminalManagers.values()].flatMap(m => m.list()));
handle('terminal-open', async (projectId, directory) => {
  const t = await tools(projectId, directory);
  if (quitting) throw new Error('ai-team is closing.');
  return t.manager.open(t.project, t.loc);
});
handle('terminal-input', (id, data) => { for (const m of terminalManagers.values()) m.input(id, data); });
handle('terminal-resize', (id, cols, rows) => { for (const m of terminalManagers.values()) m.resize(id, cols, rows); });
handle('terminal-close', id => { for (const m of terminalManagers.values()) m.close(id); });
handle('agent-terminals',()=>interactiveAgents.list());
handle('agent-terminal-open',(chatId,roleId)=>{activeChat(chatId);ensureCliReady(store.get('roles',roleId));return interactiveAgents.open(chatId,roleId);});
handle('agent-terminal-input',(id,value)=>interactiveAgents.input(id,value));
handle('agent-terminal-screen',(id,text)=>interactiveAgents.screen(id,text));
handle('agent-terminal-resize',(id,cols,rows)=>interactiveAgents.resize(id,cols,rows));
handle('agent-terminal-close',id=>interactiveAgents.close(id));

async function remoteAntigravityLoginWindow(location, executable, proxy) {
  let stream;
  try {
    const client = await locations.connect(location.id);
    stream = await remoteAntigravity.openLogin(client, executable, proxy, AbortSignal.timeout(20000));
  } catch (error) {
    throw new Error('无法启动 VPS 的 Google 登录。请检查 SSH 连接后重试。\n' + error.message, { cause: error });
  }
  return new Promise((resolve, reject) => {
    let ready = false, output = '', url = '', settled = false, exitCode, status = '';
    const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
    const window = new BrowserWindow({ width: 900, height: 600, parent: workbenchWindow, modal: Boolean(workbenchWindow),
      title: location.name + ' · Antigravity 登录', webPreferences: {
        preload: path.join(__dirname, 'login-preload.cjs'), contextIsolation: true, sandbox: true,
      } });
    function input(event, value) {
      if (event.sender === window.webContents && typeof value === 'string' && value.length <= 8192 && !settled) {
        try { stream.write(value); } catch { finish(new Error('无法向 VPS 发送授权码。请重新打开登录窗口。')); }
      }
    }
    function authorize(event) {
      if (event.sender === window.webContents && url && !settled) {
        shell.openExternal(url).catch(() => {
          if (!window.isDestroyed()) window.webContents.send('login:status', '打开浏览器失败。请复制终端里的授权网址，在本机浏览器打开。');
        });
      }
    }
    function finish(error, success = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener('login:input', input);
      ipcMain.removeListener('login:authorize', authorize);
      if (error) {
        status = error.message;
        if (!window.isDestroyed() && ready) window.webContents.send('login:status', status);
        try { stream.close(); } catch {}
        reject(error);
      } else {
        if (success && !window.isDestroyed()) window.close();
        resolve(success);
      }
    }
    const timer = setTimeout(() => finish(new Error('VPS 登录已超时。请重新点击「配置并登录 VPS」。')), 600000);
    ipcMain.on('login:input', input);
    ipcMain.on('login:authorize', authorize);
    stream.on('data', chunk => {
      if (window.isDestroyed()) return;
      const value = decoder.write(chunk);
      output = (output + value).slice(-16000);
      const found = remoteAntigravity.authorizationUrl(output);
      if (ready) window.webContents.send('login:data', value);
      if (found && found !== url) {
        url = found;
        if (ready) window.webContents.send('login:authorize-ready');
      }
    });
    stream.on('error', () => finish(new Error('VPS 登录连接断开。请检查 SSH 后重试。')));
    stream.on('exit', code => { exitCode = code; });
    stream.on('close', code => {
      if ((code ?? exitCode) === 0) finish(null, true);
      else {
        const message = remoteAntigravity.keyringError(output)
          ? 'VPS 的系统密钥环无法打开。请检查该 SSH 用户的 D-Bus 和密钥环服务后重试。'
          : 'VPS 上的 Google 登录未完成。请检查登录窗口中的官方 CLI 输出后重试。';
        finish(new Error(message));
      }
    });
    window.webContents.once('did-finish-load', () => {
      ready = true;
      window.webContents.send('login:remote', Boolean(url));
      window.webContents.send('login:data', output);
      if (status) window.webContents.send('login:status', status);
    });
    window.on('closed', () => {
      finish();
      try { stream.close(); } catch {}
    });
    window.loadFile(path.join(__dirname, 'login.html')).catch(() => {
      finish(new Error('无法打开 VPS 登录窗口。'));
      if (!window.isDestroyed()) window.close();
    });
  });
}

async function configureRemoteAntigravity(role, location) {
  const sessions = require('./native-sessions.cjs');
  const scope = sessions.loginScope(role, location);
  if (antigravitySetups.has(scope)) throw new Error('该 VPS 用户正在配置 Antigravity，请先完成或关闭登录窗口。');
  antigravitySetups.add(scope);
  try {
    const proxy = network.policy(role);
    const configured = await remoteAntigravity.configure(locations, location, role, proxy, async executable => {
      if (quitting) return false;
      if (store.state.roles.some(peer => sessions.loginScope(peer, store.get('locations', peer.locationId)) === scope && busyRole(peer.id))) {
        throw new Error('请先结束使用该 VPS Antigravity 账号的任务，再登录。');
      }
      if (!await remoteAntigravityLoginWindow(location, executable, proxy)) return false;
      sessions.invalidateLogin(store, role, location);
      return true;
    });
    return { vpsConfigured: configured };
  } finally {
    antigravitySetups.delete(scope);
  }
}

handle('role-login', async id => {
  const role = store.get('roles', id); if (role.provider !== 'native') throw new Error('API roles use the saved API key.');
  ensureCliReady(role);
  if (role.engine === slackChatEngine) {
    const signal = AbortSignal.timeout(10000);
    try { await slackChat.connect(role, signal); }
    catch (error) {
      if (signal.aborted) throw new Error('检查 Slack 私信超时，请确认网络后重试。');
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('无法连接 Slack，请检查网络代理。');
      throw error;
    }
    return { slackConnected: true };
  }
  if (role.engine === 'custom-acp') throw new Error('请在 ACP Agent 自身的界面完成账号登录。');
  accountUsage.invalidate(id);
  const location = store.get('locations', role.locationId);
  if (vendors.supportsRemote(role.engine, location)) return configureRemoteAntigravity(role, location);
  if(!usesDesktopLogin(role)){const sessions=require('./native-sessions.cjs'),scope=sessions.loginScope(role,location,agents.desktopHome());if(store.state.roles.some(peer=>sessions.loginScope(peer,store.get('locations',peer.locationId),agents.desktopHome())===scope&&busyRole(peer.id)))throw new Error('Pause tasks and close interactive terminals sharing this account before changing its login.');sessions.invalidateLogin(store,role,location,agents.desktopHome());}
  if (location.type !== 'local') {
    const project = store.state.projects.find(p => p.directories.some(d => d.locationId === location.id));
    if (!project) throw new Error('Configure a project directory on this location before logging in.');
    const t = await tools(project.id, project.directories.findIndex(d => d.locationId === location.id));
    const terminalId = await t.manager.open(t.project, t.loc);
    const q = require('../config.cjs').shellQuote;
    let command;
    if (location.managed) command = 'bash ' + q(t.facade.remoteDir + '/start-' + role.engine + '-container.sh') + ' --login';
    else {
      const profile = '$HOME/.local/share/relay-desk/profiles/' + role.id;
      const auth = role.engine === 'codex' ? ' login --device-auth' : ' auth login';
      command = `export CODEX_HOME="${profile}/codex" CLAUDE_CONFIG_DIR="${profile}/claude" XDG_CONFIG_HOME="${profile}/config" XDG_DATA_HOME="${profile}/data"; mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"; ` + q(role.executable || role.engine) + auth;
    }
    const proxy = network.policy(role);
    if (proxy.mode !== 'system') {
      const env = proxyEnvironment({}, proxy);
      command = '( unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy; ' + Object.entries(env).map(([key,value]) => 'export ' + key + '=' + q(value)).join('; ') + '; ' + command + ' )';
    }
    t.manager.input(terminalId, command + '\r'); return { projectId: project.id, terminalId };
  }
  if (localLogins.has(id)) throw new Error('此角色的登录窗口已打开。');
  localLogins.add(id);
  let loginWindow;
  try { return await openLocalRoleLogin(role, window => { loginWindow = window; }); }
  finally {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.once('closed', () => localLogins.delete(id));
    else localLogins.delete(id);
  }
});
async function openLocalRoleLogin(role, opened) {
  const executable = findExecutable(role); const env = await network.environmentFor(role, agents.environment(role));
  if(role.engine==='workbuddy'){
    const file=path.resolve(path.dirname(executable),'../../../..','WorkBuddyAI.exe');
    if(!fs.existsSync(file))throw new Error('Open the official WorkBuddy application to complete account login.');
    const error=await shell.openPath(file);if(error)throw new Error(error);return {desktopOpened:true};
  }
  if (usesDesktopLogin(role)) {
    await requireCodexLogin(executable, env, { authArgs:[], desktop:true });
    return { loginSource:'desktop', loggedIn:true };
  }
  const { spawn: ptySpawn } = require('node-pty');
  // Independent login is interactive and uses a role-specific credential directory.
  const args = vendors.isVendor(role.engine)?vendors.loginArgs(role.engine):role.engine === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'] : ['auth', 'login'];
  const launch=vendors.isVendor(role.engine)?vendors.launch(executable,args,env):{command:executable,args,env};
  const pty = ptySpawn(launch.command, launch.args, { cwd: root, env:launch.env, cols: 100, rows: 28, useConptyDll: true });
  const window = new BrowserWindow({ width: 900, height: 600, title: role.name + ' · 登录', webPreferences: { preload: path.join(__dirname, 'login-preload.cjs'), contextIsolation: true, sandbox: true } });
  opened(window);
  window.loadFile(path.join(__dirname, 'login.html')); let output = '';
  pty.onData(value => { output = (output + value).slice(-160000); if (!window.isDestroyed()) window.webContents.send('login:data', value); });
  window.webContents.once('did-finish-load', () => window.webContents.send('login:data', output));
  const input = (event, value) => { if (event.sender === window.webContents && typeof value === 'string') pty.write(value); };
  ipcMain.on('login:input', input); window.on('closed', () => { ipcMain.removeListener('login:input', input); try { pty.kill(); } catch {} });
}
function createWindow() {
  const w = new BrowserWindow({ width: 1488, height: 1000, minWidth: 1000, minHeight: 650, show: !smoke && (!updateBoot.job || updateAccepted), backgroundColor: themeBackground(), title: 'AI 小队', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !smoke } });
  workbenchWindow = w;
  w.on('close', event => {
    if (quitReady) return;
    event.preventDefault();
    app.quit();
  });
  w.on('closed', () => { if(workbenchWindow===w)workbenchWindow=undefined; });
  w.on('show', restoreBadges);
  w.on('restore', restoreBadges);
  w.on('focus', () => { w.flashFrame(false); restoreBadges(); });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); w.webContents.on('will-navigate', e => e.preventDefault());
  w.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  w.webContents.session.setPermissionCheckHandler(() => false);
  w.loadFile(path.join(__dirname, 'index.html'));
  w.webContents.once('did-finish-load',restoreBadges);
  return w;
}
function showQuitDialog(options) {
  return workbenchWindow ? dialog.showMessageBox(workbenchWindow, options) : dialog.showMessageBox(options);
}

function restartResources() {
  const tasks = [], terminals = [];
  const roleName = id => store.state.roles.find(role => role.id === id)?.name;
  const projectName = id => store.state.projects.find(project => project.id === id)?.name;
  const label = (...parts) => parts.filter(Boolean).join(' · ');
  for (const [id, job] of running) {
    if (job.localExecutor) continue;
    if (job.phase === 'workflow-plan') {
      const project = store.state.projects.find(item => planJobKey(item.id) === id);
      tasks.push(label('正在生成工作流', project?.name, roleName(job.roleId)));
    } else {
      tasks.push(label(job.controller.signal.aborted ? '正在停止任务' : '对话任务', chatById(id)?.name, roleName(job.roleId)));
    }
  }
  for (const job of skills.jobs.values()) tasks.push(label('技能任务', chatById(job.chatId)?.name));
  for (const id of inputQueue.dispatching) tasks.push(label('正在提交消息', chatById(id)?.name));
  for (const terminal of interactiveAgents.list()) {
    if (terminal.state === 'ended') continue;
    const idle = terminal.state === 'ready' && terminal.inputReady && !terminal.forceStopping &&
      !['running', 'waiting'].includes(terminal.taskState);
    const status = terminal.state === 'opening' ? '正在连接' : terminal.forceStopping ? '正在停止'
      : terminal.taskState === 'running' ? '正在运行' : terminal.taskState === 'waiting' ? '等待确认' : '状态未确认';
    (idle ? terminals : tasks).push(label(idle ? '空闲角色终端' : '角色终端：' + status,
      chatById(terminal.chatId)?.name, roleName(terminal.roleId)));
  }
  for (const manager of terminalManagers.values()) {
    for (const terminal of manager.list()) {
      if (terminal.state !== 'ended') terminals.push(label('项目终端', projectName(terminal.projectId),
        (terminal.kind === 'local' ? 'Windows ' : 'Linux ') + terminal.number));
    }
  }
  return { tasks, terminals };
}

function describeQuitResources(items) {
  const shown = items.slice(0, 6).map(item => '• ' + item);
  if (items.length > shown.length) shown.push('另有 ' + (items.length - shown.length) + ' 项');
  return shown.join('\n');
}

async function confirmRestart() {
  let { tasks, terminals } = restartResources();
  if (!tasks.length && terminals.length) {
    const result = await showQuitDialog({
      type: 'warning', title: '重启工作台', message: '重启前需要关闭以下终端。',
      detail: describeQuitResources(terminals) + '\n\n关闭终端可能中断其中的命令。后台执行器管理的本机任务会继续运行。',
      buttons: ['取消', '关闭终端并重启'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return false;
    tasks = restartResources().tasks;
  }
  if (!tasks.length) return true;
  await showQuitDialog({
    type: 'info', title: '重启工作台', message: '以下任务或角色终端暂时阻止重启。',
    detail: describeQuitResources(tasks) + '\n\n请等待任务结束，或在对应对话的「对话任务输出」中检查角色终端。后台执行器管理的本机任务会继续运行。',
    buttons: ['确定'], noLink: true,
  });
  return false;
}

async function requestQuit(restart = false, applyUpdate = false) {
  if (quitting || confirmingQuit) return;
  confirmingQuit = true;
  try {
    if (applyUpdate && (running.size || skills.jobs.size || inputQueue.dispatching.size || interactiveAgents.active() ||
      localLogins.size || antigravitySetups.size || cliUpdates.installing() ||
      store.state.chats.some(chat => chat.localTask) ||
      [...terminalManagers.values()].some(manager => manager.list().some(terminal => terminal.state !== 'ended')))) {
      await showQuitDialog({ type:'info', title:'安装应用更新', message:'请等待任务和 CLI 更新结束，并关闭已连接的终端后重试。', buttons:['确定'], noLink:true });
      return;
    }
    if (cliUpdates.installing()) {
      await showQuitDialog({ type:'info', title:'CLI 正在更新', message:'请等待本机 CLI 更新完成后再退出或重启。', buttons:['确定'], noLink:true });
      return;
    }
    if (restart) {
      if (!await confirmRestart()) return;
    } else if (running.size || skills.jobs.size || inputQueue.dispatching.size || interactiveAgents.active() ||
      [...terminalManagers.values()].some(manager => manager.list().some(terminal => terminal.state !== 'ended'))) {
      const result = await showQuitDialog({
        type: 'warning', title: '退出 AI 小队', message: '有任务正在运行，或有终端仍处于连接状态。',
        detail: '退出时会尝试停止任务并断开终端。聊天记录和待发送消息会保留。',
        buttons: ['取消', '结束任务并退出'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) return;
    }
  } catch (error) {
    console.error('Could not confirm workbench shutdown:', error);
    return;
  } finally {
    confirmingQuit = false;
  }

  quitting = true;
  if (applyUpdate) {
    try { await appReleaseUpdate.handOff(); }
    catch (error) { quitting = false; throw error; }
  }
  try {
    for (const chat of store.state.chats) for (const flow of [chat.workflow,...(chat.workflowRuns||[])]) {
      if (flow?.status === 'queued') flow.status = 'paused';
    }
    try { inputQueue.close(); } catch (error) { console.error('Could not save the paused queue:', error); }
    for (const job of running.values()) if (!restart || !job.localExecutor) job.controller.abort();
    skills.close();
    agents.close();
    const terminalsClosed = interactiveAgents.closeAll();
    for (const manager of terminalManagers.values()) manager.closeAll();
    emit();

    const draftSaved = workbenchWindow?.webContents.executeJavaScript('typeof saveDraftNow === "function" && saveDraftNow()');
    let windowCleanupDone = false;
    Promise.allSettled([terminalsClosed, draftSaved]).then(() => { windowCleanupDone = true; });
    // Keep SSH connected long enough for the remote runner's stop acknowledgement.
    const deadline = performance.now() + 8000;
    while ((!windowCleanupDone || [...running.values()].some(job => !restart || !job.localExecutor) || skills.jobs.size || inputQueue.dispatching.size) && performance.now() < deadline) {
      await delay(50);
    }
  } catch (error) {
    console.error('Could not finish stopping workbench tasks:', error);
  } finally {
    for (const chat of store.state.chats) for (const flow of [chat.workflow,...(chat.workflowRuns||[])]) {
      if (flow?.status !== 'running') continue;
      flow.status = 'needs_check';
      flow.reason = '应用退出时未确认节点结果，请检查工作区后重试。';
      const pending = flow.attempts.find(attempt => attempt.id === flow.pending);
      if (pending) Object.assign(pending, {status:'interrupted', reason:flow.reason});
      if (flow.id && flow.pending) flow.stopUnconfirmed = true;
      flow.pending = null;
    }
    const cleanup = [() => store.close(), () => quotaConsole.close(), () => accountUsage.close(),
      () => cliUpdates.close(), () => claudeUpdater.close(), () => locations.close(), () => backend.stop(), () => keepAwake.dispose()];
    for (const close of cleanup) {
      try { close(); } catch (error) { console.error('Workbench exit cleanup failed:', error); }
    }
    try { await appReleaseUpdate.close(); }
    catch (error) { console.error('Could not clean up the staged app update:', error); }
    quitReady = true;
    if (restart) {
      try { app.relaunch(); } catch (error) { console.error('Could not restart the workbench:', error); }
    }
    app.quit();
  }
  return true;
}
  handle('workbench-restart', () => requestQuit(true));
  handle('workbench-quit', () => requestQuit());
  handle('workbench-support', async () => {
    const { supportUrl } = require('../package.json');
    if (!supportUrl) throw new Error('项目的 GitHub 仓库地址尚未配置。');
    try { await shell.openExternal(supportUrl); }
    catch { throw new Error('无法在浏览器中打开 GitHub 仓库。'); }
  });
  app.on('second-instance', () => { if (quitting || updateBoot.job && !updateAccepted) return; const w = workbenchWindow || createWindow(); w.show(); w.focus(); });
  app.whenReady().then(async () => {
    const w = createWindow();
    if (updateBoot.job) {
      const deadline = Date.now() + 55000;
      // The worker can clean up the accepted marker after publishing its result.
      while (Date.now() < deadline && !updateBoot.accepted()) await delay(100);
      if (!updateBoot.accepted()) { app.exit(1); return; }
      updateAccepted = true;
      w.show();
    }
    keepAwake.start(); Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '文件', submenu: [{ id:'restart-workbench', label:'重启工作台', click:() => requestQuit(true).catch(error => console.error(error)) }, { role: 'quit', label: '退出' }] }, { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] }, { label: '视图', submenu: [{ label: '重新加载', role: 'reload' }, { label: '开发者工具', role: 'toggleDevTools' }, { label: '重置缩放', role: 'resetZoom' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }] }]));
    for(const chat of store.state.chats) {
      if(chat.workflow)engineForWorkflow(chat.workflow).recover(chat);
      for(const flow of chat.workflowRuns||[]) {
        const pending = flow.pending && chat.messages.find(message=>message.kind==='assistant'&&message.workflowAttemptId===flow.pending);
        engineForWorkflow(flow).recover({...chat,workflow:flow});
        if (pending?.workflowSubmitted && pending.status==='interrupted') {
          flow.stopUnconfirmed=true;
          flow.status='needs_check';
        }
        groupWorkflows.publish(store,chat,flow);
      }
    }
    for (const chat of store.state.chats) if (chat.localTask&&!chat.localTask.stopUnconfirmed) followLocalTask(chat, chat.localTask);
    store.save();
    const workflowTimer=setInterval(pumpWorkflows,3000);workflowTimer.unref();
    const scheduleTimer=setInterval(()=>pumpScheduledTasks(),1000);scheduleTimer.unref();
    setImmediate(pumpScheduledTasks);
    setImmediate(pumpWorkflows);
    if (!smoke) {
      const timer = setTimeout(() => { if (!quitting) void cliUpdates.startup(); }, 3500);
      timer.unref();
    }
    if (skills.system.sources().some(source=>source.enabled&&source.locationId!=='local')) skills.system.refresh().then(emit);
    if (smoke) require('./smoke.cjs').run(w, store, app, data, { agents, running, inputQueue, notifications, backend, claudeUpdater, cliUpdates, avatars, dialog, modelCatalogs, providerFetch, network, accountUsage,imageSource,quotaConsole,interactiveAgents,skills,shell,clipboard,pumpScheduledTasks }).catch(error => { console.error(error); app.exit(1); });
  }).catch(error => {
    console.error('The workbench could not finish starting:', error);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    void requestQuit();
  });
}
}
