const executorArg = process.argv.indexOf('--local-task-executor');
if (executorArg !== -1) { require('./local-executor-entry.cjs').launch(process.argv[executorArg + 1]); }
else if (process.argv.includes('--legacy')) { require('../main.cjs'); } else {
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage, safeStorage, nativeTheme, net, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const localExecutor = require('./local-executor.cjs');
const { pathToFileURL } = require('node:url');
const { Store } = require('./store.cjs');
const { Vault, Locations } = require('./locations.cjs');
const { Agents, findExecutable } = require('./agents.cjs');
const { ClaudeUpdater } = require('./claude-update.cjs');
const { Avatars } = require('./avatars.cjs');
const { ModelCatalogs } = require('./model-catalogs.cjs');
const { Usage } = require('./usage.cjs');
const { ProxyRouter, environment: proxyEnvironment } = require('./proxy.cjs');
const { effectiveRole } = require('./conversations.cjs');
const { formatMissingProjectDirectories } = require('./project-directories.cjs');
const { usesDesktopLogin } = require('./desktop-login.cjs');
const { requireCodexLogin } = require('./native-auth.cjs');
const vendors = require('./vendor-agents.cjs');
const discussion = require('./discussion.cjs');
const { Backend } = require('../backend.cjs');
const { KeepAwake } = require('../keep-awake.cjs');
const { ProjectTerminals, projectFiles } = require('../project-tools.cjs');
const { ClipboardImages, readClipboardImage } = require('../clipboard-images.cjs');
const { Attachments }=require('./attachments.cjs');
const {GeminiWeb, engine:geminiWebEngine, home:geminiWebHome}=require('./gemini-web.cjs');
const root = path.resolve(__dirname, '../..');
const smoke = process.argv.includes('--workbench-smoke');
const smokeRun=smoke&&/^[0-9]{1,12}$/.test(process.env.RELAY_SMOKE_RUN||'')?'-'+process.env.RELAY_SMOKE_RUN:'';
const data = smoke ? path.join(root, '.runtime/workbench-smoke'+smokeRun) : path.join(root, '.runtime/workbench');
require('../windows-launch.cjs').configureWindowsLaunch(app,{root,disabled:smoke});app.setPath('userData', path.join(data, 'browser'));
if (!smoke && !app.requestSingleInstanceLock()) app.quit(); else {
const store = new Store(data, root); const vault = new Vault(data, safeStorage); const backend = new Backend(root, { shareControlMode:true });
const locationName = id => store.state.locations.find(location => location.id === id)?.name || id;
try { backend.forceControl=JSON.parse(fs.readFileSync(path.join(root,'.runtime/desktop/state.json'),'utf8')).forceControl===true; } catch {}
const avatars = new Avatars(path.join(data, 'avatars'), nativeImage);
nativeTheme.themeSource = store.state.settings.theme;
nativeTheme.on('updated', () => {
  for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#191d23' : '#ffffff');
});
const running = new Map(); const terminalManagers = new Map();
let confirmingQuit = false, quitting = false, quitReady = false, workbenchWindow;
// Chromium's network stack follows the user's system proxy; Node fetch does not.
const providerFetch = (input, options) => net.fetch(input, options);
const network = new ProxyRouter(store, { app, session });
const emit = () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('desk:state', snapshot()); };
const locations = new Locations(store, vault, backend, async (location, fingerprint) => {
  const result = await dialog.showMessageBox({ type: 'question', buttons: ['取消', '信任并连接'], defaultId: 0, cancelId: 0, title: '验证 SSH 主机', message: `${location.username}@${location.host}:${location.port}`, detail: `首次连接此主机，请核对服务器指纹：\n\n${fingerprint}\n\n仅在确认指纹正确后信任。` }); return result.response === 1;
}, emit);
const agents = new Agents(store, vault, locations, event => { if (!event) { emit(); return; } for (const w of BrowserWindow.getAllWindows()) w.webContents.send('desk:message', event); }, { fetch: providerFetch, network });
const geminiWeb = new GeminiWeb({store, emit:agents.emit, open:url=>shell.openExternal(url), copy:writeClipboardText,readClipboard:readClipboardText});
const attachments=new Attachments(store);
const images = new ClipboardImages(path.join(data, 'images')); images.prepare(attachments.protectedPaths());
const imageSource={read:()=>readClipboardImage(clipboard,nativeImage)};
const messageImages=new (require('./message-images.cjs').MessageImages)({store,nativeImage});
const keepAwake = new KeepAwake(root, { enabled: store.state.settings.keepAwake, disabled: smoke, changed: emit, log: () => {} });
const claudeUpdater = new ClaudeUpdater(root, store, backend, locations, emit);
const modelCatalogs = new ModelCatalogs({ directory: data, store, vault, locations, backend, agents, fetch: providerFetch, network });
const accountUsage = new Usage({store,vault,agents,locations,backend,network,emit});
const quotaConsole=new (require('./quota-console.cjs').QuotaConsole)({store,agents,network,spawn:(...args)=>require('node-pty').spawn(...args)});
const interactiveStates=new Map();
const interactiveAgents=new (require('./interactive-agent.cjs').InteractiveAgents)({store,vault,agents,locations,network,busy:id=>running.has(id)||inputQueue.dispatching.has(id),count:()=>running.size,spawn:(...args)=>require('node-pty').spawn(...args),message:event=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('desk:message',event);},completed:chatId=>notifications.complete(chatId),emit:event=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('desk:agent-terminal',event);if(event.type==='state'){const info=event.info,previous=interactiveStates.get(info.id);interactiveStates.set(info.id,info.taskState);if(['running','waiting'].includes(previous)&&['completed','interrupted','failed'].includes(info.taskState))inputQueue.settled(info.chatId,info.taskState==='completed'?'complete':info.taskState==='interrupted'?'paused':'failed');if(info.state==='ended')inputQueue.pause(info.chatId,'terminal_ended');inputQueue.kick(info.chatId);emit();updateBadges();}}});
const skills=new (require('./skills.cjs').Skills)({store,vault,network,nativeImage,locations,fetch:providerFetch,emit:event=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('desk:message',event);}});agents.skills=skills;
function inputBusy(id){return running.has(id)||[...skills.jobs.values()].some(job=>job.chatId===id)||interactiveAgents.list().some(entry=>entry.chatId===id&&entry.state!=='ended'&&!(entry.state==='ready'&&entry.inputReady&&!['running','waiting'].includes(entry.taskState)));}
const inputQueue=new (require('./input-queue.cjs').InputQueue)({store,busy:inputBusy,start:startSend,changed:emit,
  accept:(chat,value)=>{if(!value.summary){if(chat.draft===value.text)chat.draft='';attachments.consume(chat.id,value.files);}},
  interrupt:id=>{const job=running.get(id);if(job){job.controller.abort();if(job.taskId)skills.closeTask(job.taskId);return;}const terminal=interactiveAgents.list().find(entry=>entry.chatId===id&&entry.state==='ready'&&entry.taskState==='running');if(terminal){interactiveAgents.input(terminal.id,'\x03');return;}throw new Error('This agent is not ready to interrupt. The queued message is preserved.');}});
const notifications=new (require('./notifications.cjs').CompletionNotifications)({store,
  busy:id=>running.has(id)||[...skills.jobs.values()].some(job=>job.chatId===id)||interactiveAgents.list().some(entry=>entry.chatId===id&&entry.state!=='ended'&&['running','waiting'].includes(entry.taskState)),
  changed:emit,render:renderBadges,
  attention:()=>{if(!smoke){shell.beep();if(workbenchWindow&&!workbenchWindow.isFocused())workbenchWindow.flashFrame(true);}}
});
backend.on('status', emit);
function snapshot() {
  const value = store.snapshot();
  value.roles = value.roles.map(r => ({ ...r, avatarId: r.avatarId || avatars.defaultId(r.engine), avatarUrl: avatars.get(r.avatarId || avatars.defaultId(r.engine)), hasKey: vault.has('api:' + r.id), available: r.engine === geminiWebEngine || r.locationId !== 'local' || (() => { try { findExecutable(r); return true; } catch { return false; } })() }));
  value.connectionStatus = locations.status(); value.running = Object.fromEntries([...running].map(([id, job]) => [id, { roleId: job.roleId, round: job.round, rounds: job.rounds, phase:job.phase||'participant', stopping: job.controller.signal.aborted }]));
  value.inputBusy=Object.fromEntries(value.chats.map(chat=>[chat.id,inputBusy(chat.id)]));
  value.mcp = { ssh: backend.status.ssh, mcp: backend.status.mcp, tunnel: backend.status.tunnel, mcpOwned:backend.status.mcpOwned, tunnelOwned:backend.status.tunnelOwned, forceControl:backend.appliedForceControl };
  const accountLocation = value.locations.find(item => item.managed);
  value.claudeUsage = { enabled: Boolean(accountLocation), accountName: accountLocation?.name || '',
    online: backend.status.ssh === 'ready' && backend.status.tunnel === 'ready', ...backend.usage.claude };
  value.claudeUpdate = claudeUpdater.snapshot();
  value.accountUsage = accountUsage.snapshot();
  value.skills=skills.list();
  value.skillSources=skills.system.sources();
  return value;
}
const quitBlockedCommands = new Set(['workflow-create', 'workflow-resume', 'workflow-plan', 'terminal-open', 'role-login']);
function handle(name, fn, withSender=false) {
  ipcMain.handle('desk:' + name, async (event, ...args) => {
    if (event.senderFrame?.url !== pathToFileURL(path.join(__dirname, 'index.html')).href) throw new Error('Untrusted sender.');
    if (quitting && quitBlockedCommands.has(name)) throw new Error('Relay Desk is closing.');
    const result = await (withSender?fn(event.sender,...args):fn(...args)); return result;
  });
}
function busyRole(id) { return [...running.values()].some(job => job.roleIds.includes(id))||interactiveAgents.list().some(e=>e.roleId===id&&e.state!=='ended'); }
function updateBadges() {
  return notifications.refresh();
}
function renderBadges(count) {
  if(process.platform==='win32'){
    if(workbenchWindow){
      const icon=count?nativeImage.createFromPath(path.join(__dirname,'../assets/badge-'+Math.min(9,count)+'.png')):null;
      workbenchWindow.setOverlayIcon(icon,count?count+' unread conversations':'');
    }
  }else app.setBadgeCount(count);
  if(!count)workbenchWindow?.flashFrame(false);
}
handle('snapshot', snapshot);
handle('skill-get',id=>skills.read(id));
handle('skill-sources-save',async value=>{await skills.system.saveSources(value);emit();return skills.system.sources();});
handle('skill-system-enabled',(id,enabled)=>{skills.system.setEnabled(skills.get(id),enabled);emit();return true;});
handle('skill-models',(value,options)=>skills.models(value,options));
handle('skill-save',value=>{const result=skills.save(value);emit();return result;});
handle('skill-delete',id=>{skills.remove(id);emit();});
handle('skill-cancel',(chatId,id)=>skills.cancel(chatId,id));
handle('account-usage', async roleId => { await accountUsage.request(roleId); return snapshot(); });
handle('usage-guide', (sender,roleId) => {const role=store.get('roles',roleId);if(role.engine==='antigravity'&&role.provider==='native')return quotaConsole.open(roleId,sender);const url=accountUsage.guide(roleId);if(url)return shell.openExternal(url); },true);
for(const method of ['action','screen','resize','stop'])handle('quota-'+method,(sender,...args)=>quotaConsole[method](sender,...args),true);
handle('usage-refresh', async () => {
  const location = store.state.locations.find(item => item.managed);
  if (!location) throw new Error('No managed Relay VPS account is configured.');
  await locations.connect(location.id);
  await backend.refreshUsage('claude', true);
  return snapshot();
});
handle('cli-check', () => require('./runtime.cjs').check());
handle('claude-cli', action => claudeUpdater.request(action));
handle('cli-update', () => { if (running.size||interactiveAgents.active()) throw new Error('End interactive terminals and pause running discussions before updating the CLI.'); return require('./runtime.cjs').install(); });
handle('models', (input, options) => modelCatalogs.request(input, options));
handle('agent-info', value => { if(!vendors.isVendor(value?.engine))throw new Error('Choose an official account agent.');return vendors.info(value); });
handle('agent-guide', engine => { if(!vendors.isVendor(engine))throw new Error('Choose an official account agent.');return shell.openExternal(vendors.catalog[engine].docs); });
handle('agent-install', async engine => { if(store.state.roles.some(role=>role.engine===engine&&busyRole(role.id)))throw new Error('Wait for active tasks using this agent to finish before updating.');return require('./vendor-install.cjs').install(engine); });
handle('role-save', value => {
  if (value.avatarId && !avatars.get(value.avatarId)) throw new Error('The selected avatar no longer exists. Choose it again.');
  const role = store.saveRole(value);
  if (value.apiKey && role.engine !== geminiWebEngine) vault.set('api:' + role.id, value.apiKey);
  emit(); return role;
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
  store.get('roles', id); store.state.roles = store.state.roles.filter(r => r.id !== id); for (const p of store.state.projects) p.roleIds = p.roleIds.filter(r => r !== id); vault.remove('api:' + id); store.save(); emit();
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
handle('project-save', value => { const result = store.saveProject(value); emit(); return result; });
handle('project-move', (id, offset) => { if (![-1, 1].includes(offset)) return; const p = store.get('projects', id); const index = store.state.projects.indexOf(p); const target = index + offset; if (target >= 0 && target < store.state.projects.length) { store.state.projects.splice(index, 1); store.state.projects.splice(target, 0, p); store.save(); emit(); } });
handle('project-delete', async id => {
  const project = store.get('projects', id); const chats = store.state.chats.filter(c => c.projectId === id);
  if (running.has(planJobKey(id))) throw new Error('请先关闭正在生成工作流的窗口。');
  if (chats.some(c => inputQueue.dispatching.has(c.id)||running.has(c.id)||interactiveAgents.active(c.id)||[...skills.jobs.values()].some(j=>j.chatId===c.id))) throw new Error('End this project interactive terminals, skills and discussions first.');
  const answer = await dialog.showMessageBox({ type: 'question', buttons: ['取消', '移除项目'], defaultId: 0, cancelId: 0, message: `移除“${project.name}”？`, detail: '仅从新界面移除。磁盘上的目录和原界面数据保留；聊天会存入本机归档。' });
  if (answer.response !== 1) return false;
  require('./store.cjs').atomic(path.join(data, 'archive', id + '-' + Date.now() + '.json'), { project, chats });
  for (const manager of terminalManagers.values()) manager.closeProject(id);
  store.state.projects = store.state.projects.filter(p => p.id !== id); store.state.chats = store.state.chats.filter(c => c.projectId !== id); store.save(); emit(); updateBadges(); return true;
});
handle('chat-add', value => { const chat = store.createChat(value); emit(); return chat; });
const workflowEngine=require('./workflow.cjs');
const generatedWorkflows=require('./generated-workflow.cjs');
const workflowRatings=require('./workflow-ratings.js');
const engineForWorkflow = flow => flow.type === 'generated' ? generatedWorkflows : workflowEngine;

function workflowProjectRoles(project) {
  return project.roleIds.map(id => store.state.roles.find(role => role.id === id))
    .filter(role => {
      if (!role || role.engine === geminiWebEngine || !project.directories.some(directory => directory.locationId === role.locationId)) return false;
      const location = store.state.locations.find(item => item.id === role.locationId);
      return location?.type === 'local' || (location?.os === 'linux' && role.provider === 'native');
    })
    .map(role => ({...role, locationName:locationName(role.locationId)}));
}

function workflowRoleIds(flow) {
  return [...new Set([...flow.teams.implement, ...flow.teams.review, ...(flow.moderatorRoleId ? [flow.moderatorRoleId] : [])])];
}
function workflowModerationRole(project, id) {
  const role = store.state.roles.find(item => item.id === id);
  if (!workflowEngine.canModerate(role)) throw new Error('Choose a Codex or Claude role to moderate the workflow.');
  if (!project.directories.some(directory => directory.locationId === role.locationId)) {
    throw new Error(formatMissingProjectDirectories(project, [role], locationName));
  }
  return role;
}
const planJobKey = projectId => `workflow-plan:${projectId}`;
handle('workflow-plan',async ({projectId, goal, plannerId, requestId}) => {
  const project = store.get('projects',projectId);
  const roles = workflowProjectRoles(project), key = planJobKey(project.id);
  if (!roles.some(role => role.id === plannerId)) throw new Error('Choose a planner invited to this project.');
  if (typeof requestId !== 'string' || requestId.length > 80 || running.has(key) || running.size+interactiveAgents.list().filter(entry=>entry.state!=='ended').length>=store.state.settings.maxJobs) {
    throw new Error('Wait for an available workspace task slot to generate a workflow.');
  }
  const planner = workflowModerationRole(project, plannerId);
  const task = generatedWorkflows.planTask(goal, workflowRatings.catalog(roles));
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
  if([...running.values()].some(job=>job.workflow))return;
  const chat=store.state.chats.filter(item=>item.workflow?.status==='queued'&&!item.disbandedAt&&!inputBusy(item.id))
    .sort((a,b)=>a.workflow.createdAt-b.workflow.createdAt)[0];
  if(!chat)return;
  const flow=chat.workflow,controller=new AbortController();
  const generated = flow.type === 'generated';
  const job={workflow:true,controller,roleIds:chat.roleIds,round:generated?flow.nodeIndex+1:flow.round,rounds:generated?flow.nodes.length:flow.limit};
  running.set(chat.id,job);
  const save=()=>{store.save();emit();};
  const currentProject = () => store.get('projects',chat.projectId);
  engineForWorkflow(flow).run(chat,{
    signal:controller.signal,save,
    roles:() => workflowProjectRoles(currentProject()),
    describe(id) {
      const role = store.state.roles.find(item => item.id === id);
      return role && {name:role.name, engine:role.engine, location:locationName(role.locationId), persona:role.persona?.slice(0, 600)};
    },
    route: flow.moderatorRoleId ? async (task, signal) => {
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
    async turn(attempt,prompt,signal) {
      job.phase='participant';job.roleId=attempt.roleId;job.round=generated?attempt.nodeIndex+1:attempt.round;job.taskId=attempt.id;
      const role=store.state.roles.find(r=>r.id===attempt.roleId);
      attempt.roleName=role?.name||attempt.roleId;
      if(!role||role.engine===geminiWebEngine)return {status:'failed',workflowSubmitted:false,errorCode:'ROLE_UNAVAILABLE',note:'Role unavailable for unattended execution.'};
      const project=currentProject();
      if (generated && !workflowProjectRoles(project).some(candidate=>candidate.id===role.id)) return {status:'failed',workflowSubmitted:false,errorCode:'ROLE_UNAVAILABLE',note:'Role unavailable for unattended execution.'};
      if (!project.directories.some(directory => directory.locationId === role.locationId)) {
        return {status:'failed',workflowSubmitted:false,errorCode:'ROLE_UNAVAILABLE',note:formatMissingProjectDirectories(project, [role], locationName)};
      }
      if (!chat.roleIds.includes(role.id)) chat.roleIds.push(role.id);
      store.message(chat.id,{kind:'user',text:prompt,status:'accepted',workflowAttemptId:attempt.id});
      emit();
      const closeSkills = () => skills.closeTask(attempt.id);
      signal.addEventListener('abort', closeSkills, {once:true});
      try {
        return await agents.run(chat.id,effectiveRole(chat,role),project,signal,false,{relayReplies:true,workflowAttemptId:attempt.id,taskId:attempt.id});
      } finally {
        signal.removeEventListener('abort', closeSkills);
      }
    },
  }).catch(error=>{flow.status='needs_check';flow.reason=error.message;}).finally(()=>{
    running.delete(chat.id);save();notifications.complete(chat.id);setImmediate(pumpWorkflows);
  });
}
function generatedConfiguration(value, project) {
  const roles = workflowProjectRoles(project);
  if (!roles.length) throw new Error('Invite a role with a configured project directory before running this workflow.');
  if (value.moderatorRoleId) {
    if (!roles.some(role => role.id === value.moderatorRoleId)) throw new Error('Choose a planner invited to this project.');
    workflowModerationRole(project,value.moderatorRoleId);
  }
  return generatedWorkflows.configure(value,roles);
}
handle('workflow-create',value=>{
  const project = store.get('projects',value.projectId);
  const generated = value.type === 'generated';
  const workflow = generated ? generatedConfiguration(value,project) : workflowEngine.configure(value,store.state.roles);
  if (!generated && workflow.moderatorRoleId) workflowModerationRole(project,workflow.moderatorRoleId);
  const roleIds = generated ? workflowProjectRoles(project).slice(0,100).map(role=>role.id) : workflowRoleIds(workflow);
  const chat=store.createChat({projectId:project.id,name:workflow.title||workflow.goal.slice(0,70),roleIds},{workflow});
  emit();setImmediate(pumpWorkflows);return {id:chat.id,projectId:chat.projectId};
});
handle('workflow-resume',(id,mode,guidance='')=>{
  const chat=activeChat(id),flow=chat.workflow;
  if(!flow||running.has(id)||!['unavailable','paused','needs_check'].includes(flow.status)||
      !((flow.type === 'generated'?['retry']:['review','retry']).includes(mode)))throw new Error('Workflow cannot resume from this state.');
  if(typeof guidance!=='string'||guidance.length>16000)throw new Error('Enter up to 16,000 characters of additional guidance.');
  if(guidance.trim())store.message(id,{kind:'user',text:guidance.trim(),status:'accepted'});
  if(mode==='review')flow.stage='review';
  delete flow.candidateOrder;
  delete flow.selection;
  flow.pending=null;flow.index=0;flow.status='queued';flow.reason='';store.save();emit();setImmediate(pumpWorkflows);
});
handle('workflow-generated-update',(id,value)=>{
  const chat=activeChat(id),flow=chat.workflow;
  if(flow?.type!=='generated'||running.has(id)||!['unavailable','needs_check','paused'].includes(flow.status))throw new Error('Teams can be changed while the workflow is stopped.');
  if(!Array.isArray(value.nodes)||value.nodes.length!==flow.nodes.length)throw new Error('The number of steps cannot change after the workflow starts.');
  const next=generatedConfiguration({...value,goal:flow.goal,nodes:value.nodes.slice(flow.nodeIndex)},store.get('projects',chat.projectId));
  flow.nodes=[...flow.nodes.slice(0,flow.nodeIndex),...next.nodes];
  flow.moderatorRoleId=next.moderatorRoleId;flow.index=0;
  delete flow.selection;
  store.save();emit();
});
handle('workflow-teams',(id,teams,moderatorRoleId)=>{
  const chat=activeChat(id),flow=chat.workflow;
  if(!flow||flow.type==='generated'||running.has(id)||!['unavailable','needs_check','paused'].includes(flow.status))throw new Error('Teams can be changed while the workflow is stopped.');
  const updated=workflowEngine.configure({...flow,teams,moderatorRoleId:moderatorRoleId ?? flow.moderatorRoleId},store.state.roles);
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
  if(chat.draft?.trim()||chat.draftAttachments?.length)throw new Error('请先处理输入框中的草稿和附件。');
  chat.disbandedAt=Date.now();chat.unread=false;store.save();emit();updateBadges();
});
handle('chat-role-settings', (chatId, roleId, value) => { activeChat(chatId);const chat = store.saveChatRole(chatId, roleId, value); emit(); return chat; });
handle('chat-session-reset',(chatId,roleId)=>{const chat=store.get('chats',chatId);if(!chat.roleIds.includes(roleId))throw new Error('Choose a participant in this chat.');if(running.has(chatId)||interactiveAgents.active(chatId))throw new Error('Pause the discussion and end its interactive terminal before resetting a native session.');if(chat.nativeSessions)delete chat.nativeSessions[roleId];store.save();emit();return snapshot();});
handle('chat-flow', (chatId, value) => { activeChat(chatId);const chat = store.saveChatFlow(chatId, value); emit(); return chat; });
handle('chat-order', (chatId, ids) => { activeChat(chatId);const chat = store.saveChatOrder(chatId, ids); emit(); return chat; });
handle('chat-delete', async id => { if (inputQueue.dispatching.has(id)||running.has(id)||interactiveAgents.active(id)||[...skills.jobs.values()].some(j=>j.chatId===id)) throw new Error('End this chat agent tasks, skills and interactive terminals before deleting it.'); const chat = store.get('chats', id); require('./store.cjs').atomic(path.join(data, 'archive', id + '.json'), chat); store.state.chats = store.state.chats.filter(c => c.id !== id); store.save(); emit(); updateBadges(); });
handle('draft', (id, text) => { const chat = activeChat(id); chat.draft = String(text).slice(0, 150000); store.save(); });
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
function prepareInput(value, queued=false){
  const chat=activeChat(value.chatId),project=store.get('projects',chat.projectId);
  if(chat.workflow)throw new Error('Use the workflow controls for this run.');
  const invocation=value.summary?null:require('./skills.cjs').parseCommand(value.text,skills.list());
  if(value.roleIds!==undefined&&(!Array.isArray(value.roleIds)||!value.roleIds.length||value.roleIds.length>chat.roleIds.length||value.roleIds.some(id=>typeof id!=='string')))throw new Error('Choose participants in this chat.');
  const roleIds=value.roleIds!==undefined?[...new Set(value.roleIds)]:value.roleId==='all'?[...chat.roleIds]:value.roleId?[value.roleId]:require('./conversations.cjs').replyRoleIds(chat);
  if(!roleIds.length||roleIds.some(id=>!chat.roleIds.includes(id)))throw new Error('Choose a participant in this chat.');
  const files=queued?attachments.validate(value.files||[]):attachments.select(chat.id,value.summary?[]:value.attachmentIds||[]);
  const text=String(value.text||'');if(!text.trim()&&!files.length)throw new Error('Enter a message.');
  if(text.length>150000)throw new Error('Message is too long. Attach a path instead.');
  const requestedRounds=discussion.limit(value.summary?1:value.rounds??chat.maxRounds??1),autoStop=value.autoStop??chat.autoStop??true;
  if(typeof autoStop!=='boolean')throw new Error('Choose whether AI may end the discussion early.');
  if(invocation?.skill.kind==='image'){if(files.length)throw new Error('首版生图技能仅接收文字；附件已保留，请移除附件或改用聊天发送。');skills.validate(invocation.skill.id,invocation.prompt);}
  else {
    const roles=roleIds.map(id=>store.get('roles',id));
    if(files.length&&roles.some(role=>role.engine===geminiWebEngine))throw new Error('Gemini 网页版角色仅支持文字。请移除附件，或改选其他角色。');
    const missingRoles = roles.filter(role => role.engine !== geminiWebEngine &&
      !project.directories.some(directory => directory.locationId === role.locationId));
    if (missingRoles.length) throw new Error(formatMissingProjectDirectories(project, missingRoles, locationName));
  }
  if(interactiveAgents.active(chat.id)&&(roleIds.length!==1||value.summary||store.get('roles',roleIds[0]).engine===geminiWebEngine))throw new Error('交互连接期间，请 @ 一位已连接角色发送。群聊接力请先结束交互连接。');
  return {chat,project,invocation,roleIds,files,text,requestedRounds,autoStop};
}
handle('send', value=>{
  const prepared=prepareInput(value),{chat,roleIds,files,text,requestedRounds,autoStop}=prepared;
  const roleSettings=Object.fromEntries(roleIds.map(id=>{const role=effectiveRole(chat,store.get('roles',id));return [id,{model:role.model||'',effort:role.effort||''}];}));
  return inputQueue.submit(chat.id,{chatId:chat.id,text,files,roleIds,rounds:requestedRounds,autoStop,summary:Boolean(value.summary),roleSettings},value.mode||'queue');
});
handle('queue-resume',id=>inputQueue.resume(id));
handle('queue-pause',id=>inputQueue.pause(id));
handle('queue-remove',(id,entryId)=>inputQueue.remove(id,entryId));
handle('queue-move',(id,entryId,offset)=>inputQueue.move(id,entryId,offset));
handle('queue-now',(id,entryId)=>inputQueue.now(id,entryId));
handle('queue-restore',(id,entryId)=>{
  const {chat,entry}=inputQueue.entry(id,entryId);
  if(chat.draft?.trim()||attachments.files(id).length)throw new Error('Clear the current draft before restoring a queued message.');
  chat.draft=entry.value.text;chat.draftAttachments=entry.value.files.map(file=>({...file,id:require('node:crypto').randomUUID()}));
  inputQueue.remove(id,entryId);return {text:chat.draft,attachments:chat.draftAttachments};
});
async function startSend(value,inputQueueId) {
  const {invocation,roleIds,files,requestedRounds,autoStop}=prepareInput(value,true);
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
  const rounds=group?requestedRounds:1;
  const moderatorId=group&&chat.roleIds.includes(chat.moderatorRoleId)&&store.get('roles',chat.moderatorRoleId).engine!==geminiWebEngine?chat.moderatorRoleId:'';
  const executionRoleIds=[...new Set([...roleIds,...(moderatorId?[moderatorId]:[])])];
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
    const state = {...store.state, chats:store.state.chats.map(item => item.id === chat.id ? item : {
      id:item.id, projectId:item.projectId, name:item.name, roleIds:item.roleIds, disbandedAt:item.disbandedAt, updatedAt:item.updatedAt,
    })};
    store.save();
    followLocalTask(chat, task, {chatId:chat.id, role:selectedRole, project, state});
    return {accepted:true, messageId:userMessage.id};
  }
  const job = { controller, roleIds:executionRoleIds, round: 1, rounds, roleId: roleIds[0],phase:'participant',taskId:userMessage.id }; running.set(chat.id, job); emit();updateBadges();
  const moderator=moderatorId?require('./moderator.cjs').coordinator({agents,store,chat,role:roles[moderatorId],project,signal:controller.signal,taskId:userMessage.id,onFallback:()=>{context.ignoreModeratorMemory=true;},onPhase:(phase,round,roleId)=>{job.phase=phase;job.round=round;job.roleId=roleId;emit();}}):null;
  (async () => {
    try {
      if(invocation?.skill.kind==='prompt'){const loaded=await skills.run(skills.scope(chat.id,null,userMessage.id),invocation.skill.id,invocation.prompt||'Apply the skill to this project.');context.skillInstructions=loaded.instructions;}
      const outcome=await discussion.run({roleIds,rounds,autoStop:group&&autoStop,signal:controller.signal,
        beforeRound:moderator?round=>moderator.beforeRound(round,rounds):undefined,
        reviewRound:moderator&&autoStop?round=>moderator.reviewRound(round,rounds):undefined,
        onTurn:(round,roleId)=>{job.round=round;job.roleId=roleId;job.phase=roles[roleId].engine===geminiWebEngine?'web-reply':'participant';emit();},
        runTurn:(roleId,control)=>{
          const role=roles[roleId],turnContext={...context,discussion:control};
          if(role.engine===geminiWebEngine)return geminiWeb.run(chat,role,controller.signal,turnContext,Boolean(value.summary));
          return agents.run(chat.id,role,structuredClone(project),controller.signal,Boolean(value.summary),turnContext);
        }});
      chat.lastDiscussion={...outcome,automatic:group&&autoStop,moderatorRoleId:moderatorId,userMessageId:userMessage.id,at:Date.now()};
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
  running.set(chat.id, {controller, roleIds:[task.roleId], roleId:task.roleId, round:1, rounds:1, taskId:task.id, localExecutor:true});
  emit();
  void (async () => {
    let outcome = 'failed', stopConfirmed, finished = false;
    try {
      if (request) await localExecutor.start(data, task, request, app);
      const progress = await localExecutor.follow(data, task, controller.signal, update => {
        if (update.binding) {
          chat.nativeSessions ||= {};
          chat.nativeSessions[task.roleId] = update.binding;
        }
        for (const message of update.messages) {
          const existing = chat.messages.find(item => item.id === message.id);
          if (existing) Object.assign(existing, message, {localTaskId:task.id});
          else chat.messages.push({...message, localTaskId:task.id});
          chat.updatedAt = Math.max(chat.updatedAt || 0, message.at);
        }
        store.scheduleSave();
        emit();
      });
      finished = true;
      if (progress.failure) throw new Error(progress.failure);
      outcome = progress.result.status === 'complete' ? 'answered' : progress.result.status === 'cancelled' ? 'paused' : 'failed';
      stopConfirmed = progress.result.stopConfirmed;
    } catch (error) {
      for (const message of chat.messages) if (message.localTaskId === task.id && message.status === 'running') message.status = 'interrupted';
      store.message(chat.id, {kind:'system', text:error.message, status:'failed'});
      if (controller.signal.aborted) stopConfirmed = false;
    } finally {
      chat.lastDiscussion = {state:outcome, rounds:outcome === 'answered' ? 1 : 0, maxRounds:1, userMessageId:task.id, at:Date.now(), stopConfirmed};
      delete chat.localTask;
      running.delete(chat.id);
      store.save();
      if (finished) localExecutor.clear(data, task.id);
      notifications.complete(chat.id);
      inputQueue.settled(chat.id, stopConfirmed === false ? 'stop_unconfirmed' : outcome);
    }
  })();
}
handle('pause', id => {inputQueue.pause(id);const job=running.get(id);job?.controller.abort();if(job?.taskId)skills.closeTask(job.taskId);emit(); });
handle('settings', value => { const n = Number(value.maxJobs); if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error('Choose between 1 and 8 concurrent discussions.'); const theme = value.theme ?? store.state.settings.theme; if (!['light', 'dark', 'system'].includes(theme)) throw new Error('Choose a supported appearance.'); store.state.settings.theme = theme; nativeTheme.themeSource = theme; store.state.settings.keepAwake = value.keepAwake === true; store.state.settings.maxJobs = n; store.save(); keepAwake.setEnabled(store.state.settings.keepAwake); emit(); });
handle('pick', async (kind,initialPath) => { const options={properties:[kind==='folder'?'openDirectory':'openFile',...(kind==='files'?['multiSelections']:[])]};if(kind==='folder'&&typeof initialPath==='string'&&initialPath.length<=4096&&path.isAbsolute(initialPath)&&!/[\x00-\x1f]/.test(initialPath))options.defaultPath=initialPath;const result=await dialog.showOpenDialog(options);return result.canceled?[]:result.filePaths; });
async function writeClipboardText(text) { if (typeof clipboard.writeText === 'function') clipboard.writeText(String(text)); else await clipboard.write([{ 'text/plain': String(text) }]); }
handle('copy', writeClipboardText);
async function readClipboardText() { if (typeof clipboard.readText === 'function') return clipboard.readText(); const items = await clipboard.read(); for (const item of items) if (item.types.includes('text/plain')) return (await item.getType('text/plain')).text(); return ''; }
handle('clipboard-text', readClipboardText);
handle('image', async id => {store.get('chats',id);const image=await imageSource.read();if(attachments.files(id).length>=8)throw new Error('Attach at most 8 files per message.');const file=images.stage(image,attachments.protectedPaths());try{const files=attachments.add(id,[file.path],file);emit();return files;}catch(error){images.remove(file);throw error;}});
handle('message-images',(chatId,messageId)=>messageImages.list(chatId,messageId));
handle('open', async (filename, projectId) => {
  if (/^https?:\/\//i.test(filename)) return shell.openExternal(filename);
  const project = store.get('projects', projectId);const local=project.directories.find(d=>d.locationId==='local');const file=await require('../project-paths.cjs').resolveProjectPath(local?.path||'',filename);
  const error = await shell.openPath(file); if (error) throw new Error(error); return '';
});
async function tools(projectId, directoryIndex) {
  const project = store.get('projects', projectId); const directory = project.directories[directoryIndex]; if (!directory) throw new Error('Choose a project directory.');
  const location = store.get('locations', directory.locationId); let facade = { log: () => {} };
  if (location.type !== 'local') {
    if (location.os !== 'linux') throw new Error('Remote file and terminal tools currently require Linux.');
    const client = await locations.connect(location.id); const home = (await locations.exec(location.id, 'printf %s "$HOME"')).trim();
    facade = { client, status: { ssh: 'ready' }, remoteDir: home + '/windows-mcp', exec: command => locations.exec(location.id, command), log: () => {} };
  }
  let manager = terminalManagers.get(location.id);
  if (!manager) { manager = new ProjectTerminals(facade, value => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('desk:terminal', value); }); terminalManagers.set(location.id, manager); }
  else manager.backend = facade;
  const loc = { kind: location.type === 'local' ? 'local' : 'remote', path: directory.path };
  return { manager, facade, project: { ...project, locations: [loc] }, loc };
}
handle('files', async (projectId, directory, parts, operation) => { const t = await tools(projectId, directory); return projectFiles(t.facade, t.project, t.loc, parts, operation); });
handle('terminals', () => [...terminalManagers.values()].flatMap(m => m.list()));
handle('terminal-open', async (projectId, directory) => {
  const t = await tools(projectId, directory);
  if (quitting) throw new Error('Relay Desk is closing.');
  return t.manager.open(t.project, t.loc);
});
handle('terminal-input', (id, data) => { for (const m of terminalManagers.values()) m.input(id, data); });
handle('terminal-resize', (id, cols, rows) => { for (const m of terminalManagers.values()) m.resize(id, cols, rows); });
handle('terminal-close', id => { for (const m of terminalManagers.values()) m.close(id); });
handle('agent-terminals',()=>interactiveAgents.list());
handle('agent-terminal-open',(chatId,roleId)=>{activeChat(chatId);return interactiveAgents.open(chatId,roleId);});
handle('agent-terminal-input',(id,value)=>interactiveAgents.input(id,value));
handle('agent-terminal-screen',(id,text)=>interactiveAgents.screen(id,text));
handle('agent-terminal-resize',(id,cols,rows)=>interactiveAgents.resize(id,cols,rows));
handle('agent-terminal-close',id=>interactiveAgents.close(id));
handle('role-login', async id => {
  const role = store.get('roles', id); if (role.provider !== 'native') throw new Error('API roles use the saved API key.');
  accountUsage.invalidate(id);
  const location = store.get('locations', role.locationId);
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
  window.loadFile(path.join(__dirname, 'login.html')); let output = '';
  pty.onData(value => { output = (output + value).slice(-160000); if (!window.isDestroyed()) window.webContents.send('login:data', value); });
  window.webContents.once('did-finish-load', () => window.webContents.send('login:data', output));
  const input = (event, value) => { if (event.sender === window.webContents && typeof value === 'string') pty.write(value); };
  ipcMain.on('login:input', input); window.on('closed', () => { ipcMain.removeListener('login:input', input); try { pty.kill(); } catch {} });
});
function createWindow() {
  const w = new BrowserWindow({ width: 1488, height: 1000, minWidth: 1000, minHeight: 650, show: !smoke, backgroundColor: nativeTheme.shouldUseDarkColors ? '#191d23' : '#ffffff', title: 'Relay Desk', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !smoke } });
  workbenchWindow = w;
  w.on('close', event => {
    if (quitReady) return;
    event.preventDefault();
    app.quit();
  });
  w.on('closed', () => { if(workbenchWindow===w)workbenchWindow=undefined; });
  w.on('show', updateBadges);
  w.on('restore', updateBadges);
  w.on('focus', () => { w.flashFrame(false); updateBadges(); });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); w.webContents.on('will-navigate', e => e.preventDefault()); w.webContents.session.setPermissionRequestHandler((_a, _b, cb) => cb(false));
  w.loadFile(path.join(__dirname, 'index.html'));
  w.webContents.once('did-finish-load',updateBadges);
  return w;
}
async function requestQuit(restart = false) {
  if (quitting || confirmingQuit) return;
  const hasActiveTasks = [...running.values()].some(job => !restart || !job.localExecutor) || skills.jobs.size || inputQueue.dispatching.size || interactiveAgents.active() ||
    [...terminalManagers.values()].some(manager => manager.list().some(terminal => terminal.state !== 'ended'));
  if (restart && hasActiveTasks) {
    const options = {type:'info', title:'重启工作台', message:'当前有任务或终端仍由工作台管理。', detail:'请等这些任务结束后重启。由后台执行器管理的本机任务可以在重启时继续运行。'};
    if (workbenchWindow) await dialog.showMessageBox(workbenchWindow, options);
    return;
  }
  if (hasActiveTasks) {
    confirmingQuit = true;
    try {
      const options = {
        type: 'warning', title: '退出 Relay Desk', message: '有任务正在运行，或有终端仍处于连接状态。',
        detail: '退出时会尝试停止任务并断开终端。聊天记录和待发送消息会保留。',
        buttons: ['取消', '结束任务并退出'], defaultId: 0, cancelId: 0, noLink: true,
      };
      const result = await (workbenchWindow ? dialog.showMessageBox(workbenchWindow, options) : dialog.showMessageBox(options));
      if (result.response !== 1) return;
    } catch (error) {
      console.error('Could not confirm workbench exit:', error);
      return;
    } finally {
      confirmingQuit = false;
    }
  }

  quitting = true;
  try {
    for (const chat of store.state.chats) if (chat.workflow?.status === 'queued') chat.workflow.status = 'paused';
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
    for (const chat of store.state.chats) {
      const flow = chat.workflow;
      if (flow?.status !== 'running') continue;
      flow.status = 'needs_check';
      flow.reason = 'Interrupted with no confirmed result. Inspect the workspace before retrying.';
      const pending = flow.attempts.find(attempt => attempt.id === flow.pending);
      if (pending) Object.assign(pending, {status:'interrupted', reason:flow.reason});
      flow.pending = null;
    }
    const cleanup = [() => store.save(), () => quotaConsole.close(), () => accountUsage.close(),
      () => claudeUpdater.close(), () => locations.close(), () => backend.stop(), () => keepAwake.dispose()];
    for (const close of cleanup) {
      try { close(); } catch (error) { console.error('Workbench exit cleanup failed:', error); }
    }
    quitReady = true;
    if (restart) {
      try { app.relaunch(); } catch (error) { console.error('Could not restart the workbench:', error); }
    }
    app.quit();
  }
}
  handle('workbench-restart', () => requestQuit(true));
  handle('workbench-quit', () => requestQuit());
  handle('workbench-support', async () => {
    const { supportUrl } = require('../package.json');
    if (!supportUrl) throw new Error('项目的 GitHub 支持页面尚未配置。');
    try { await shell.openExternal(supportUrl); }
    catch { throw new Error('无法在浏览器中打开 GitHub 支持页面。'); }
  });
  app.on('second-instance', () => { if (quitting) return; const w = workbenchWindow || createWindow(); w.show(); w.focus(); });
  app.whenReady().then(() => {
    keepAwake.start(); Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '文件', submenu: [{ id:'restart-workbench', label:'重启工作台', click:() => requestQuit(true).catch(error => console.error(error)) }, { role: 'quit', label: '退出' }] }, { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] }, { label: '视图', submenu: [{ label: '重新加载', role: 'reload' }, { label: '开发者工具', role: 'toggleDevTools' }, { label: '重置缩放', role: 'resetZoom' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }] }]));
    const w = createWindow();
    for(const chat of store.state.chats)if(chat.workflow)engineForWorkflow(chat.workflow).recover(chat);
    for (const chat of store.state.chats) if (chat.localTask) followLocalTask(chat, chat.localTask);
    store.save();
    const workflowTimer=setInterval(pumpWorkflows,3000);workflowTimer.unref();
    setImmediate(pumpWorkflows);
    if (skills.system.sources().some(source=>source.enabled&&source.locationId!=='local')) skills.system.refresh().then(emit);
    if (smoke) require('./smoke.cjs').run(w, store, app, data, { agents, running, inputQueue, notifications, backend, claudeUpdater, avatars, dialog, modelCatalogs, providerFetch, network, accountUsage,imageSource,quotaConsole,interactiveAgents,skills,shell,clipboard }).catch(error => { console.error(error); app.exit(1); });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    void requestQuit();
  });
}
}
