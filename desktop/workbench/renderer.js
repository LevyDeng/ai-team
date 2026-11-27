/* The renderer only receives sanitized state; credentials stay in the main process. */
const api = window.desk;
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<img src="icons/${name}.svg" alt="">`;
const workflowStepTimedOut = 'The workflow step timed out. Inspect the workspace and task output before retrying.';
const workflowStepTimeoutText = '旧版工作台在此步骤运行满 30 分钟后中断了任务。请检查工作区和任务输出后再重试。';
const backgroundActivityLabels = {
  'Waiting for background commands': '等待后台任务',
  'Verifying background results': '正在验收后台任务结果',
};
function isWorkflowStepTimeout(chat, message) {
  return message.kind === 'assistant' && (message.errorCode === 'WORKFLOW_STEP_TIMEOUT' ||
    Boolean(message.workflowAttemptId && chat.workflow?.attempts?.some(attempt =>
      attempt.id === message.workflowAttemptId && attempt.reason === workflowStepTimedOut)));
}
const avatar = (role, extra = '') => `<div class="avatar a${role?.avatar || 0} ${role?.avatarUrl ? 'custom' : ''} ${extra}" title="${esc(role?.name || '')}">${role?.avatarUrl ? `<img src="${esc(role.avatarUrl)}" alt="">` : ''}</div>`;
const group = () => `<div class="group-avatar">${icon('users')}</div>`;
let state, page = 'projects', projectId, chatId, roleId, locationId, filter = 'all', query = '', autoBottom = true, draftTimer, toastTimer, dialogSubmit, toolMode = 'terminal', terminals = [], terminalId;
let refreshPriorityView;
let settingsSection = 'general';
let fileView, fileRequest = 0;
const terminalViews = new Map();
const agentTerminalViews=new Map();let agentTerminals=[],activityMode='log';
const terminalConnectPending=new Set();
const attachmentTasks=new Map(),sendingChats=new Set();
const draftSchedules=new Map();
const scheduleDateFormat=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const vendorKinds = { antigravity:'Antigravity（反重力）',workbuddy:'WorkBuddy（兼容测试）',kimi:'Kimi Code',cursor:'Cursor Agent',codebuddy:'CodeBuddy Code',zcode:'ZCode（智谱 GLM）','custom-acp':'自定义 ACP' };
const acpPresets = {
  hermes: { label:'Hermes Agent', command:'hermes', args:['acp'] },
  pi: { label:'Pi（pi-acp）', command:'pi-acp', args:[] },
  dsh: { label:'DeepSeek Harness（dsh）', command:'dsh', args:['--profile','acp'] },
};
const geminiWebEngine = 'gemini-web';
const slackChatEngine = 'slack-chat';
const slackChatLabel = 'Slack 私信（Dot / Grok Bot，试验）';
const engineChoices = [['codex','Codex CLI'],['claude','Claude Code CLI'],...Object.entries(vendorKinds),['opencode','OpenCode'],[geminiWebEngine,'Gemini 网页版'],[slackChatEngine,slackChatLabel]];
const workflowStages = { implement: '执行阶段', review: '验收阶段' };
const workflowStatuses = {
  scheduled: '等待定时启动', queued: '排队中', running: '运行中', paused: '已暂停', complete: '已完成',
  unavailable: '候选角色不可用', needs_check: '待人工确认', round_limit: '已达轮数上限',
  failed: '失败', interrupted: '已中断', cancelled: '已取消', unresolved: '未解决',
};
const {supportsEffort, usesExternalConversation, modelOffering, modelDefault, parseCursorModel}=window.deskChatSettings;
const effortLabels={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'Ultra'};
const fallbackEfforts=['low','medium','high','xhigh'];
const roleCatalogs=new Map();
let claudeUpdateView, cliUpdatesView, usageCenter, composerTargetKey, roleModelPicker, chatModelPicker, activityView, activityRoleId, activityRunId, activityFollow = true;
let skillId,skillEditorVersion=0;
function mentionableRoles() {
  const conversation = chat(), activeProject = project();
  if (!conversation) return [];
  const members = conversation.roleIds.map(chatRole).filter(Boolean);
  const guests = window.deskMentions.projectGuestIds(conversation, activeProject).map(role).filter(Boolean)
    .map(profile => ({ ...profile, guest: true, mentionAllowed: activeProject.allowGuestMentions !== false }));
  return [...members, ...guests];
}
const composerRecipients = () => window.deskMentions.resolve($('input').value, mentionableRoles(), chat()?.defaultReplyRoleIds);
const mentions = window.deskMentions.create($('input'), $('mention-menu'), { roles: mentionableRoles, portrait: r => r.id === 'all' ? group() : avatar(r), changed: () => $('input').dispatchEvent(new Event('input')) });
const skillCommands=window.deskSkills.commands($('input'),$('skill-menu'),{skills:()=>state?.skills||[],changed:()=>$('input').dispatchEvent(new Event('input'))});
const project = () => state.projects.find(p => p.id === projectId);
const chat = () => state.chats.find(c => c.id === chatId && c.projectId === projectId);
const role = id => state.roles.find(r => r.id === id);
const roleEnabled = id => {
  const participant = role(id);
  return participant != null && participant.enabled !== false;
};
const chatRole = id => { const value = role(id); return value ? window.deskChatSettings.effectiveRole(chat(), value) : undefined; };
const roleButton = (id, extra = '') => `<button type="button" class="chat-role-avatar ${extra}" data-chat-role="${esc(id)}" title="${esc(role(id)?.name)} · 本对话角色设置">${avatar(role(id))}</button>`;
const locationOf = id => state.locations.find(l => l.id === id);
const chats = () => state.chats.filter(c => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
const projectOrders = [['recent', '最近使用'], ['name', '项目名称'], ['created', '创建时间'], ['manual', '手动排序']];
const projectNameOrder = new Intl.Collator('zh-CN', { numeric: true });
const projectOrder = () => state.settings.projectOrder || 'recent';
const projectOrderDirection = order => state.settings.projectOrderDirections?.[order] || (order === 'name' ? 'asc' : 'desc');
let savingProjectOrder = false;
function orderedProjects() {
  const order = projectOrder();
  if (order === 'manual') return state.projects;
  const direction = projectOrderDirection(order) === 'asc' ? 1 : -1;
  const latest = new Map();
  if (order !== 'name' && order !== 'created') for (const c of state.chats) {
    latest.set(c.projectId, Math.max(latest.get(c.projectId) || 0, c.updatedAt || 0));
  }
  const used = p => p.lastUsedAt || latest.get(p.id) || p.createdAt || 0;
  return state.projects.toSorted((a, b) => {
    if (order === 'name') return direction * projectNameOrder.compare(a.name, b.name);
    if (order === 'created') {
      if (!a.createdAt || !b.createdAt) return Number(Boolean(b.createdAt)) - Number(Boolean(a.createdAt));
      return direction * (a.createdAt - b.createdAt);
    }
    return direction * (used(a) - used(b));
  });
}
function rememberProject() {
  if (!projectId || projectId === state.settings.lastProjectId) return;
  const id = projectId;
  const previous = state.settings.lastProjectId;
  state.settings.lastProjectId = id;
  api['project-select'](id).then(at => {
    const selected = state.projects.find(p => p.id === id);
    if (selected) selected.lastUsedAt = at;
    renderProjectOptions();
  }).catch(error => {
    if (state.settings.lastProjectId === id) state.settings.lastProjectId = previous;
    toast('无法记住当前项目。' + uiError(error));
  });
}
const engineLabel = engine => engine === slackChatEngine ? slackChatLabel : ({ codex:'Codex CLI', claude:'Claude Code', opencode:'OpenCode', [geminiWebEngine]:'Gemini 网页版', ...vendorKinds }[engine] || engine);
function toast(value) { $('toast').textContent = String(value); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
const uiErrorMessages = new Map([
  ['Use unique domain and duty pairs with whole-number ratings from 1 to 10.', '请填写领域、职责和 1 到 10 的整数评分。每种组合只能评分一次，最多 80 项。'],
  ['Choose one location and a slash prefix for each skill source.', '请为每个技能来源选择一个位置并填写命令前缀。'],
  ['Use a slash prefix of up to 16 letters, digits or hyphens, starting with a letter.', '命令前缀须以字母开头，最多 16 个字符，可使用字母、数字和连字符。'],
  ['Enabled skill sources must have distinct slash prefixes.', '已启用的技能来源必须使用不同的命令前缀。'],
  ['Choose an available skill location.', '请选择一个可用的技能位置。'],
  ['Use an absolute skill folder or a path beginning with ~/ on the selected machine.', '请输入所选机器上的绝对路径，或以 ~/ 开头的路径。'],
  ['System skill not found. Refresh skill sources.', '找不到这个技能，请刷新技能来源。'],
  ['Skill not found.', '找不到这个技能。'],
  ['Choose whether to enable this skill.', '请选择是否启用此技能。'],
  ['Only ai-team skills can be edited here.', '请到技能来源修改外部导入的技能。'],
  ['Enter a unique command, a short name without spaces, and skill instructions.', '请填写唯一命令、不含空格的简短名称和技能说明。'],
  ['Choose a supported skill type.', '请选择受支持的技能类型。'],
  ['Skill name or command is already used.', '技能名称或命令已被使用。'],
  ['Wait for this skill to finish before editing it.', '请等技能执行完毕后再编辑。'],
  ['Wait for this skill to finish before deleting it.', '请等技能执行完毕后再删除。'],
  ['Keep API keys in the credential field, not in skill instructions.', '请把 API 密钥填入密钥栏，并从技能说明中移除。'],
  ['Use an HTTPS API base URL, or HTTP on localhost.', '请使用 HTTPS 接口地址。本机 localhost 也可使用 HTTP。'],
  ['Invalid image model ID.', '生图模型 ID 格式有误。'],
  ['App closed before completion. The partial response is preserved.', '应用在任务完成前退出，已收到的回复仍保留。'],
  ['ai-team is closing.', 'AI 小队正在退出。'],
  ['The local executor stopped reporting. Check the partial output before retrying.', '本机后台执行器已停止报告状态。请先检查已有输出，再决定是否重试。'],
  ['The remote agent did not confirm that it stopped. Check the remote job before resuming.', '远端任务尚未确认停止。请检查远端任务后再继续。'],
  ['The CLI disconnected without a completion event. The partial reply is preserved.', 'CLI 已断开，未收到完成信号。已收到的回复仍保留。'],
]);
function uiError(error) {
  const message = String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  return uiErrorMessages.get(message) || message;
}
async function action(fn) { try { return await fn(); } catch (e) { toast(uiError(e)); return undefined; } }
async function loginRole(id) {
  if (role(id)?.engine === geminiWebEngine) return api['gemini-web-open']();
  const result = await api['role-login'](id);
  if (result?.slackConnected) toast('Slack 私信授权已通过，可以在单聊中试发一条文字');
  if (result?.loginSource === 'desktop') toast('已确认桌面版 Codex 登录，可直接发送消息');
  if(result?.desktopOpened)toast('请在官方桌面版完成账号登录，再回到这里发送消息');
  if (result?.terminalId) { projectId = result.projectId; chatId = chats()[0]?.id; terminalId = result.terminalId; showPage('projects'); await openTools('terminal'); }
  if (result?.vpsConfigured) toast('VPS 上的 Antigravity 已通过登录验证，可以发送消息');
  return result;
}
function options(items, selected) { return items.map(([id, name]) => `<option value="${esc(id)}" ${String(id) === String(selected) ? 'selected' : ''}>${esc(name)}</option>`).join(''); }
function searchMarkup(placeholder) { return `<label class="search">${icon('search')}<input id="search" value="${esc(query)}" placeholder="${placeholder}" aria-label="${placeholder}" maxlength="300"></label>`; }
function conversationActivity() {
  const jobs=Object.values(state.running);
  const waiting=jobs.filter(job=>job.phase==='web-reply'&&!job.stopping).length;
  const planning=jobs.filter(job=>job.phase==='workflow-plan').length;
  return `${jobs.length-waiting-planning} 个讨论运行中`+(waiting?` · ${waiting} 个待录入回复`:'')+(planning?` · ${planning} 个工作流生成中`:'');
}
function renderWorkbenchFooter() {
  $('sidebar-bottom').querySelector('.status-line>span').textContent=conversationActivity();
  const awake=state.settings.keepAwake;
  $('awake-toggle').setAttribute('aria-pressed',String(awake));
  $('awake-state').textContent=awake?'已开启':'已关闭';
}
function bindWorkbenchFooter() {
  const actions=$('workbench-actions'), trigger=$('workbench-menu'), panel=$('workbench-menu-panel');
  const setOpen=(open,returnFocus=false)=>{
    panel.hidden=!open;
    trigger.setAttribute('aria-expanded',String(open));
    if (open) panel.querySelector('button').focus();
    else if (returnFocus) trigger.focus();
  };
  trigger.onclick=()=>setOpen(panel.hidden);
  document.addEventListener('pointerdown',event=>{
    if (!panel.hidden&&!actions.contains(event.target)) setOpen(false);
  });
  actions.addEventListener('focusout',event=>{
    if (!panel.hidden&&event.relatedTarget&&!actions.contains(event.relatedTarget)) setOpen(false);
  });
  actions.addEventListener('keydown',event=>{
    if (event.key==='Escape'&&!panel.hidden) {event.preventDefault();setOpen(false,true);}
  });
  $('usage-center-open').onclick=()=>openUsage();
  $('awake-toggle').onclick=()=>action(()=>api.settings({...state.settings,keepAwake:!state.settings.keepAwake}));
  $('workbench-restart').onclick=()=>{setOpen(false,true);return action(()=>api['workbench-restart']());};
  $('workbench-quit').onclick=()=>{setOpen(false,true);return action(()=>api['workbench-quit']());};
}
function hasUnreadIndicator(chat) {
  return chat.unread && !['queued','running'].includes(chat.workflow?.status) &&
    !(chat.workflow && state.running[chat.id]);
}
function renderProjectNotifications() {
  const select=$('project-select'),badge=$('project-unread');if(!select||!badge)return;
  const unread=new Set(state.chats.filter(hasUnreadIndicator).map(c=>c.projectId));
  const others=state.projects.filter(p=>p.id!==projectId&&unread.has(p.id));
  for(const option of select.options){const p=state.projects.find(p=>p.id===option.value);if(!p)continue;const n=state.chats.filter(c=>c.projectId===p.id&&state.running[c.id]).length;option.textContent=(p.id!==projectId&&unread.has(p.id)?'● ':'')+p.name+(n?' ('+n+')':'');}
  badge.hidden=!others.length;badge.parentElement.classList.toggle('has-unread',Boolean(others.length));
  const label=others.length?'新回复：'+others.map(p=>p.name).join('、'):'';badge.setAttribute('aria-label',label||'其他项目有新回复');select.title=label;
}
function renderSidebar() {
  if (!project()) projectId = orderedProjects()[0]?.id;
  if (page === 'projects') {
    $('sidebar-top').innerHTML = `<div class="project-selector"><div class="project-select-wrap"><select id="project-select" aria-label="项目"></select><span id="project-unread" class="badge project-unread" role="img" aria-label="其他项目有新回复" hidden></span></div><button class="icon-button" id="project-edit" title="项目设置" aria-label="项目设置">${icon('dots')}</button><button class="icon-button" id="project-new" title="新项目" aria-label="新项目">${icon('plus')}</button></div><div class="project-order"><label for="project-order">项目排序</label><select id="project-order">${options(projectOrders, projectOrder())}</select><button type="button" id="project-order-direction" class="icon-button" hidden></button></div>${searchMarkup('搜索会话、角色或消息')}<div class="tabs"><button data-filter="all" class="${filter === 'all' ? 'active' : ''}">全部</button><button data-filter="direct" class="${filter === 'direct' ? 'active' : ''}">单聊</button><button data-filter="group" class="${filter === 'group' ? 'active' : ''}">群聊</button><button id="chat-new" class="icon-button" title="新建对话">${icon('plus')}</button></div>`;
    renderProjectOptions();
    $('project-select').onchange = e => { saveDraftNow(); projectId = e.target.value; chatId = chats()[0]?.id; renderSidebar(); activateChat(); refreshTerminalTabs(); };
    $('project-order').onchange = e => action(() => saveProjectOrder(e.target.value));
    $('project-order-direction').onclick = () => action(() => saveProjectOrder(projectOrder(), projectOrderDirection(projectOrder()) === 'asc' ? 'desc' : 'asc'));
    $('chat-new').insertAdjacentHTML('beforebegin','<button data-filter="workflow">工作流</button>');
    $('sidebar-top').querySelector('[data-filter="workflow"]').classList.toggle('active',filter==='workflow');
    $('chat-new').title = filter === 'workflow' ? '新建工作流' : '新建对话';
    $('project-edit').onclick = () => openProject(project()); $('project-new').onclick = () => openProject(); $('chat-new').onclick = () => filter==='workflow'?openGroupWorkflowDestination():openChat();
    document.querySelectorAll('[data-filter]').forEach(b => { b.onclick = () => { saveDraftNow();filter = b.dataset.filter;
      if(filter==='workflow'&&!chat()?.workflow)chatId=chats().find(item=>item.workflow)?.id;
      renderSidebar();activateChat(); }; });
  } else {
    const title = page === 'roles' ? '角色' : page==='skills'?'技能': page === 'locations' ? '位置' : '设置';
    $('sidebar-top').innerHTML = `<div class="sidebar-title"><h2>${title}</h2>${page === 'skills' ? `<button id="skill-sources" class="icon-button" title="技能来源" aria-label="技能来源">${icon('settings')}</button>` : ''}${page !== 'settings' ? `<button id="entry-new" class="icon-button" title="新建${title}">${icon('plus')}</button>` : ''}</div>${page !== 'settings' ? searchMarkup('搜索' + title + '…') : ''}`;
    if ($('skill-sources')) $('skill-sources').onclick = openSkillSources;
    if ($('entry-new')) $('entry-new').onclick = () => page === 'roles' ? editRole() : page==='skills'?action(()=>editSkill()):editLocation();
  }
  if ($('search')) $('search').oninput = e => { query = e.target.value; renderList(); refreshSidebarSearch(); };
  renderList();
  refreshSidebarSearch();
  renderProjectNotifications();
  renderWorkbenchFooter();
}
async function saveProjectOrder(order, direction) {
  if (savingProjectOrder) return;
  savingProjectOrder = true;
  renderProjectOrderControls();
  try {
    const preferences = await api['project-order'](order, direction);
    Object.assign(state.settings, preferences);
  } finally {
    savingProjectOrder = false;
    renderProjectOptions();
  }
}
function renderProjectOrderControls() {
  const select = $('project-order');
  if (!select) return;
  const order = projectOrder();
  const ascending = projectOrderDirection(order) === 'asc';
  select.value = order;
  select.disabled = savingProjectOrder;
  const button = $('project-order-direction');
  button.hidden = order === 'manual';
  button.setAttribute('aria-disabled', String(savingProjectOrder));
  button.innerHTML = icon(ascending ? 'arrow-up' : 'arrow-down');
  button.title = ascending ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序';
  button.setAttribute('aria-label', button.title);
}
function renderProjectOptions() {
  const select = $('project-select');
  if (!select) return;
  renderProjectOrderControls();
  const entries = orderedProjects().map(p => [p.id, p.name]);
  const key = JSON.stringify(entries);
  if (select._projects !== key) {
    select._projects = key;
    select.innerHTML = options(entries, projectId);
  }
  select.value = projectId || '';
  renderProjectNotifications();
}
let sidebarSearchTimer, sidebarSearchResults;
function refreshSidebarSearch() {
  clearTimeout(sidebarSearchTimer);
  const target = projectId, needle = query.trim();
  if (page !== 'projects' || !target || !needle) return;
  sidebarSearchTimer = setTimeout(() => action(async () => {
    const ids = await api['project-search'](target, needle);
    if (page !== 'projects' || projectId !== target || query.trim() !== needle) return;
    sidebarSearchResults = { target, needle, ids: new Set(ids) };
    renderList();
  }), 180);
}
function renderList() {
  const q = query.trim().toLowerCase();
  if (page === 'projects') {
    const matches = sidebarSearchResults?.target === projectId && sidebarSearchResults?.needle === query.trim() ? sidebarSearchResults.ids : null;
    const entries = chats().filter(c => (filter === 'all' || (filter === 'workflow' ? Boolean(c.workflow) : !c.workflow && (filter === 'direct' ? c.roleIds.length === 1 : c.roleIds.length > 1))) && (!q || matches?.has(c.id) || [c.name, ...c.roleIds.map(id => role(id)?.name)].some(name => name?.toLowerCase().includes(q))));
    $('sidebar-list').innerHTML = entries.map(c => {
      const last = c.lastMessage; const busy = state.running[c.id];
      const preview=c.workflow?`${c.workflow.nodes?'步骤 '+(c.workflow.nodeIndex+1):workflowStages[c.workflow.stage]} · ${workflowStatuses[c.workflow.status] || c.workflow.status}`:c.disbandedAt?'已解散 · 仅查看历史':last?.kind==='skill'?last.skillName+' · '+({running:'执行中',complete:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'}[last.status]||last.status):'';
      const waiting = busy?.phase==='web-reply'&&!busy.stopping;
      const unreadTitle = c.workflow ? '工作流有新结果' : '有新回复';
      const indicator=waiting?'<span role="img" aria-label="待录入回复" title="待录入回复">…</span>':busy?'<img class="spinner" src="icons/refresh.svg" alt="运行中">':hasUnreadIndicator(c)?`<span class="badge" title="${unreadTitle}"></span>`:'';
      return `<button class="list-row ${c.id === chatId ? 'active' : ''}" data-chat="${c.id}">${c.roleIds.length > 1 ? group() : avatar(role(c.roleIds[0]))}<div class="row-text"><div class="row-title">${indicator}<span class="conversation-title" title="${esc(c.name)}">${esc(c.name)}</span><time>${new Date(c.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><p>${esc((waiting?'待录入 Gemini 回复':preview) || last?.text?.replace(/[#*`\n]/g, '').slice(0, 55) || (c.roleIds.length + ' 人 · 等待开始对话'))}</p></div></button>`;
    }).join('') || `<p class="hint" style="padding:18px 9px">${q ? '没有匹配的会话。' : '还没有对话，点击上方加号开始。'}</p>`;
    document.querySelectorAll('[data-chat]').forEach(b => { b.onclick = () => { saveDraftNow(); chatId = b.dataset.chat; autoBottom = true; renderList(); activateChat(); }; });
  } else if (page === 'roles') {
    $('sidebar-list').innerHTML = `<button type="button" id="role-priorities-open" class="list-row ${refreshPriorityView ? 'active' : ''}">${icon('checks')}角色优先级</button>` + state.roles.filter(r => (r.name + r.description).toLowerCase().includes(q)).map(r => `<button data-role="${r.id}" class="list-row ${!refreshPriorityView && r.id === roleId ? 'active' : ''}">${avatar(r)}<div class="row-text"><div class="row-title">${esc(r.name)}${r.enabled === false ? '<span class="pill role-disabled-badge">已禁用</span>' : ''}</div><p>${esc(r.description || engineLabel(r.engine) + ' · ' + locationOf(r.locationId)?.name)}</p>${r.enabled === false ? '' : `<small class="role-usage-summary">${esc(window.deskUsage.summary(state.accountUsage?.find(e=>e.roleIds.includes(r.id))))}</small>`}</div></button>`).join('');
    $('role-priorities-open').onclick = openRolePriorities;
    document.querySelectorAll('[data-role]').forEach(b => { b.onclick = () => editRole(role(b.dataset.role)); });
  } else if(page==='skills'){
    const groups = new Map();
    for (const skill of state.skills || []) {
      const label = skill.sourceLabel || '工作台技能';
      if (![skill.name,skill.description,skill.command,label,skill.locationName].join(' ').toLowerCase().includes(q)) continue;
      const groupId = skill.source || 'workbench';
      if (!groups.has(groupId)) groups.set(groupId, {label,location:skill.locationName,skills:[]});
      groups.get(groupId).skills.push(skill);
    }
    $('sidebar-list').innerHTML = [...groups.values()].map(({label,location,skills}) => `<section class="skill-source-group"><h3>${esc(label)}${location ? ` · ${esc(location)}` : ''}</h3>${skills.map(s => `<button data-skill="${esc(s.id)}" class="list-row ${s.id===skillId?'active':''}">${icon('robot')}<div class="row-text"><div class="row-title">${esc(s.name)}</div><p>/${esc(s.command)} · ${s.enabled?(s.ready?'可用':'待配置'):'已停用'}</p></div></button>`).join('')}</section>`).join('') || `<p class="hint">${q ? '没有匹配的技能。' : '还没有技能。'}</p>`;
    document.querySelectorAll('[data-skill]').forEach(b=>b.onclick=()=>action(()=>editSkill(b.dataset.skill)));
  } else if (page === 'locations') {
    $('sidebar-list').innerHTML = state.locations.filter(l => l.name.toLowerCase().includes(q)).map(l => { const conn = state.connectionStatus?.[l.id]; const tunnel = state.mcpTunnels?.tunnels?.[l.id]; const detail = l.type === 'local' ? '本地 · 内置' : `${l.username}@${l.host}` + (tunnel?.state === 'ready' ? ` · MCP 隧道 :${tunnel.remotePort}` : conn === 'ready' ? ' · SSH 已连接' : ''); return `<button data-location="${l.id}" class="list-row ${l.id === locationId ? 'active' : ''}"><div class="group-avatar">${icon(l.type === 'local' ? 'device-desktop' : 'server')}</div><div class="row-text"><div class="row-title">${esc(l.name)}</div><p>${esc(detail)}</p></div></button>`; }).join('');
    document.querySelectorAll('[data-location]').forEach(b => { b.onclick = () => editLocation(locationOf(b.dataset.location)); });
  } else {
    const list = $('sidebar-list');
    if (!list.querySelector('[data-settings-section]')) {
      list.innerHTML = `<button type="button" class="list-row" data-settings-section="general">${icon('settings')}通用设置</button><button type="button" class="list-row" data-settings-section="updates">${icon('refresh')}更新中心<span id="cli-settings-badge" class="cli-update-badge" aria-hidden="true" hidden></span></button><button type="button" class="list-row" data-settings-section="about">${icon('info-circle')}关于</button>`;
      list.querySelectorAll('[data-settings-section]').forEach(button => {
        button.onclick = () => {
          const section = button.dataset.settingsSection;
          if (settingsSection === section) return;
          settingsSection = section;
          if (section === 'about') renderAbout();
          else if (section === 'updates') renderUpdateCenter();
          else renderSettings();
          renderList();
        };
      });
    }
    list.querySelectorAll('[data-settings-section]').forEach(button => {
      const active = button.dataset.settingsSection === settingsSection;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
  }
  renderUpdateBadges();
}
function showPage(next) {
  saveDraftNow(); roleModelPicker?.destroy(); roleModelPicker = undefined; page = next; query = '';
  cliUpdatesView = claudeUpdateView = undefined;
  refreshPriorityView = undefined;
  if (page === 'settings') settingsSection = 'general';
  document.body.classList.toggle('editor-mode', page !== 'projects');
  if (page !== 'projects') document.body.classList.remove('tools-wide');
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $('chat-view').hidden = page !== 'projects'; $('editor-view').hidden = page === 'projects'; $('tools-rail').hidden = page !== 'projects';
  if (page !== 'projects') $('tools-panel').hidden = true;
  renderSidebar();
  if (page === 'projects') activateChat();
  else if (page === 'roles') editRole(role(roleId) || state.roles[0]);
  else if(page==='skills')action(()=>editSkill(state.skills?.some(skill=>skill.id===skillId)?skillId:state.skills?.[0]?.id));
  else if (page === 'locations') editLocation(locationOf(locationId) || state.locations[0]);
  else if (settingsSection === 'updates') renderUpdateCenter();
  else renderSettings();
}
function saveDraftNow() { if (chatId && state?.chats.some(c => c.id === chatId) && !$('composer').hidden) { clearTimeout(draftTimer); const text = $('input').value; const current = state.chats.find(c => c.id === chatId); current.draft = text; return api.draft(chatId, text).catch(e => toast(e.message)); } }
let historyView, messageRenderTimer;
const visibleMessage = (id, messageId) => historyView?.id === id ? historyView.messages.find(message => message.id === messageId) : undefined;
function renderHistoryControls() {
  $('history-pages').hidden = !historyView?.older && !historyView?.newer;
  $('history-older').disabled = !historyView?.older;
  $('history-newer').disabled = !historyView?.newer;
  $('history-latest').disabled = !historyView?.newer;
}
async function loadMessagePage(cursor, { navigate = false, target } = {}) {
  const view = historyView, c = chat();
  if (!view || view.id !== c?.id) return;
  const request = view.request = { pending: new Map() };
  const revision = c.historyVersion;
  let result;
  try { result = await api['chat-messages'](c.id, cursor); }
  catch (error) {
    if (historyView !== view || view.request !== request) return;
    view.request = null;
    throw new Error('无法加载对话消息。' + uiError(error));
  }
  if (historyView !== view || view.request !== request) return;
  view.request = null;
  view.cursor = result.newer ? cursor : undefined;
  view.messages = result.messages;
  view.older = result.older;
  view.newer = result.newer;
  view.revision = revision;
  for (const {message, atEnd} of request.pending.values()) applyMessage(view, message, atEnd);
  renderHistoryControls();
  if (navigate) autoBottom = !result.newer && !target;
  renderMessages();
  if (target) {
    const node = $('msg-' + target);
    if (node) {
      node.classList.add('message-search-match');
      requestAnimationFrame(() => node.scrollIntoView({ block: 'center' }));
    } else toast('找不到这条消息，可能已被移除。');
  } else if (navigate && result.newer) {
    const list = $('messages');
    list.scrollTop = cursor?.before ? list.scrollHeight : 0;
  }
}
function applyMessage(view, message, atEnd) {
  const index = view.messages.findIndex(item => item.id === message.id);
  if (index >= 0) view.messages[index] = message;
  else if (!view.newer && atEnd) {
    view.messages.push(message);
    if (view.messages.length > 40) { view.messages.shift(); view.older = true; }
  }
}
function refreshMessagePage() {
  if (historyView?.id === chat()?.id && historyView && !historyView.request && historyView.revision !== chat().historyVersion) {
    return action(() => loadMessagePage(historyView.cursor));
  }
}
function activateChat({ targetMessageId } = {}) {
  skillCommands.close();
  $('workflow-status')?.remove();
  const c = chat(); const has = Boolean(c); $('composer').hidden = !has || Boolean(c.disbandedAt); $('empty-chat').hidden = has; $('messages').hidden = !has;
  closeSendOptions(); renderScheduledTasks(c); renderScheduleSelection(c);
  $('tool-workflow').hidden = !c || Boolean(c.workflow || c.disbandedAt);
  if (toolMode==='workflow'&&!$('tools-panel').hidden) renderGroupWorkflows();
  const workflowFilter = filter === 'workflow';
  $('empty-chat').querySelector('h2').textContent = workflowFilter ? '还没有工作流' : '让想法在这里碰面';
  $('empty-chat').querySelector('p').textContent = workflowFilter ? '新工作流在群聊的右栏里保存和启动。' : '与一个角色深入交流，或邀请多个角色一起讨论。';
  $('empty-create').innerHTML = icon('plus') + (workflowFilter ? '新建工作流' : '新建对话');
  $('chat-settings').hidden = !has; $('participants').innerHTML = has && !c.disbandedAt ? c.roleIds.map(id => roleButton(id)).join('') : '';
  $('chat-avatar').innerHTML = has ? (c.roleIds.length > 1 ? group() : roleButton(c.roleIds[0])) : group();
  $('chat-title').textContent = c?.name || project()?.name || '开始一段对话';
  $('chat-subtitle').textContent = has ? (c.disbandedAt?'群聊已解散':c.workflow?.nodes?c.workflow.nodes.length+' 个步骤':c.roleIds.length+' 名角色参与')+' · '+project().name : workflowFilter ? '从当前项目创建工作流' : '选择项目，邀请你的 AI 角色';
  $('input').value = c?.draft || ''; renderAttachments();
  mentions.close(); composerTargetKey = undefined;
  $('rounds').value=c?.maxRounds||1;$('auto-stop').checked=c?.autoStop!==false;
  $('group-flow').hidden = !has || c.roleIds.length < 2; if (has) $('reply-flow').value = c.relayReplies === false ? 'independent' : 'relay';
  bindChatRoleAvatars();
  rememberProject();
  $('chat-find').hidden = !has;
  if (historyView?.id !== c?.id) {
    window.deskMessageImages.clear();
    $('messages').replaceChildren();
    closeChatSearch();
    historyView = c && { id: c.id, messages: [] };
    autoBottom = true;
    renderHistoryControls();
    if (c) {
      if (targetMessageId) action(() => loadMessagePage({ around: targetMessageId }, { navigate: true, target: targetMessageId }));
      else action(() => loadMessagePage());
    }
  } else refreshMessagePage();
  renderMessages(); quickSettings(); renderToolDirectory();
  if (toolMode === 'files' && !$('tools-panel').hidden && fileView?.projectId !== projectId) action(loadFiles);
}
function renderMessages() {
  const c = chat(); if (!c || page !== 'projects') return;
  renderScheduledTasks(c);
  refreshMessagePage();
  const view = historyView?.id === c.id ? historyView : null;
  const messages = (view?.messages || []).filter(message=>!message.workflowInstruction);
  const list = $('messages'); const shouldScroll = !view?.newer && (autoBottom || list.scrollHeight - list.scrollTop - list.clientHeight < 100);
  const ids = new Set(messages.map(message => 'msg-' + message.id));
  for (const element of [...list.children]) if (!ids.has(element.id)) {
    window.deskMessageImages.remove(element.querySelector('.message-images'));
    element.remove();
  }
  for (const m of messages) {
    if(m.moderatorTask){renderModeratorMessage(list,c,m);continue;}
    if(m.kind==='skill'){let element=document.getElementById('msg-'+m.id);if(!element){element=document.createElement('article');element.id='msg-'+m.id;list.append(element);}window.deskSkills.message(element,m,{caller:role(m.callerRoleId)?.name,preview:file=>action(()=>previewReplyImage(c,m,file)),open:file=>action(()=>openPathReference(file,c.projectId,{chatId:c.id,messageId:m.id})),copy:text=>action(()=>api.copy(text)),cancel:id=>action(()=>api['skill-cancel'](c.id,id)),review:()=>openHandoff(c,m.handoff,m.request)});continue;}
    if (m.kind === 'system' && document.getElementById('msg-' + m.id)) continue;
    let element = document.getElementById('msg-' + m.id);
    if (!element) {
      element = document.createElement('article'); element.id = 'msg-' + m.id; element.className = 'message ' + m.kind;
      if (m.kind === 'system') { element.className = m.agentInvitation ? 'system-message agent-invitation' : 'system-message'; element.textContent = m.text; list.append(element); continue; }
      element.innerHTML = `${m.kind === 'user' ? `<img class="user-icon" src="icons/user.svg" alt="我">` : m.workflowResult ? group() : roleButton(m.roleId)}<div class="message-content">${m.kind === 'assistant' ? `<div class="message-meta"><b>${esc(m.roleName)}</b><span></span></div>` : ''}${m.workflowTitle&&!m.workflowResult?`<p class="workflow-message-label hint">${esc([m.workflowTitle,...(m.workflowPath||[]).map(step=>step.title+(step.round?' · 第 '+step.round+' 轮':''))].join(' / '))}</p>`:''}<div class="message-bubble"></div><div class="message-images" hidden></div><details class="message-reasoning" hidden><summary>思考摘要（CLI 提供）</summary><pre></pre></details><details class="message-tools" hidden><summary>工具活动</summary><ul></ul></details><div class="message-note" hidden></div><div class="message-footer"><time>${new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><span class="message-state"></span><button class="quiet task-output" ${m.kind !== 'assistant' || m.workflowResult ? 'hidden' : ''}>任务输出</button><button class="quiet copy-full">复制全文</button><button class="quiet restore" ${m.kind !== 'user' ? 'hidden' : ''}>恢复文字</button></div></div>`;
      element.querySelector('.copy-full').onclick = () => action(async () => { const current=visibleMessage(c.id,m.id)||m;await api.copy(window.deskAttachments.messageText(current)); toast('已复制整条消息'); });
      element.querySelector('.restore').textContent='恢复输入';
      element.querySelector('.restore').onclick = () => {if(!chat()?.disbandedAt)restoreInput(c.id,m.id);};
      element.querySelector('.task-output').onclick = () => { activityMode=m.nativeTerminalId&&agentTerminals.some(t=>t.id===m.nativeTerminalId&&t.state!=='ended')?'interactive':'log';activityRoleId = m.roleId; activityRunId = m.id; activityFollow = false; action(() => openTools('activity')); };
      if (m.kind === 'assistant') {
        const login = document.createElement('button'); login.type = 'button'; login.className = 'quiet native-login'; login.textContent = '登录此角色'; login.hidden = true;
        login.onclick = () => action(() => loginRole(m.roleId)); element.querySelector('.message-footer').append(login);
        const model = document.createElement('button'); model.type = 'button'; model.className = 'quiet select-task-model'; model.textContent = '选择本对话模型'; model.hidden = true;
        model.onclick = () => openChatRole(m.roleId); element.querySelector('.message-footer').append(model);
        const diagnostic=document.createElement('button');diagnostic.type='button';diagnostic.className='quiet diagnostic-copy';diagnostic.textContent='复制诊断';diagnostic.hidden=true;diagnostic.onclick=()=>action(async()=>{const current=visibleMessage(c.id,m.id);if(current?.diagnostics){await api.copy(JSON.stringify(current.diagnostics,null,2));toast('已复制诊断元数据，不包含提示词、图片或密钥');}});element.querySelector('.message-footer').append(diagnostic);
      }
      list.append(element); bindChatRoleAvatars();
    }
    if (m.kind==='user')element.querySelector('.restore').hidden=Boolean(c.disbandedAt);
    if(m.branchContext){
      element.querySelector('.message-meta b').textContent='分支上下文';
      element.querySelector('.message-meta span').hidden=true;
      element.querySelector('.task-output').hidden=true;
      element.querySelector('.chat-role-avatar')?.remove();
    }
    if (m.geminiWeb) renderGeminiWebTurn(element, c, m);
    const reasoning = element.querySelector('.message-reasoning'); reasoning.hidden = !m.thinking; if (reasoning.querySelector('pre').textContent !== (m.thinking || '')) reasoning.querySelector('pre').textContent = m.thinking || '';
    renderMessageTools(element.querySelector('.message-tools'), c.id, m);
    if (m.kind === 'assistant'&&!m.workflowResult) element.querySelector('.message-meta>span').textContent = engineLabel(role(m.roleId)?.engine) + ' · ' + (locationOf(m.locationId)?.name || '') + (m.model ? ' · ' + m.model : '');
    if(m.kind==='assistant'&&m.nativeSession){const meta=element.querySelector('.message-meta');let badge=meta.querySelector('.native-session-label');if(!badge){badge=document.createElement('span');badge.className='native-session-label';meta.append(badge);}badge.textContent=m.nativeSession.mode==='resumed'?'沿用原生会话':m.nativeSession.mode==='compatibility'?'历史衔接（CLI 不支持恢复）':'新原生会话';badge.title=m.nativeSession.id||'等待 CLI 返回会话 ID';}
    const login = element.querySelector('.native-login'); if (login) { login.hidden = !['CODEX_LOGIN_REQUIRED','CODEX_LOGIN_CHECK_FAILED','CODEX_DESKTOP_LOGIN_REQUIRED','CODEX_DESKTOP_LOGIN_CHECK_FAILED','VENDOR_LOGIN_REQUIRED'].includes(m.errorCode); login.textContent = m.errorCode?.startsWith('CODEX_DESKTOP_') ? '检查桌面版登录' : '登录此角色'; }
    const modelChoice = element.querySelector('.select-task-model'); if (modelChoice) modelChoice.hidden = m.errorCode !== 'CODEX_MODEL_REQUIRED';
    const diagnostic=element.querySelector('.diagnostic-copy');if(diagnostic)diagnostic.hidden=!m.diagnostics||m.status==='running';
    if(m.kind==='assistant')window.deskMessageImages.render(element.querySelector('.message-images'),m,{chatId:c.id,load:(id,messageId)=>api['message-images'](id,messageId),preview:file=>previewReplyImage(c,m,file),open:file=>openPathReference(file,c.projectId,{chatId:c.id,messageId:m.id}),copy:text=>api.copy(text),error:e=>toast(uiError(e)),layout:follow=>{if(chatId!==c.id)return false;if(follow==='before')return list.scrollHeight-list.scrollTop-list.clientHeight<100;if(follow)requestAnimationFrame(()=>{if(chatId===c.id)list.scrollTop=list.scrollHeight;});}});
    const timedOut = isWorkflowStepTimeout(c, m);
    const key = m.text + '\0' + m.status + '\0' + m.activity + '\0' + m.note + '\0' + m.errorCode + '\0' + m.warningCode + '\0' + JSON.stringify(m.contextTransfer) + '\0' + JSON.stringify(m.cliShutdown) + '\0' + timedOut;
    if (element._key !== key) {
      element._key = key;
      const body = element.querySelector('.message-bubble');
      if (m.kind === 'user') {body.replaceChildren();if(m.text){const text=document.createElement('div');text.className='user-message-text';text.textContent=m.text;body.append(text);}if(m.attachments?.length){const files=document.createElement('div');files.className='message-attachments';attachmentCards(files,m.attachments,{projectId:c.projectId});body.append(files);}}
      else if (m.text) window.relayMarkdown.render(body, m.text, { copy: text => api.copy(text), openLink: value => api.open(value, c.projectId), openPath: value => openPathReference(value, c.projectId, {chatId:c.id,messageId:m.id}), inspectPath: value => openPathReference(value, c.projectId, {chatId:c.id,messageId:m.id,inspect:true}), error: e => toast(uiError(e)) });
      else body.textContent = m.errorCode === 'WORKBUDDY_DESKTOP_AUTH_UNAVAILABLE' ? '尚未接通 WorkBuddy 桌面账号，本次未收到回复。' : m.errorCode === 'CODEX_MODEL_REQUIRED' ? '请先选择本对话使用的模型。' : m.errorCode === 'CODEX_DESKTOP_LOGIN_REQUIRED' ? '请先在桌面版 Codex 中登录，再重新发送。' : m.errorCode === 'CODEX_LOGIN_REQUIRED' ? '需要登录此角色后才能开始任务。' : m.status === 'running' ? '正在思考…' : '没有收到回复内容。';
      const statusLabels={running:m.geminiWeb?'待录入回复':'生成中',complete:'',failed:'失败',interrupted:'已中断',cancelled:'已暂停',submitting:'等待 CLI 接收',unconfirmed:'提交未确认'};
      element.querySelector('.message-state').textContent = m.status==='running'
        ? (backgroundActivityLabels[m.activity] || (['Finishing agent','Closing the finished agent process'].includes(m.activity)?'正在收尾':statusLabels.running))
        : statusLabels[m.status] || '';
      const note = element.querySelector('.message-note'); note.hidden = !m.note; note.textContent = m.errorCode === 'WORKBUDDY_DESKTOP_AUTH_UNAVAILABLE' ? '桌面版已登录不代表独立子进程能获得加密凭据。当前桌面账号兼容接入仍未完成；不会自动改用 API Key 或另一种计费方式。原提问已保留，无需重复输入。' : m.errorCode === 'CODEX_MODEL_REQUIRED' ? '对话模型留空时会跟随角色默认。两处均未设置，请点击“选择本对话模型”；复用登录不会自动采用桌面版的默认模型，原提问已保留。' : m.errorCode?.startsWith('CODEX_DESKTOP_LOGIN_') ? '此角色复用桌面版 Codex 的登录。请在桌面版完成登录后重试；无需在这里重复授权，原提问已保留。' : m.errorCode === 'CODEX_LOGIN_REQUIRED' ? '此角色尚未登录 Codex。点击“登录此角色”完成授权后，再发送消息。也可在角色设置中选择复用桌面版登录；原提问已保留在聊天记录中。' : m.errorCode === 'CODEX_LOGIN_CHECK_FAILED' ? '无法确认此角色的 Codex 登录状态。请点击“登录此角色”重新授权；原提问已保留在聊天记录中。' : m.note ? uiError(m.note) : '';
      if(m.warningCode==='CLAUDE_PERMISSION_DENIED'||m.note==='Some tools require approval. Use the project terminal or classic interface to approve them.')note.textContent=m.permission==='danger-full-access'?'本次已使用 Claude 完全权限，仍有工具被拒绝。请检查 Claude 管理策略、工具自身限制或 MCP 服务授权；容器和 Linux 用户权限不会自动提升。':'本次有工具需要审批。可在角色 → 连接配置 → Agent 运行权限中选择完全权限，保存后重新发送任务。已结束的请求无法在另一个终端补批；原提问和回复已保留。';
      if(m.note==='CLI submission was not confirmed. Restore this message to retry.')note.textContent='连接结束前尚未确认 CLI 收到消息。文字和附件已保留，可点击“恢复输入”重试。';
      if(m.errorCode==='REMOTE_CHANNEL_CLOSED'){
        const flow=m.workflowRunId?c.workflowRuns?.find(run=>run.id===m.workflowRunId):c.workflow;
        const backup=flow&&flow.type!=='graph'&&m.workflowAttemptId&&m.status==='failed';
        note.hidden=false;
        note.textContent=backup?'远程 SSH 通道中断，未收到退出状态。已保留收到的回复，工作流会尝试后续候选角色。':
          '远程 SSH 通道中断，未收到退出状态；这条错误不能用于判断账号被停用。请重新连接后继续，已收到的回复和发送记录保留，任务没有自动重试。';
      }
      if(m.status==='cancelled'&&m.stopConfirmed===false){note.hidden=false;note.textContent='任务尚未确认停止。请检查任务输出和进程后再继续。';}
      if(m.errorCode==='REMOTE_AGENT_KILLED'){note.hidden=false;note.textContent='远程进程被强制终止，可能涉及资源限制或外部结束操作，需要结合服务器记录判断。已收到的回复保留，任务没有自动重试。\n'+(m.note||'');}
      if(m.errorCode==='VENDOR_PROTOCOL_TIMEOUT'){note.hidden=false;const phase=m.protocolTimeout?.method==='initialize'?'协议握手':m.protocolTimeout?.method==='session/new'?'创建会话／初始化 MCP':'会话配置';note.textContent='原生 CLI 在'+phase+'阶段等待超时'+(m.protocolTimeout?.timeoutMs?'（'+Math.ceil(m.protocolTimeout.timeoutMs/1000)+' 秒）':'')+'，尚未提交聊天任务。原提问已保留，程序不会自动重试。请检查官方 CLI 登录、角色代理和 MCP 启动情况后再试。';}
      if(m.contextTransfer?.mode==='paged'){note.hidden=false;note.textContent=[note.textContent,'历史较长：本次提问完整传入，完整历史通过只读工具按需分段读取（'+m.contextTransfer.messageCount+' 条消息）。'].filter(Boolean).join('\n');}
      if(m.contextTransfer?.mode==='moderated'){note.hidden=false;note.textContent=[note.textContent,'早期历史使用主持人摘要；最新提问和近期消息保持完整，原文可通过只读历史工具查看。'].filter(Boolean).join('\n');}
      if(m.nativeSession?.reason==='session_missing'){note.hidden=false;note.textContent=[note.textContent,'原生会话已不存在；本次在提交任务前从 App 保存的历史重新衔接，没有重跑上一轮任务。'].filter(Boolean).join('\n');}
      if(m.nativeSession?.uncertainPrevious){note.hidden=false;note.textContent=[note.textContent,'上一轮完成状态未确认；本次只提交新的指令，不自动重发上一轮任务。'].filter(Boolean).join('\n');}
      if(['NATIVE_SESSION_MISSING','NATIVE_SESSION_MISMATCH'].includes(m.errorCode)){note.hidden=false;note.textContent='原生会话已失效或 ID 不匹配，程序没有自动重跑任务。点击角色头像 → 重新建立原生会话，再恢复输入发送；App 聊天记录保留。';}
      if(m.errorCode==='CODEX_BAD_REQUEST'){note.hidden=false;note.textContent='Codex 模型请求返回 Bad Request，不能仅凭这条信息确定根因。已成功执行的命令和部分回复仍然保留；模型列表刷新超时不等于这些命令执行失败。'+(m.recovery?'已达到自动续接上限或无法继续恢复，请核对当前进度后再决定是否继续。':'本次不满足安全续接条件，请先核对当前进度再继续。');}
      if(m.errorCode==='CODEX_CAPACITY'){note.hidden=false;note.textContent='Codex 明确报告模型容量或路由暂不可用。可稍后重试，或手动选择其他模型；已有结果保留，程序不会自动换模型。';}
      if(m.warningCode==='CODEX_SHUTDOWN_WARNING'){note.hidden=false;const shutdown=m.cliShutdown;if(shutdown?.reason==='cleanup_timeout')note.textContent='回复已完成。CLI 在 '+Math.ceil(shutdown.graceMs/1000)+' 秒收尾等待内未退出，已回收该进程；这不表示回答失败，任务没有重新执行。';else if(shutdown?.reason==='nonzero_exit')note.textContent='回复已完成；随后 CLI 以非零退出码 '+shutdown.exitCode+' 结束。回答已保留，任务没有重新执行。';else if(shutdown?.reason==='signal_exit')note.textContent='回复已完成；随后 CLI 收到 '+shutdown.exitSignal+' 信号而结束。回答已保留，任务没有重新执行。';else if(shutdown)note.textContent='回复已完成；CLI 已结束，但退出状态不足以判断原因。回答已保留，任务没有重新执行。';else note.textContent='回复已完成，CLI 已回收，任务没有重新执行。旧记录未区分超时回收与异常退出，不能仅凭此提示判断 CLI 崩溃。';}
      if(m.errorCode==='CLI_SHUTDOWN_STALLED'){note.hidden=false;note.textContent='模型已发出结束事件，但 CLI 进程未能正常关闭。已有回复保留，程序没有自动重跑任务，请检查本次进程状态。';}
      if (timedOut) {
        element.querySelector('.message-state').textContent = '超时中断';
        note.hidden = false;
        note.textContent = workflowStepTimeoutText + (m.stopConfirmed === false ? ' 尚未确认相关进程已停止。' : '');
      }
    }
    if(m.recovery){let recovery=element.querySelector('.message-recovery');if(!recovery){recovery=document.createElement('p');recovery.className='message-recovery hint';element.querySelector('.message-content').append(recovery);}const labels={waiting:'等待自动续接',resuming:'正在恢复同一个 session',recovered:'自动续接成功',stopped:'自动续接已停止',cancelled:'自动续接已取消'};recovery.textContent=(labels[m.recovery.state]||'自动续接')+' · '+m.recovery.attempt+'/'+m.recovery.maxRetries+' 次'+(m.recovery.transport==='uncompressed'?' · 已关闭本次请求压缩':'')+'；保留已有操作记录，不重新提交原始任务。';}
  }
  let child = list.firstElementChild;
  for (const message of messages) {
    const current = $('msg-' + message.id);
    if (current !== child) list.insertBefore(current, child);
    child = current.nextElementSibling;
  }
  const busy = state.running[c.id], forceStop = state.forceStops?.[c.id];
  const workflowRun=c.workflowRuns?.find(run=>run.id===busy?.workflowRunId||run.status==='queued');
  const terminalBusy=agentTerminals.some(t=>t.chatId===c.id&&t.state==='ready'&&['running','waiting'].includes(t.taskState));
  $('chat-banner').hidden = !busy&&!terminalBusy&&!forceStop&&!workflowRun;
  const forceButton=forceStop?`<button type="button" id="force-stop" ${forceStop.stopping?'disabled':''}>强制结束</button>`:'';
  if (workflowRun) {
    const stage=workflowRun.status==='queued'?'排队中':busy?.stopping?'正在停止…':'运行中';
    $('chat-banner').innerHTML=`<span>工作流 · ${esc(workflowRun.title)} · ${stage}</span>
      <button type="button" id="view-running-workflow">查看画板</button>
      <button type="button" id="stop-running-workflow" ${busy?.stopping?'disabled':''}>停止</button>${forceButton}`;
    $('view-running-workflow').onclick=()=>action(()=>openTools('workflow',workflowRun.definitionId));
    $('stop-running-workflow').onclick=()=>action(()=>invokeWorkflow('group-stop',c.id,workflowRun.id));
  } else if (busy) {
    const current=messages.findLast(m=>m.kind==='assistant'&&m.roleId===busy.roleId&&m.status==='running');
    const finishing=['Finishing agent','Closing the finished agent process'].includes(current?.activity);
    const waiting=busy.phase==='web-reply'&&!busy.stopping;
    const activity=forceStop?.stopping?'正在强制结束…':busy.stopping?'正在结束…':busy.phase==='workflow-route'?'正在选择下一位角色…':busy.phase==='compact'?'主持人正在压缩历史…':busy.phase==='review'?'主持人正在判断是否继续…':waiting?'待录入回复':finishing?'已完成，正在收尾…':backgroundActivityLabels[current?.activity]||'正在发言';
    const indicator=waiting?'':'<img class="spinner" src="icons/refresh.svg" alt="">';
    const progress=c.workflow?.nodes?`步骤 ${busy.round} / ${busy.rounds}`:`第 ${busy.round} 轮 / 上限 ${busy.rounds} 轮`;
    $('chat-banner').innerHTML=`${indicator}${progress} · ${esc(role(busy.roleId)?.name)} ${activity}${forceButton}`;
  } else if (terminalBusy || forceStop) {
    const activity=forceStop?.stopping?'正在强制结束…':forceStop?.unconfirmed?'后台任务尚未确认结束，可重试强制结束。':terminalBusy?'交互终端正在运行':'正在连接交互终端…';
    $('chat-banner').innerHTML=`${activity}${forceButton}`;
  } else $('chat-banner').replaceChildren();
  if (forceStop) $('force-stop').onclick=()=>{
    const prompt=forceStop.terminal?'强制结束当前交互终端？':'强制结束当前任务？';
    if(confirm(prompt+'运行中的操作会立即中断，已收到的回复和待发消息会保留。'))action(()=>api['force-stop'](c.id,forceStop.id));
  };
  renderWorkflowStatus(c);
  renderDiscussion();
  $('reply-flow').disabled = false; $('group-order').disabled = false;
  renderSpeakingOrder();
  if (!$('tools-panel').hidden) {
    if (toolMode === 'activity') renderActivity();
    if (toolMode === 'workflow') renderGroupWorkflows();
  }
  const inputBusy=Boolean(state.inputBusy?.[c.id]||busy),queued=Boolean(c.inputQueue?.length);
  $('end-task').hidden = Boolean(workflowRun)||!busy&&!terminalBusy; $('end-task').disabled=Boolean(busy?.stopping||forceStop?.stopping);
  renderScheduleSelection(c);
  $('interrupt-send').hidden=Boolean(workflowRun)||!inputBusy&&!queued;if($('chat-summary'))$('chat-summary').disabled=Boolean(inputBusy||queued);
  renderInputQueue(c);
  if (shouldScroll) requestAnimationFrame(() => {
    if (historyView !== view || view?.newer) return;
    list.scrollTop = list.scrollHeight; autoBottom = false; markReadAtBottom();
  });
}
function renderMessageTools(tools, id, message) {
  tools.hidden = !message.activityCount;
  async function load() {
    if (!tools.open || tools.hidden || tools._message === message) return;
    tools._message = message;
    try {
      const items = await api['message-details'](id, message.id, 'activities');
      if (tools._message !== message || !tools.isConnected) return;
      tools.querySelector('ul').innerHTML = items.map(item => `<li><span>${esc(({ running:'运行中', failed:'失败', interrupted:'中断', complete:'完成' })[item.status] || item.status)}</span>${esc(item.title)}</li>`).join('');
    } catch {
      if (tools._message !== message) return;
      tools._message = undefined;
      tools.querySelector('ul').innerHTML = '<li>无法读取工具活动，关闭后重新展开可重试。</li>';
    }
  }
  tools.ontoggle = load;
  void load();
}
function renderGeminiWebTurn(element, chat, message) {
  element.querySelector('.task-output').hidden = true;
  let controls = element.querySelector('.gemini-web-turn');
  if (!controls && message.status === 'running') {
    controls = document.createElement('section');
    controls.className = 'gemini-web-turn setting-card';
    controls.innerHTML = '<p>打开后粘贴提示词并发送，复制网页回复后返回。</p><div class="tool-actions"><button type="button" data-gemini-open>复制提示词并打开 Gemini</button><button type="button" data-gemini-reply>从剪贴板录入</button><button type="button" class="quiet" data-gemini-link>绑定对话</button></div>';
    element.querySelector('.message-content').prepend(controls);
    const open=controls.querySelector('[data-gemini-open]');
    open.onclick = () => action(async () => {
      open.disabled=true;
      try{await api['gemini-web-open-turn'](chat.id,message.id);}
      finally{open.disabled=false;}
    });
    controls.querySelector('[data-gemini-link]').onclick = () => openChatRole(message.roleId);
    controls.querySelector('[data-gemini-reply]').onclick = () => {
      dialog('<h2>录入 Gemini 回复</h2><label>网页回复<textarea id="gemini-web-reply" rows="9" maxlength="150000" required></textarea></label>', async () => {
        await api['gemini-web-reply'](chat.id, message.id, $('gemini-web-reply').value);
      }, '录入回复');
      const input=$('gemini-web-reply');
      input.focus();
      action(async()=>{
        const reply=await api['gemini-web-clipboard-reply'](chat.id,message.id);
        if(input.isConnected&&$('dialog').open&&!input.value)input.value=reply;
      });
    };
  }
  if (controls) controls.hidden = message.status !== 'running';
  if (controls) controls.querySelector('[data-gemini-link]').hidden = !chat.roleIds.includes(message.roleId) || role(message.roleId)?.engine !== geminiWebEngine;
}
function renderInputQueue(c){
  const panel=$('input-queue'),entries=c.inputQueue||[];panel.hidden=!entries.length;
  const key=JSON.stringify([c.id,entries.map(entry=>[entry.id,entry.state]),state.roles.map(role=>[role.id,role.name,role.enabled]),c.queuePaused,c.queueReason,c.queueError]);if(panel._key===key)return;panel._key=key;
  $('queue-title').textContent='待发送 '+entries.length+' 条'+(c.queuePaused?' · 已暂停':'');
  const reasons={restart:'App 已重开，确认后继续发送。',manual:'已手动暂停队列。',failed:'当前任务失败，后续消息已保留。',needs_user:'当前任务需要你的信息或决定。',unconfirmed:'讨论结束状态未确认，请检查回复后继续。',moderator_failed:'主持人调用失败，请检查后继续。',moderator_budget:'主持人已达到调用上限，请检查后继续。',paused:'当前任务已结束，待发消息已保留。',blocked:'消息暂未发送，请处理问题后继续。',interrupt_timeout:'尚未确认任务已停止，队列已暂停。请检查任务输出后继续。',stop_unconfirmed:'任务尚未确认停止。请检查任务输出和进程后再继续队列。',terminal_ended:'交互终端已结束，请检查后继续。'};
  $('queue-note').textContent=c.queuePaused?(reasons[c.queueReason]||'队列已暂停，请检查后继续。')+(c.queueError?' '+attachmentError(c.queueError):''):'当前任务完整结束后，按顺序发送；失败或需要确认时自动暂停。';
  $('queue-resume').hidden=!c.queuePaused;$('queue-pause').hidden=Boolean(c.queuePaused);
  const list=$('queue-items');list.replaceChildren();
  for(const [index,entry]of entries.entries()){
    const row=document.createElement('article');row.className='queued-input';row.dataset.queueId=entry.id;
    const info=document.createElement('div');info.className='queued-input-content';
    const blocked = entry.value.roleIds.some(id => role(id)?.enabled === false);
    const label=document.createElement('small');label.textContent=(index+1)+'. '+entry.value.roleIds.map(id=>role(id)?.name||'已移除角色').join(' → ')+(entry.state==='dispatching'?' · 正在提交…':blocked?' · 含已禁用角色':'');label.title=entry.value.roleIds.map(id=>(role(id)?.name||id)+' · '+(entry.value.roleSettings?.[id]?.model||'默认模型')).join('\n');
    const preview=document.createElement('p');preview.textContent=entry.value.text||'仅附件消息';preview.title=entry.value.text.slice(0,1000);
    info.append(label,preview);if(entry.value.files?.length){const files=document.createElement('small');files.textContent='附件：'+entry.value.files.map(file=>file.name).join('、');info.append(files);}
    const controls=document.createElement('div');controls.className='queued-input-actions';
    const add=(label,title,run,disabled=false)=>{const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=label;button.title=title;button.setAttribute('aria-label',title);button.disabled=disabled||entry.state==='dispatching';button.onclick=()=>action(run);controls.append(button);};
    add('↑','上移',()=>api['queue-move'](c.id,entry.id,-1),index===0);add('↓','下移',()=>api['queue-move'](c.id,entry.id,1),index===entries.length-1);
    add('插队',blocked?'请先启用角色，或编辑待发消息改选角色':'停止当前轮后优先发送；不会自动重做被中断的任务',()=>api['queue-now'](c.id,entry.id),blocked);
    add('编辑','移回空输入框后修改',async()=>{if(chatId===c.id)saveDraftNow();const draft=await api['queue-restore'](c.id,entry.id),current=state.chats.find(chat=>chat.id===c.id);if(current){current.draft=draft.text;current.draftAttachments=draft.attachments;}if(chatId===c.id){$('input').value=draft.text;renderAttachments();quickSettings();renderSpeakingOrder();$('input').focus();}});
    add('×','移除这条排队消息',()=>api['queue-remove'](c.id,entry.id));row.append(info,controls);list.append(row);
  }
}
function renderModeratorMessage(list,c,m){
  let element=document.getElementById('msg-'+m.id);if(!element){element=document.createElement('article');element.id='msg-'+m.id;element.className='moderator-message';element.innerHTML='<details><summary></summary><p class="moderator-note"></p><details class="moderator-memory" hidden><summary>查看上下文摘要</summary><pre></pre><button type="button" class="quiet copy-moderator-summary">复制摘要</button></details><button type="button" class="quiet task-output">查看主持人任务输出</button></details>';list.append(element);element.querySelector('.task-output').onclick=()=>{activityMode='log';activityRoleId=m.roleId;activityRunId=m.id;activityFollow=false;action(()=>openTools('activity'));};element.querySelector('.copy-moderator-summary').onclick=()=>{const current=visibleMessage(c.id,m.id);return action(()=>api.copy(current?.moderatorResult?.summary||''));};}
  const key=JSON.stringify([m.status,m.note,m.moderatorResult,m.moderatorDiagnostic,m.moderatorFallback]);if(element._key===key)return;element._key=key;
  const result=m.moderatorResult,stage=m.moderatorTask==='compact'?'压缩历史':m.moderatorTask==='workflow-route'?'选择工作流角色':'判断讨论';const decision={complete:'讨论已完成',continue:'继续讨论',needs_user:'需要你的信息或决定'};
  const completed=result?.kind==='compact'?'已压缩 '+result.messageCount+' 条早期消息':result?.kind==='workflow-route'?'已选择 '+(result.roleName||role(result.roleId)?.name||result.roleId):decision[result?.decision]||stage+'：正在核对结果';
  element.querySelector('details>summary').textContent='主持人 · '+m.roleName+' · '+(m.status==='running'?stage+'中…':m.status==='complete'?completed:m.status==='cancelled'?stage+'已暂停':m.moderatorFallback?'压缩历史未完成，已回退原文':stage+'未完成');
  const errors={'The moderator did not return valid coordination JSON.':'返回内容未能解析为主持人控制 JSON。','The moderator response does not match this task.':'返回内容与本次主持人任务不匹配。','The moderator did not read the complete history input.':'主持人未完整读取待压缩的历史。','Moderator response exceeds the metadata limit.':'主持人返回内容超过长度上限。','The moderator context summary is missing or too large.':'历史摘要为空或超过长度上限。','The moderator decision is invalid.':'主持人的讨论结束判断格式无效。'};
  const diagnostic=m.moderatorDiagnostic,details=m.moderatorTask==='compact'&&diagnostic?.triggerBytes?'历史 '+(diagnostic.triggerBytes/1024).toFixed(1)+' KiB，达到 '+(diagnostic.thresholdBytes/1024).toFixed(0)+' KiB 压缩阈值；处理 '+diagnostic.sourceMessages+' 条早期消息，最近 '+diagnostic.retainedMessages+' 条保持原样。':'';
  const note=m.note&&(errors[m.note]||workflowMessages.get(m.note)||(m.moderatorTask==='workflow-route'?'主持人选人未完成，原始诊断请查看任务输出。':m.note));
  element.querySelector('.moderator-note').textContent=[m.moderatorFallback?'本次未采用新摘要，已保留原始历史并继续角色回复。':'',note||(result?.kind==='compact'?'原始记录保留，最新提问和近期消息未压缩。':result?.reason||''),details].filter(Boolean).join('\n');
  const memory=element.querySelector('.moderator-memory');memory.hidden=!result?.summary;memory.querySelector('pre').textContent=result?.summary||'';
}
function markReadAtBottom() { const c = chat(); if (page === 'projects' && c?.unread && historyView?.id === c.id && historyView.revision !== undefined && !historyView.newer && !$('dialog').open && $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 50 && document.hasFocus()) { c.unread = false; api.read(c.id).catch(() => {}); renderList(); renderProjectNotifications(); } }
let chatSearchTimer;
const currentChatSearch = { channel: 'chat-search', version: 0, offset: 0 };
const otherChatsSearch = { channel: 'other-chats-search', version: 0, offset: 0 };
const searchControl = (view, name) => $(view.channel + '-' + name);
function resetChatSearchResults(view) {
  view.version++;
  view.offset = 0;
  searchControl(view, 'results').replaceChildren();
  searchControl(view, 'status').textContent = '';
  for (const name of ['prev', 'next']) {
    const button = searchControl(view, name);
    button.hidden = true;
    button.disabled = false;
  }
}
function setOtherChatsSearchOpen(open) {
  $('other-chats-search').hidden = !open;
  const toggle = $('other-chats-search-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? '收起其他会话和项目的结果' : '搜索其他会话和项目';
  if (!open) resetChatSearchResults(otherChatsSearch);
}
function closeChatSearch() {
  clearTimeout(chatSearchTimer);
  $('chat-search').hidden = true;
  $('chat-find').setAttribute('aria-expanded', 'false');
  $('chat-search-input').value = '';
  resetChatSearchResults(currentChatSearch);
  setOtherChatsSearchOpen(false);
  $('other-chats-search-toggle').hidden = true;
  document.querySelector('.message-search-match')?.classList.remove('message-search-match');
}
function openChatSearch() {
  if (page !== 'projects' || !chat()) return;
  $('chat-search').hidden = false;
  $('chat-find').setAttribute('aria-expanded', 'true');
  $('chat-search-input').focus();
  $('chat-search-input').select();
}
function openSearchMatch(match) {
  if (!match.chatId) {
    document.querySelector('.message-search-match')?.classList.remove('message-search-match');
    return loadMessagePage({ around: match.id }, { navigate: true, target: match.id });
  }
  const destination = state.chats.find(item => item.id === match.chatId && item.projectId === match.projectId);
  if (!destination || !state.projects.some(item => item.id === destination.projectId)) {
    throw new Error('找不到该对话，可能已被删除。');
  }
  saveDraftNow();
  projectId = destination.projectId;
  chatId = destination.id;
  filter = 'all';
  query = '';
  renderSidebar();
  activateChat({ targetMessageId: match.id });
  refreshTerminalTabs();
  $('chat-find').focus();
}
async function runChatSearch(view, offset) {
  const c = chat();
  const text = $('chat-search-input').value.trim();
  if (!c || !text) return;
  const version = ++view.version;
  const isCurrent = () => version === view.version && chat()?.id === c.id;
  const status = searchControl(view, 'status');
  const prev = searchControl(view, 'prev');
  const next = searchControl(view, 'next');
  status.textContent = '正在搜索…';
  prev.disabled = next.disabled = true;
  let response;
  try {
    response = await api[view.channel](c.id, text, offset);
  } catch {
    if (isCurrent()) status.textContent = '搜索失败，请重试。';
    return;
  } finally {
    if (isCurrent()) {
      prev.disabled = next.disabled = false;
      if (view === currentChatSearch) $('other-chats-search-toggle').hidden = false;
    }
  }
  if (!isCurrent()) return;
  const { matches, total } = response;
  view.offset = offset;
  const results = searchControl(view, 'results');
  results.replaceChildren();
  for (const match of matches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-search-result';
    const context = document.createElement('span');
    context.className = 'chat-search-context';
    if (match.chatId) {
      const resultChat = state.chats.find(item => item.id === match.chatId);
      const resultProject = state.projects.find(item => item.id === match.projectId);
      const source = document.createElement('small');
      source.textContent = `${resultProject?.name || '项目'} / ${resultChat?.name || '对话'}`;
      source.title = source.textContent;
      context.append(source);
    }
    const author = document.createElement('b');
    author.textContent = match.roleName || ({user:'我', system:'系统', skill:'技能'}[match.kind] || '角色');
    const excerpt = document.createElement('span');
    excerpt.textContent = match.excerpt;
    context.append(author, excerpt);
    button.append(context);
    button.onclick = () => action(() => openSearchMatch(match));
    results.append(button);
  }
  results.scrollTop = 0;
  status.textContent = matches.length ? `第 ${offset + 1}–${offset + matches.length} 条，共 ${total} 条匹配` :
    view === currentChatSearch ? '当前对话没有匹配的消息。' : '其他会话和项目没有匹配的消息。';
  prev.hidden = offset === 0;
  next.hidden = offset + matches.length >= total;
}
$('chat-find').onclick = openChatSearch;
$('chat-search-close').onclick = () => { closeChatSearch(); $('chat-find').focus(); };
$('chat-search-input').oninput = () => {
  clearTimeout(chatSearchTimer);
  resetChatSearchResults(currentChatSearch);
  setOtherChatsSearchOpen(false);
  $('other-chats-search-toggle').hidden = true;
  if ($('chat-search-input').value.trim()) {
    $('chat-search-status').textContent = '正在搜索…';
    chatSearchTimer = setTimeout(() => runChatSearch(currentChatSearch, 0), 180);
  }
};
$('other-chats-search-toggle').onclick = () => {
  const open = $('other-chats-search').hidden;
  setOtherChatsSearchOpen(open);
  if (open) runChatSearch(otherChatsSearch, 0);
};
for (const view of [currentChatSearch, otherChatsSearch]) {
  searchControl(view, 'prev').onclick = () => runChatSearch(view, Math.max(0, view.offset - 30));
  searchControl(view, 'next').onclick = () => runChatSearch(view, view.offset + 30);
}
$('history-older').onclick = () => action(() => loadMessagePage({ before: historyView.messages[0]?.id }, { navigate: true }));
$('history-newer').onclick = () => action(() => loadMessagePage({ after: historyView.messages.at(-1)?.id }, { navigate: true }));
$('history-latest').onclick = () => action(() => loadMessagePage(undefined, { navigate: true }));
document.addEventListener('keydown', event => {
  if (page !== 'projects' || !state || !chat() || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openChatSearch();
  } else if (event.key === 'Escape' && !$('chat-search').hidden && $('chat-search').contains(document.activeElement)) {
    event.preventDefault();
    closeChatSearch();
    $('chat-find').focus();
  }
});
function quickRole() {
  const ids = composerRecipients().roleIds;
  return ids.length === 1 && chat()?.roleIds.includes(ids[0]) ? chatRole(ids[0]) : undefined;
}
function renderEfforts(select, offering, selected, {inherit=false, promote=false}={}) {
  const levels=offering?.efforts || fallbackEfforts;
  const defaultLabel='模型默认'+(offering?.defaultEffort?'（'+offering.defaultEffort+'）':'');
  const choices=inherit?[['','跟随角色'],[modelDefault,defaultLabel]]:[['',defaultLabel]];
  choices.push(...levels.map(level=>[level,effortLabels[level]&&level!== 'ultra'?`${effortLabels[level]} (${level})`:level]));
  let next=selected;
  if(selected && selected!==modelDefault && !levels.includes(selected)){
    if(promote && offering?.efforts)next=inherit?modelDefault:'';
    else choices.push([selected,offering?.efforts?`${selected}（此模型不支持）`:selected]);
  }
  select.innerHTML=options(choices,next);
  select.value=next;
}
function assertEffort(offering, effort) {
  if(effort && effort!==modelDefault && offering?.efforts && !offering.efforts.includes(effort))throw new Error('此模型不支持 '+effort+'，请选择其他推理强度或使用模型默认值。');
}
function quickOffering(r) {
  return modelOffering(roleCatalogs.get(r.id)||[], $('quick-model').value.trim() || role(r.id)?.model);
}
function refreshQuickEfforts(r, promote=false) {
  const select=$('quick-effort');
  const offering=quickOffering(r), inherited=role(r.id)?.effort;
  const selection=!select.value&&promote&&inherited&&offering?.efforts&&!offering.efforts.includes(inherited)?modelDefault:select.value;
  renderEfforts(select,offering,selection,{inherit:true,promote});
}
function renderQuickCatalog(id) {
  const list=$('model-list');
  list.replaceChildren();
  for(const model of roleCatalogs.get(id)||[]){const option=document.createElement('option');option.value=model.id;list.append(option);}
}
function receiveRoleCatalog(id, models) {
  roleCatalogs.set(id,models);
  const r=quickRole();
  if(r?.id===id){renderQuickCatalog(id);refreshQuickEfforts(r);}
}
function quickSettings() {
  const r=quickRole(), ids=composerRecipients().roleIds;
  composerTargetKey=ids.join(',');
  const hidden=!r || usesExternalConversation(r.engine);
  $('quick-model').hidden=hidden||r?.engine==='zcode';$('quick-effort').hidden=hidden||!supportsEffort(r?.engine);
  const saved=chat()?.roleSettings?.[r?.id];
  $('quick-model').value=r?.model||'';
  renderQuickCatalog(r?.id);
  if(hidden)return;
  renderEfforts($('quick-effort'),quickOffering(r),saved?.effort||'',{inherit:true});
  if(!roleCatalogs.has(r.id)){
    roleCatalogs.set(r.id,[]);
    api.models(r.id,{cacheOnly:true}).then(result=>{
      if(roleCatalogs.get(r.id)?.length||!result.models?.length)return;
      receiveRoleCatalog(r.id,result.models);
    }).catch(()=>{});
  }
}
function bindChatRoleAvatars() {
  document.querySelectorAll('[data-chat-role]').forEach(button => { button.onclick = () => openChatRole(button.dataset.chatRole); });
}
function openChatRole(id) {
  const c = chat(), r = chatRole(id); if (!c || c.disbandedAt || !r || !c.roleIds.includes(id)) return;
  const selection = c.roleSettings?.[id] || {};
  const cursor = r.engine === 'cursor';
  const dutyFields = '<section class="chat-duty-section"><h3>本会话分工</h3><div id="c-role-duty"></div></section>';
  const bindDuty = () => window.deskCollaborationUI.dutyEditor($('c-role-duty'), {
    scope:'chat', role:r, parent:window.deskCollaboration.duty(r, project()), value:c.roleDuties?.[id],
  });
  const roleFields = `${dutyFields}<details id="chat-role-persona"><summary>本对话人设与发言风格</summary>
    <p class="hint">这是角色加入时复制的设定，保存后仅对此对话生效。</p>
    <label>角色设定<textarea id="chat-role-persona-text" maxlength="30000" rows="4"></textarea></label>
    <label>发言风格示例<textarea id="chat-role-examples" maxlength="30000" rows="4"></textarea></label>
    <button type="button" class="quiet" id="chat-role-copy-persona">从系统设定重新复制</button>
    </details>`;
  function bindRoleFields() {
    const readDuty = bindDuty();
    $('chat-role-persona-text').value = r.persona || '';
    $('chat-role-examples').value = r.examples || '';
    $('chat-role-copy-persona').onclick = () => {
      $('chat-role-persona-text').value = role(id)?.persona || '';
      $('chat-role-examples').value = role(id)?.examples || '';
    };
    return () => ({ persona: $('chat-role-persona-text').value, examples: $('chat-role-examples').value, roleDuty: readDuty() });
  }
  let readRole;
  if (r.engine === slackChatEngine) {
    dialog(`<h2>${esc(r.name)} · 本对话设置</h2>${dutyFields}`, async () => {
      await api['chat-role-settings'](c.id, id, {model:selection.model || '', effort:'', roleDuty:readRole()});
    });
    readRole = bindDuty();
    return;
  }
  if (r.engine === geminiWebEngine) {
    const link = c.geminiWebChats?.[id] || '';
    dialog(`<h2>${esc(r.name)} · 本对话设置</h2><label>私有对话链接<input id="gemini-web-link" type="url" value="${esc(link)}" placeholder="https://gemini.google.com/app/…"></label><p class="hint">从地址栏复制链接。留空时打开 Gemini 首页。</p><button type="button" id="gemini-web-open">打开 Gemini</button>${roleFields}`,
      async () => {
        const settings = readRole();
        if ($('gemini-web-link').value !== link) await api['gemini-web-link'](c.id, id, $('gemini-web-link').value);
        await api['chat-role-settings'](c.id, id, { model: selection.model || '', effort: '', ...settings });
      });
    readRole = bindRoleFields();
    $('gemini-web-open').onclick = () => action(() => api['gemini-web-open'](c.id, id));
    return;
  }
  const zcode = r.engine === 'zcode';
  const defaultModel = cursor ? parseCursorModel(role(id)?.model).id : role(id)?.model;
  const defaultEffort = cursor ? '' : ' · ' + esc(role(id)?.effort || '未指定强度');
  dialog(`<h2>${esc(r.name)} · 本对话设置</h2><p class="hint">${zcode ? "使用 ZCode 中选定的模型和推理设置。" : "对话模型与推理强度可留空跟随角色，保存后下次发言生效。"}</p><label ${zcode?"hidden":""}>对话模型<div id="chat-model-picker"></div></label><label ${zcode?"hidden":""}>推理强度<select id="chat-effort">${options([['','跟随角色'],['low','低'],['medium','中'],['high','高'],['xhigh','很高'],...(r.effort && !['low','medium','high','xhigh'].includes(r.effort) ? [[r.effort,r.effort]] : [])],selection.effort || '')}</select></label><p class="hint" ${zcode?"hidden":""}>角色默认：${esc(defaultModel || '未设置模型')}${defaultEffort}。${esc(engineLabel(r.engine))} · ${esc(locationOf(r.locationId)?.name)}。</p>${roleFields}<button type="button" id="chat-role-output" class="quiet">查看任务输出</button>`, async () => {
    const model=chatModelPicker.value().trim();
    const effort=cursor ? '' : $('chat-effort').value;
    assertEffort(modelOffering(roleCatalogs.get(id)||[],model||role(id)?.model),effort||role(id)?.effort);
    await api['chat-role-settings'](c.id, id, {model,effort,...readRole()});
    quickSettings(); toast('已保存本对话的角色设置');
  });
  readRole = bindRoleFields();
  const syncEfforts=(selected,promote=false)=>{
    if (cursor) return;
    const model=$('chat-model-picker').querySelector('input').value.trim()||role(id)?.model;
    const offering=modelOffering(roleCatalogs.get(id)||[],model), inherited=role(id)?.effort;
    if(!selected&&promote&&inherited&&offering?.efforts&&!offering.efforts.includes(inherited))selected=modelDefault;
    renderEfforts($('chat-effort'),offering,selected,{inherit:true,promote});
  };
  chatModelPicker = window.createModelPicker($('chat-model-picker'), { value: selection.model || '', load: force => api.models(r, { force }),
    cursor: cursor ? { active: () => true, effort: $('chat-effort'), inherit: () => role(id)?.model } : undefined,
    onCatalog:models=>{receiveRoleCatalog(id,models);syncEfforts($('chat-effort').value);} });
  const modelInput=$('chat-model-picker').querySelector('input');
  modelInput.placeholder = '留空跟随角色：' + (defaultModel || '未设置模型');
  modelInput.addEventListener('change',()=>syncEfforts($('chat-effort').value,true));
  syncEfforts(selection.effort||'');
  if(!cursor && !supportsEffort(r.engine)){$('chat-effort').disabled=true;$('chat-effort').value='';$('chat-effort').title='此 Agent 无独立推理强度参数，请选择其模型变体或使用原生设置。';}
  if (!zcode) chatModelPicker.update();
  $('chat-role-output').onclick = () => { $('dialog').close(); activityRoleId = id; activityRunId = undefined; activityFollow = true; action(() => openTools('activity')); };
  const native=c.nativeSessions?.[id];$('chat-role-output').insertAdjacentHTML('afterend','<section class="native-session-setting"><h3>原生会话</h3><p class="hint" id="chat-native-session"></p><button type="button" class="quiet" id="chat-session-reset">重新建立原生会话</button><p class="hint">重建后下次发送使用新会话，聊天记录保留。</p></section>');
  $('chat-native-session').textContent=native?.id?'会话 ID：'+native.id+(native.status==='uncertain'?' · 上一轮状态未确认':'')+(native.disableRequestCompression?' · 已为此会话关闭请求压缩（兼容恢复）':''):'尚未建立原生会话';$('chat-session-reset').disabled=!native;
  $('chat-session-reset').onclick=()=>action(async()=>{state=await api['chat-session-reset'](c.id,id);$('chat-native-session').textContent='下次发送将建立新的原生会话，聊天记录已保留。';$('chat-session-reset').disabled=true;toast('已清除本角色的原生会话绑定');});
}
function renderSpeakingOrder() {
  const ids = composerRecipients().roleIds, moderatorId = chat()?.moderatorRoleId;
  const text = ids.length ? '发言顺序：' + ids.map(id => role(id)?.name || id).join(' → ')+(chat()?.relayReplies!==false&&roleEnabled(moderatorId)?'；主持人：'+role(moderatorId).name:'') : '暂无可发言角色';
  $('speaking-order').textContent = text; $('speaking-order').title = text;
  $('reply-flow').title = chat()?.relayReplies === false ? '各角色读取用户消息和自己的历史回复。收到 AI 邀请时，也会读取邀请任务。' : '后一个角色可以读取前面的角色回复';
  renderDiscussion();
  renderSteerButton();
}
function renderDiscussion(){
  const c=chat();if(!c)return;const participants=composerRecipients().roleIds.length,relay=c.relayReplies!==false&&participants>1;
  $('round-limit-control').hidden=$('auto-stop-control').hidden=!relay;
  $('rounds').disabled=!relay;$('auto-stop').disabled=!relay;
  const moderated=relay&&roleEnabled(c.moderatorRoleId),hint=relay?'轮数仅为上限，不要求跑满。最多 '+(Number($('rounds').value)||1)*participants+' 次角色发言；'+(moderated?($('auto-stop').checked?'主持人每轮额外判断一次；':'主持人本次不进行结束判断；')+(c.moderatorCompression!==false?'每次发送最多两次长历史压缩调用。':'长历史自动压缩已关闭。'):'轮数不能精确限制 Token。'):'单聊或独立作答每位角色仅回答一次。';
  $('round-limit-control').title=hint;$('auto-stop-control').title=relay?moderated?'每轮由所选主持人判断是否结束；关闭后不额外调用主持人判断，仍保留已启用的历史压缩。':'每轮全部参与者判断结束；信号不完整时停止自动追加。取消勾选则按指定上限执行。':hint;
  const result=c.lastDiscussion,box=$('discussion-result');box.hidden=!result||Boolean(state.running[c.id])||c.roleIds.length<2;
  if(result){const labels={complete:'AI 判断讨论已收敛，提前结束',needs_user:'讨论已暂停：需要你的信息或决定',unconfirmed:'结束判定不完整，已停止自动追加',limit:'已达到轮数上限，是否继续由你决定',paused:'讨论已手动结束',failed:'角色调用失败，后续发言已停止',moderator_failed:'主持人协调未完成，已停止自动追加',moderator_budget:'主持人压缩达到本次任务上限，已暂停以控制消耗',answered:'已完成本次作答',summary:'总结已完成'};box.textContent=(labels[result.state]||'本次讨论已结束')+' · 完成 '+result.rounds+' 轮 / 上限 '+result.maxRounds+' 轮'+(result.reason?' · '+result.reason:'');box.title='结束判定由 AI 给出，可能有误；你仍可发送消息继续讨论。';}
}
function saveDiscussionSettings(){const c=chat();if(!c)return;return api['chat-discussion'](c.id,{maxRounds:Number($('rounds').value),autoStop:$('auto-stop').checked});}
function openUsage(focusRole) {
  dialog('<h2>额度中心</h2><div id="usage-center"></div>',()=>{},'关闭');
  usageCenter=window.deskUsage.create($('usage-center'),{refresh:id=>api['account-usage'](id),guide:id=>api['usage-guide'](id),api,error:e=>toast(e.message),roleIds:chat()?.roleIds||[],focusRole});
  $('dialog').classList.add('usage-center-dialog');usageCenter.render(state);
}
function openGroupOrder() {
  const c = chat(); if (!c) return; const ids = [...c.roleIds];
  dialog('<h2>默认发言顺序</h2><p class="hint">默认按此顺序发言；手动 @ 的顺序优先。下次发送生效。</p><div id="group-order-list"></div>', async () => { await api['chat-order'](c.id, ids); activateChat(); });
  function render() {
    $('group-order-list').innerHTML = ids.map((id, index) => `<div class="group-order-row">${avatar(role(id))}<span>${index + 1}. ${esc(role(id)?.name)}</span><button type="button" data-order-up="${index}" ${index === 0 ? 'disabled' : ''}>上移</button><button type="button" data-order-down="${index}" ${index === ids.length - 1 ? 'disabled' : ''}>下移</button></div>`).join('');
    for (const [key, delta] of [['orderUp',-1],['orderDown',1]]) $('group-order-list').querySelectorAll(key === 'orderUp' ? '[data-order-up]' : '[data-order-down]').forEach(button => { button.onclick = () => { const i = Number(button.dataset[key]); [ids[i],ids[i + delta]] = [ids[i + delta],ids[i]]; render(); }; });
  }
  render();
}
async function editSkill(id){
  const version=++skillEditorVersion;skillId=id;const draft=id?await api['skill-get'](id):{name:'',command:'',description:'',kind:'prompt',enabled:true,instructions:'',provider:'openai'};if(page!=='skills'||version!==skillEditorVersion)return;renderList();
  if(draft.source){
    window.deskSkills.system($('editor-view'),draft,enabled=>action(()=>api['skill-enabled'](id,enabled)));
    return;
  }
  window.deskSkills.editor($('editor-view'),draft,{error:error=>toast(uiError(error)),setEnabled:enabled=>api['skill-enabled'](id,enabled),models:(value,options)=>api['skill-models'](value,options),save:async value=>{const saved=await api['skill-save'](value);state=await api.snapshot();renderSidebar();await editSkill(saved.id);toast('技能已保存');},remove:async id=>{await api['skill-delete'](id);state=await api.snapshot();skillId=state.skills[0]?.id;renderSidebar();await editSkill(skillId);}});
}
function openSkillSources(){
  const sources=state.skillSources||[];
  const locations=state.locations.filter(location=>location.id==='local'||location.type==='ssh'&&location.os==='linux');
  dialog(`<h2>技能来源</h2><div id="skill-source-options">${sources.map(source=>{
    const places=locations.map(location=>[location.id,location.name]);
    const available=locations.some(location=>location.id===source.locationId);
    if(!available)places.unshift(['','请选择位置']);
    const imported = (state.skills || []).filter(skill => skill.source === source.id);
    const catalog = imported.length ? `<details class="skill-catalog"><summary>查看已发现的技能（${imported.length}）</summary><ul>${imported.map(skill => `<li>${esc(skill.name)} · /${esc(skill.command)}</li>`).join('')}</ul></details>` : '';
    return `<section data-skill-source="${esc(source.id)}" class="setting-card"><label class="skill-enabled"><input name="enabled" type="checkbox" value="${esc(source.id)}" ${source.enabled?'checked':''}>${esc(source.label)}${source.enabled?` · 已发现 ${source.count} 个技能`:''}</label><div class="form-grid"><label>技能所在位置<select name="location" required>${options(places,available?source.locationId:'')}</select></label><label>斜杠命令前缀<input name="prefix" value="${esc(source.prefix)}" placeholder="${esc(source.defaultPrefix)}" maxlength="16"></label></div><details ${source.directory?'open':''}><summary>自定义技能目录</summary><input name="directory" aria-label="自定义技能目录" value="${esc(source.directory)}" placeholder="留空使用默认目录" maxlength="2048"></details>${catalog}${source.error?`<p class="hint" title="${esc(source.error)}">读取失败，请检查连接和技能目录。</p>`:''}</section>`;
  }).join('')}</div>`,async()=>{
    const submit=$('dialog-submit');
    const choices=Object.fromEntries([...$('skill-source-options').querySelectorAll('[data-skill-source]')].map(row=>[row.dataset.skillSource,{
      enabled:row.querySelector('[name=enabled]').checked,
      locationId:row.querySelector('[name=location]').value,
      prefix:row.querySelector('[name=prefix]').value,
      directory:row.querySelector('[name=directory]').value
    }]));
    submit.disabled=true;
    try{
      const results=await api['skill-sources-save'](choices);
      state=await api.snapshot();
      renderList();
      if(skillId&&!state.skills.some(skill=>skill.id===skillId))await editSkill(state.skills[0]?.id);
      const errors=results.filter(source=>source.error);
      if(errors.length)toast(`技能读取失败，请检查连接和目录。\n${errors.map(source=>source.label).join('、')}`);
    }finally{submit.disabled=false;}
  },'应用并刷新');
}
async function saveQuick() {
  const r=quickRole();if(!r||usesExternalConversation(r.engine))return;
  const model=$('quick-model').value.trim(), effort=$('quick-effort').value;
  assertEffort(quickOffering(r),effort||role(r.id)?.effort);
  if(r.model!==model || (chat()?.roleSettings?.[r.id]?.effort||'')!==effort)await api['chat-role-settings'](chatId,r.id,{model,effort});
}
function scheduleFieldsMarkup() {
  return '<div class="schedule-date-time"><label>日期<input data-schedule-date type="date"></label><label>时间<input data-schedule-time type="time"></label></div>';
}
function bindScheduleFields(host, at = Date.now()+30*60000) {
  const date=host.querySelector('[data-schedule-date]'), time=host.querySelector('[data-schedule-time]');
  const chosen=new Date(at), pad=value=>String(value).padStart(2,'0');
  date.value=`${chosen.getFullYear()}-${pad(chosen.getMonth()+1)}-${pad(chosen.getDate())}`;
  time.value=`${pad(chosen.getHours())}:${pad(chosen.getMinutes())}`;
  return () => {
    const day=date.value, clock=time.value;
    const timestamp=new Date(`${day}T${clock}`).getTime();
    const chosenTime=new Date(timestamp);
    if (!day || !clock || !Number.isFinite(timestamp) || timestamp<=Date.now() ||
        `${pad(chosenTime.getHours())}:${pad(chosenTime.getMinutes())}`!==clock) throw new Error('请选择一个有效的未来日期和时间。');
    return timestamp;
  };
}
function chooseSchedule(title, at, save, label='确认时间') {
  dialog(`<h2>${title}</h2><div id="schedule-picker">${scheduleFieldsMarkup()}</div><p class="hint schedule-note">使用本机时间。应用未运行时错过的任务，将在下次打开后执行。</p>`,()=>save(read()),label);
  const read=bindScheduleFields($('schedule-picker'), at && at>Date.now() ? at : undefined);
}
function workflowScheduleOptions(container) {
  container.insertAdjacentHTML('beforeend', `<section class="workflow-start-options"><label>启动方式<select data-workflow-start-mode><option value="now">立即启动</option><option value="scheduled">定时启动</option></select></label><div data-workflow-start-time hidden>${scheduleFieldsMarkup()}<p class="hint">使用本机时间。应用未运行时错过的任务，将在下次打开后启动。</p></div></section>`);
  const mode=container.querySelector('[data-workflow-start-mode]'), details=container.querySelector('[data-workflow-start-time]');
  const read=bindScheduleFields(details);
  let immediateLabel;
  mode.onchange=()=>{
    details.hidden=mode.value==='now';
    const submit=$('dialog-submit');
    if (details.hidden) { if(immediateLabel)submit.textContent=immediateLabel; }
    else { immediateLabel=submit.textContent;submit.textContent='安排定时启动'; }
  };
  return ()=>mode.value==='scheduled' ? read() : undefined;
}
function closeSendOptions() {
  $('send-options-menu').hidden=true;
  $('send-options').setAttribute('aria-expanded','false');
}
function openDraftSchedule() {
  const c=chat();if(!c||c.workflow||c.disbandedAt)return;
  closeSendOptions();
  chooseSchedule('定时发送',draftSchedules.get(c.id),at=>{draftSchedules.set(c.id,at);if(chatId===c.id)renderScheduleSelection(chat());});
  $('dialog').addEventListener('close',()=>{if(chatId===c.id&&!$('dialog').open)$('input').focus();},{once:true});
}
function renderScheduleSelection(c) {
  const at=!c?.disbandedAt && !c?.workflow && draftSchedules.get(c?.id);
  $('draft-schedule').hidden=!at;
  if(at)$('draft-schedule-time').textContent=scheduleDateFormat.format(at);
  const queued=Boolean(c && (state.inputBusy?.[c.id]||state.running[c.id]||c.inputQueue?.length));
  $('send').hidden=false;
  $('send').innerHTML=icon(!at&&queued?'plus':'send')+(at?'定时发送':queued?'加入队列':'发送');
}
function renderScheduledTasks(c) {
  const panel=$('scheduled-tasks'), tasks=c?.disbandedAt?[]:c?.scheduledTasks||[];
  panel.hidden=!tasks.length;
  const key=JSON.stringify([c?.id,tasks]);if(panel._key===key)return;panel._key=key;
  $('scheduled-tasks-title').textContent=`定时任务（${tasks.length}）`;
  const list=$('scheduled-tasks-list');list.replaceChildren();
  for(const task of [...tasks].sort((a,b)=>a.at-b.at)) {
    const row=document.createElement('article');row.className='queued-input';row.dataset.scheduleId=task.id;
    const detail=document.createElement('div');detail.className='queued-input-content';
    const title=document.createElement('p');title.textContent=task.title||(task.kind==='message'?'仅附件消息':'工作流');
    const status=document.createElement('small');status.textContent=`${task.kind==='message'?'定时发送':'定时启动'} · ${scheduleDateFormat.format(task.at)}${task.error?' · 待处理':''}`;
    detail.append(status,title);
    if(task.files?.length){const files=document.createElement('small');files.textContent=`附件 · ${task.files.join('、')}`;detail.append(files);}
    if(task.error){const reason=document.createElement('p');reason.className='message-note';reason.textContent=workflowMessages.get(task.error)||attachmentError(task.error);detail.append(reason);}
    const controls=document.createElement('div');controls.className='queued-input-actions';
    const edit=document.createElement('button'), cancel=document.createElement('button');
    edit.type=cancel.type='button';edit.className=cancel.className='quiet';edit.textContent='改时间';cancel.textContent='取消';
    edit.onclick=()=>chooseSchedule('修改定时任务',task.at,at=>api['schedule-edit'](c.id,task.id,at));
    cancel.onclick=()=>{if(confirm(task.kind==='message'?'取消定时发送并移除这条待发消息？':'取消这个工作流的定时启动？'))action(()=>api['schedule-edit'](c.id,task.id,null));};
    controls.append(edit,cancel);row.append(detail,controls);list.append(row);
  }
}
async function send(summary = false, mode = 'queue') {
  const c = chat(); if (!c || c.disbandedAt) return; const draft = $('input').value; const recipients = composerRecipients(); const text = summary ? '请总结当前讨论中的共识、分歧、待确认问题和下一步行动。' : draft;
  if (!summary && recipients.blockedGuestIds?.length) {
    toast('项目设置已关闭点名未入群的角色。请修改 @ 对象，或在项目设置中重新开启。');
    return;
  }
  if (!summary && recipients.disabledRoleIds?.length) {
    toast('角色「'+recipients.disabledRoleIds.map(id=>role(id)?.name).join('、')+'」已禁用，请修改 @ 对象或重新启用。');
    return;
  }
  const targets = summary ? c.roleIds.filter(roleEnabled).slice(0, 1) : recipients.roleIds;
  if (!targets.length) { toast('此对话没有已启用的角色，请先启用或邀请一位角色。'); return; }
  if(sendingChats.has(c.id))return;if(attachmentTasks.get(c.id)){toast('正在添加附件，请稍候再发送');return;}
  const files=summary?[]:[...(c.draftAttachments||[])];
  if ((!text.trim()&&!files.length)||(!summary&&!recipients.content&&!files.length)) return; saveDraftNow();
  sendingChats.add(c.id);renderAttachments();
  const maxRounds=summary?1:Number($('rounds').value),autoStop=$('auto-stop').checked;
  const selectedAt=!summary&&draftSchedules.get(c.id), at=mode==='queue'&&selectedAt;
  try {
    if(mode!=='steer')await saveQuick();
    const value={chatId:c.id,text,attachmentIds:files.map(file=>file.id),roleIds:targets,rounds:maxRounds,autoStop,summary,mode};
    const result=at?await api['schedule-message'](value,at):await api.send(value);
    if(result.accepted&&!summary){
      if(selectedAt&&draftSchedules.get(c.id)===selectedAt)draftSchedules.delete(c.id);
      if(at)toast('已安排定时发送');
      const current=state.chats.find(item=>item.id===c.id);
      if(current){const ids=new Set(files.map(file=>file.id));current.draftAttachments=(current.draftAttachments||[]).filter(file=>!ids.has(file.id));}
      if(chatId===c.id){
        renderScheduleSelection(current);
        if($('input').value===draft){$('input').value='';if(current)current.draft='';mentions.close();quickSettings();}
      }
    }
  }
  catch (e) { toast(attachmentError(e)); }
  finally { sendingChats.delete(c.id);renderAttachments(); }
}
function dialog(html, submit, label = '保存') {
  usageCenter?.destroy();usageCenter=undefined;chatModelPicker?.destroy();chatModelPicker=undefined;
  dialogSubmit = submit;
  const modal = $('dialog');
  modal.classList.remove('role-selection-dialog','usage-center-dialog','native-quota-open','graph-workflow-dialog','project-settings-dialog');
  const body = $('dialog-body');
  body.innerHTML = html;
  const heading = body.querySelector('h2');
  $('dialog-title').textContent = heading?.textContent || '设置';
  heading?.remove();
  const button = $('dialog-submit');
  button.textContent = label;
  button.disabled = false;
  const headerSave = label.startsWith('保存');
  if (headerSave) $('dialog-close').before(button);
  else $('dialog-form').querySelector('.dialog-actions').append(button);
  modal.showModal();
  if (headerSave) modal.scrollTop = 0;
}
function previewReplyImage(chat, message, file) {
  return window.deskMessageImages.showPreview(file, {
    load: reference => api['message-image-original'](chat.id, message.id, reference),
    open: reference => openPathReference(reference, chat.projectId, {chatId:chat.id,messageId:message.id}),
  });
}
async function openPathReference(filename, targetProjectId, context) {
  const result = await api.open(filename, targetProjectId, context);
  if (!result?.candidates || targetProjectId !== projectId) return;
  const { candidates, incomplete, remoteDirectory, hasLocalDirectories } = result;
  let selected = candidates.length === 1 ? candidates[0] : undefined;
  const openSelected = async reveal => {
    const result = await api.open(selected.path, targetProjectId, { reveal });
    if (result?.candidates) throw new Error('这个路径已无法访问，请重新点击原链接查找。');
  };
  const notice = incomplete ? '搜索达到范围限制或部分目录无法读取，结果可能不完整。'
    : candidates.length ? '' : remoteDirectory !== undefined ? '本机未找到此路径，可以前往项目文件查看远端目录。'
    : hasLocalDirectories ? '在本机项目目录中未找到此路径。' : '找不到此路径，请检查绝对路径或先添加本机项目目录。';
  dialog(
    `<h2>${candidates.length ? '选择文件路径' : '找不到文件路径'}</h2>
    <code class="path-reference-name">${esc(filename)}</code>
    ${notice ? `<p class="hint">${notice}</p>` : ''}
    ${candidates.length > 1 ? '<input id="path-reference-filter" type="search" aria-label="筛选路径" placeholder="筛选路径…">' : ''}
    <div id="path-reference-results" aria-label="候选路径" role="group"></div>
    <div class="tool-actions"><button type="button" id="path-reference-copy" class="quiet">复制路径</button>
    ${candidates.length ? '<button type="button" id="path-reference-reveal" class="quiet">在资源管理器中查看</button>' : ''}
    ${remoteDirectory !== undefined ? '<button type="button" id="path-reference-remote" class="quiet">查看远端项目文件</button>' : ''}</div>`,
    async () => {
      if (!candidates.length) return;
      if (!selected) return false;
      await openSelected(false);
    }, candidates.length ? '打开' : '关闭');
  const filter = $('path-reference-filter'), results = $('path-reference-results');
  const copy = $('path-reference-copy'), reveal = $('path-reference-reveal');
  function updateButtons() {
    if (!candidates.length) return;
    $('dialog-submit').disabled = copy.disabled = reveal.disabled = !selected;
  }
  function renderCandidates() {
    const query = filter?.value.trim().toLowerCase() || '';
    const visible = candidates.filter(item => item.path.toLowerCase().includes(query));
    if (!visible.includes(selected)) selected = undefined;
    results.replaceChildren();
    for (const item of visible) {
      const row = document.createElement('label');
      row.className = 'path-reference-candidate';
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'path-reference'; input.checked = item === selected;
      input.onchange = () => { selected = item; updateButtons(); };
      const label = document.createElement('span');
      label.textContent = item.relative || item.path;
      if (item.relative) {
        const folder = document.createElement('small');
        folder.className = 'hint'; folder.textContent = item.path;
        label.append(folder);
      }
      row.append(input, label); results.append(row);
    }
    if (candidates.length && !visible.length) results.textContent = '没有匹配的路径。';
    updateButtons();
  }
  if (filter) filter.oninput = renderCandidates;
  copy.onclick = () => action(async () => { await api.copy(selected?.path || filename); toast('已复制路径'); });
  if (reveal) reveal.onclick = () => action(() => openSelected(true));
  const remote = $('path-reference-remote');
  if (remote) remote.onclick = () => action(async () => {
    $('dialog').close();
    await openTools('files', remoteDirectory);
  });
  renderCandidates();
  filter?.focus();
}
async function openAvatarPicker(current, select) {
  const { presets, uploads: library } = await api['avatar-list']();
  let chosen = { ...current };
  dialog('<h2>选择头像</h2><div class="avatar-choice-preview" id="avatar-choice-preview"></div><h3>预设头像</h3><div class="avatar-choice-grid" id="avatar-defaults"></div><div class="avatar-library-heading"><h3>我的头像</h3><button type="button" id="avatar-upload">上传图片</button></div><p class="hint">支持 PNG、JPG、WebP，最大 16 MiB，自动裁剪为方形。</p><div class="avatar-choice-grid avatar-library" id="avatar-options"></div><p id="avatar-empty" class="hint">还没有上传头像。</p>', () => select(chosen), '使用头像');
  function render() {
    $('avatar-choice-preview').innerHTML = avatar(chosen, 'large') + '<span>预览</span>';
    $('avatar-defaults').innerHTML = presets.map(item => `<button type="button" class="avatar-choice" data-avatar-default="${item.id}" aria-label="${esc(item.name)}" aria-pressed="${chosen.avatarId === item.id}">${avatar({ avatarUrl: item.src })}<span>${esc(item.name)}</span></button>`).join('');
    $('avatar-options').innerHTML = library.map((item,index) => `<button type="button" class="avatar-choice" data-avatar-id="${item.id}" aria-label="上传头像 ${index + 1}" aria-pressed="${chosen.avatarId === item.id}">${avatar({ avatarUrl: item.src })}<span>头像 ${index + 1}</span></button>`).join('');
    $('avatar-empty').hidden = Boolean(library.length);
    for (const button of document.querySelectorAll('[data-avatar-default]')) button.onclick = () => { const item = presets.find(entry => entry.id === button.dataset.avatarDefault); chosen = { avatar: current.avatar || 0, avatarId: item.id, avatarUrl: item.src }; render(); };
    for (const button of document.querySelectorAll('[data-avatar-id]')) button.onclick = () => { const item = library.find(entry => entry.id === button.dataset.avatarId); chosen = { avatar: current.avatar || 0, avatarId: item.id, avatarUrl: item.src }; render(); };
  }
  $('avatar-upload').onclick = () => action(async () => {
    const button = $('avatar-upload'); const submit = $('dialog-submit');
    button.disabled = true; submit.disabled = true;
    try {
      const item = await api['avatar-upload']();
      if (item && $('avatar-options')) {
        if (!library.some(entry => entry.id === item.id)) library.unshift(item);
        chosen = { avatar: current.avatar || 0, avatarId: item.id, avatarUrl: item.src }; render();
      }
    } finally { button.disabled = false; submit.disabled = false; }
  });
  render();
}
function directoryRows(entries) {
  return entries.map(d => `<div class="directory-row"><select class="dir-location" aria-label="目录所在位置">${options(state.locations.map(l => [l.id, l.name]), d.locationId)}</select><input class="dir-path" value="${esc(d.path)}" aria-label="项目目录路径" required><button type="button" class="directory-browse">浏览…</button><button type="button" class="icon-button remove-directory" title="移除目录">${icon('x')}</button></div>`).join('');
}
function bindDirectoryButtons() {
  document.querySelectorAll('#directory-rows .directory-row').forEach(row=>{
    const location=row.querySelector('.dir-location'),input=row.querySelector('.dir-path'),browse=row.querySelector('.directory-browse');
    const refresh=()=>{const local=locationOf(location.value)?.type==='local';browse.hidden=!local;input.placeholder=local?'D:\\example_project':'~/project';};
    location.onchange=refresh;refresh();
    browse.onclick=()=>action(async()=>{
      const target=location.value,original=input.value;if(locationOf(target)?.type!=='local')return;
      browse.disabled=true;
      try{const paths=await api.pick('folder',original);if(paths[0]&&row.isConnected&&$('dialog').open&&location.value===target&&input.value===original){input.value=paths[0];input.dispatchEvent(new Event('input',{bubbles:true}));}}
      finally{browse.disabled=false;refresh();}
    });
    row.querySelector('.remove-directory').onclick=()=>row.remove();
  });
}
function destructiveSetting(id, label, warning) {
  return `<div class="destructive-setting"><p id="${id}-warning">${esc(warning)}</p>
    <button type="button" class="danger" id="${id}" aria-describedby="${id}-warning">${esc(label)}</button></div>`;
}
function openProject(p) {
  const inviteRoles = state.roles.filter(r => r.enabled !== false || p?.roleIds.includes(r.id));
  const duties = {...p?.roleDuties};
  let selected = p?.roleIds || inviteRoles.map(r => r.id);
  let focused = selected[0];
  const tabs = [['general','常规'],['roles','角色'],['collaboration','协作']];
  dialog(`<h2>${p ? '项目设置' : '新建项目'}</h2>
    <div class="project-settings-tabs" role="tablist" aria-label="项目设置">${tabs.map(([id,label]) => `<button type="button" role="tab" id="p-tab-${id}" aria-controls="p-panel-${id}">${label}</button>`).join('')}</div>
    <section id="p-panel-general" role="tabpanel" aria-labelledby="p-tab-general"><label>项目名称<input id="p-name" value="${esc(p?.name || '')}" placeholder="例如，我的项目" required></label><label>项目工作目录<span class="hint">首个目录默认打开。请为角色的运行位置配置目录。</span></label><div id="directory-rows">${directoryRows(p?.directories || [{ locationId: 'local', path: '' }])}</div><button type="button" id="directory-add" class="quiet">${icon('plus')}添加目录</button></section>
    <section id="p-panel-roles" role="tabpanel" aria-labelledby="p-tab-roles" hidden>
      <div class="project-roles-heading"><h3>项目成员</h3><button type="button" id="p-manage-roles" aria-expanded="false" aria-controls="p-role-picker">${icon('plus')}添加或移除角色</button></div>
      <div id="p-role-picker" hidden></div>
      <div class="project-roles-layout"><div id="p-role-list" aria-label="项目成员分工"></div><div id="p-role-duty" hidden></div></div>
    </section>
    <section id="p-panel-collaboration" role="tabpanel" aria-labelledby="p-tab-collaboration" hidden>
      <h3>AI 邀请</h3><div id="p-ai-invites"></div>
      <div class="project-guest-setting"><label class="project-mention-setting"><input type="checkbox" id="p-guest-mentions" aria-describedby="project-mention-hint" ${p?.allowGuestMentions!==false?'checked':''}>用户可点名未入群的项目角色</label><p id="project-mention-hint" class="hint">被点名的角色只参与这次任务。</p></div>
    </section>`, async () => {
    const result = await api['project-save']({ id: p?.id, name: $('p-name').value,
      allowGuestMentions: $('p-guest-mentions').checked, aiInvites: readPolicy(), roleDuties: duties,
      directories: [...$('directory-rows').querySelectorAll('.directory-row')].map(row => ({ locationId: row.querySelector('select').value, path: row.querySelector('input').value })), roleIds: selected });
    state = await api.snapshot();
    projectId = result.id; if (chat()?.projectId !== result.id) chatId = chats()[0]?.id; renderSidebar(); activateChat();
  });
  $('dialog').classList.add('project-settings-dialog');
  function showTab(active, focus = false) {
    for (const [id] of tabs) {
      const tab = $('p-tab-' + id);
      tab.setAttribute('aria-selected', String(id === active));
      tab.tabIndex = id === active ? 0 : -1;
      $('p-panel-' + id).hidden = id !== active;
      if (focus && id === active) tab.focus();
    }
  }
  tabs.forEach(([id], index) => {
    const tab = $('p-tab-' + id);
    tab.onclick = () => showTab(id);
    tab.onkeydown = event => {
      const next = {ArrowLeft:(index+tabs.length-1)%tabs.length, ArrowRight:(index+1)%tabs.length, Home:0, End:tabs.length-1}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      showTab(tabs[next][0], true);
    };
  });
  showTab('general');
  $('p-panel-general').addEventListener('invalid', () => showTab('general'), true);
  const readPolicy = window.deskCollaborationUI.policyEditor($('p-ai-invites'), 'project', state.settings, p);
  const roster = $('p-role-list'), inspector = $('p-role-duty');
  function renderRoleList() {
    roster.innerHTML = selected.map(id => {
      const r = role(id);
      if (!r) return '';
      const duty = window.deskCollaboration.duty(r, {roleDuties:duties});
      return `<button type="button" class="project-role-row" data-project-member="${esc(id)}" aria-pressed="${id===focused}">${avatar(r)}<span><strong>${esc(r.name)}${r.enabled===false?' <small>已禁用</small>':''}</strong><span class="project-role-summary">${esc(duty.value || '未设置分工')}</span><small>${duty.source==='project'?'项目分工':'继承自全局'}</small></span></button>`;
    }).join('') || '<p class="hint">还没有项目成员。添加角色后即可设置分工。</p>';
    for (const row of roster.querySelectorAll('button')) row.onclick = () => {
      focused = row.dataset.projectMember;
      renderRoleList(); renderInspector();
      [...roster.querySelectorAll('button')].find(button => button.dataset.projectMember === focused)?.focus();
    };
  }
  function renderInspector() {
    const r = focused && role(focused);
    inspector.hidden = !r;
    if (!r) return;
    inspector.innerHTML = `<h3>${esc(r.name)}的分工</h3><div></div>`;
    window.deskCollaborationUI.dutyEditor(inspector.lastElementChild, {
      scope:'project', role:r, parent:window.deskCollaboration.duty(r), value:duties[r.id],
      onChange(value) {
        if (value === null) delete duties[r.id]; else duties[r.id] = value;
        renderRoleList();
      },
    });
  }
  window.createRolePicker($('p-role-picker'), {roles:inviteRoles, selected, projectRoleIds:selected,
    locationName:id=>locationOf(id)?.name, selectionHint:'选择要加入项目的角色。', inputName:'project-role', onChange(ids) {
      selected = ids;
      if (!selected.includes(focused)) focused = selected[0];
      renderRoleList(); renderInspector();
    }});
  $('p-manage-roles').onclick = () => {
    const picker = $('p-role-picker');
    picker.hidden = !picker.hidden;
    $('p-manage-roles').setAttribute('aria-expanded', String(!picker.hidden));
    if (!picker.hidden) picker.querySelector('input[type=search]').focus();
  };
  $('directory-add').onclick = () => { $('directory-rows').insertAdjacentHTML('beforeend', directoryRows([{ locationId: 'local', path: '' }])); bindDirectoryButtons(); }; bindDirectoryButtons();
  if (p) {
    const manual = state.settings.projectOrder === 'manual';
    $('p-panel-general').insertAdjacentHTML('beforeend',`<div class="tool-actions" ${manual?'':'hidden'}><button type="button" id="project-up" class="quiet">${icon('arrow-up')}上移项目</button><button type="button" id="project-down" class="quiet">${icon('arrow-down')}下移项目</button></div><section class="destructive-settings"><h3>危险操作</h3>
      ${destructiveSetting('project-delete','删除项目并归档','项目和聊天将移出列表并存入本机归档。工作目录和磁盘文件会保留。')}</section>`);
    $('project-up').onclick = () => action(async () => { await api['project-move'](p.id, -1); toast('项目顺序已更新'); });
    $('project-down').onclick = () => action(async () => { await api['project-move'](p.id, 1); toast('项目顺序已更新'); });
    const remove = $('project-delete');
    remove.onclick = () => action(async () => {
      remove.disabled = true;
      try {
        if (!await api['project-delete'](p.id)) return;
        $('dialog').close();
        state = await api.snapshot();
        projectId = orderedProjects()[0]?.id;
        chatId = chats()[0]?.id;
        renderSidebar();activateChat();refreshTerminalTabs();
        toast('项目已删除，聊天记录已存入本机归档。');
      } finally {
        remove.disabled = false;
      }
    });
  }
}
async function openConversationResult(result) {
  saveDraftNow();
  state=await api.snapshot();
  projectId=result.projectId;chatId=result.id;filter='all';query='';
  renderSidebar();activateChat();refreshTerminalTabs();
}
function openRolePriorities() {
  roleModelPicker?.destroy();
  roleModelPicker = undefined;
  refreshPriorityView = window.deskWorkflowUI.priorityView($('editor-view'), {
    rules: () => state.workflowPriorities || [], roles: () => state.roles, roleAvatar: role => avatar(role), icon, edit: openPriorityRule,
  });
  renderList();
}

function openPriorityRule(rule) {
  let read;
  async function save(value) {
    const feedback = $('priority-error');
    const submit = $('dialog-submit');
    const remove = $('priority-delete');
    submit.disabled = true;
    if (remove) remove.disabled = true;
    feedback.hidden = true;
    try {
      state.workflowPriorities = await api['workflow-priority-save'](rule?.id, value);
      if (page === 'locations') renderLocationTunnelStatus();
  refreshPriorityView?.();
      toast(value ? '优先级规则已保存' : '优先级规则已删除');
      return true;
    } catch (error) {
      feedback.textContent = uiError(error);
      feedback.hidden = false;
      return false;
    } finally {
      submit.disabled = false;
      if (remove) remove.disabled = false;
    }
  }
  dialog(`<h2>${rule ? '编辑优先级规则' : '新增优先级规则'}</h2>`, () => save(read()), '保存规则');
  const candidates = state.roles.filter(role => !usesExternalConversation(role.engine)).toSorted((a,b) => Number(a.enabled===false)-Number(b.enabled===false));
  read = window.deskWorkflowUI.editPriority($('dialog-body'), rule, candidates,
    window.deskWorkflowRatings.catalog(state.workflowPriorities || []), async () => {
      if (confirm('删除这条优先级规则？') && await save(null)) $('dialog').close();
    });
}

function openWorkflow(existing,{groupTarget,definition}={}){
  const activeProject = project();
  if (!activeProject) { toast('请先创建或选择一个项目。'); return; }
  const roles=state.roles.filter(r=>r.enabled!==false&&!usesExternalConversation(r.engine)&&activeProject.directories.some(d=>d.locationId===r.locationId));
  if (!roles.length && !existing&&!groupTarget) { openGraphWorkflow(activeProject); return; }
  if(!roles.length){toast('当前项目没有可以运行工作流的角色。请先在项目设置中为角色的运行位置添加工作目录。');return;}
  const stages=['implement','review'];
  const teams={implement:[roles[0].id],review:[(roles[1]||roles[0]).id]};
  const config=definition||existing?.workflow;
  if(config)for(const stage of stages)teams[stage]=config.teams[stage].filter(id=>roles.some(role=>role.id===id));
  const moderatorId=config?.moderatorRoleId||'';
  const moderationOptions=[['','按候选顺序'],...roles.map(role=>[role.id,`AI 主持 · ${role.name}`])];
  if(moderatorId&&!roles.some(role=>role.id===moderatorId))moderationOptions.push([moderatorId,'原主持角色不可用']);
  const fields=existing?'':groupTarget?`<label>工作流名称<input id="wf-title" maxlength="100" required value="${esc(definition?.title||'执行与验收')}"></label>
    <label>验收标准<textarea id="wf-criteria" rows="3" maxlength="16000" required>${esc(definition?.criteria||'')}</textarea></label>
    <label>最多轮数<input id="wf-limit" type="number" min="1" max="20" value="${definition?.limit||3}" required></label>`:
    '<button type="button" id="wf-ai-plan">AI 生成工作流</button> <button type="button" id="wf-graph-open">编排工作流 / 使用模板</button><label>任务目标<textarea id="wf-goal" rows="3" maxlength="16000" required></textarea></label><label>验收标准<textarea id="wf-criteria" rows="3" maxlength="16000" required></textarea></label><label>最多轮数<input id="wf-limit" type="number" min="1" max="20" value="3" required></label>';
  const moderation=`<label>选人方式<select id="wf-moderator" aria-describedby="wf-moderator-hint">${options(moderationOptions,moderatorId)}</select></label><p id="wf-moderator-hint" class="hint" hidden>有多个候选时由主持人先选一位。该角色不可用时，按列表顺序尝试其余候选。</p>`;
  const title=existing?'编辑工作流角色和主持人':groupTarget?'执行与验收工作流':'新建工作流';
  let readSchedule=()=>undefined;
  dialog(`<h2>${title}</h2>${fields}${moderation}${stages.map(stage=>`<section class="setting-card"><h3>${stage==='review'?'验收角色':'执行角色'}</h3><div id="wf-${stage}"></div></section>`).join('')}<p id="wf-error" class="message-note" role="alert" hidden></p>`,async()=>{
    const submit=$('dialog-submit');submit.disabled=true;
    const feedback = $('wf-error');
    feedback.hidden = true;
    try{
      const moderatorRoleId=$('wf-moderator').value;
      if(existing){await invokeWorkflow('teams',existing.id,teams,moderatorRoleId);return;}
      if(groupTarget) {
        await saveGroupWorkflow(groupTarget,definition?.id,{type:'teams',title:$('wf-title').value,
          criteria:$('wf-criteria').value,limit:$('wf-limit').valueAsNumber,teams,moderatorRoleId});
        return;
      }
      const result=await invokeWorkflow('create',{projectId:activeProject.id,goal:$('wf-goal').value,criteria:$('wf-criteria').value,limit:Number($('wf-limit').value),teams,moderatorRoleId,startAt:readSchedule()});
      await openConversationResult(result);filter='workflow';renderSidebar();
    }catch(error){
      feedback.textContent = error.message;
      feedback.hidden = false;
      feedback.scrollIntoView({block:'nearest'});
      return false;
    }finally{submit.disabled=false;}
  },existing||groupTarget?'保存工作流':'创建并排队');
  if(!existing&&!groupTarget) readSchedule=workflowScheduleOptions($('dialog-body'));
  function render(stage){
    const group=$('wf-'+stage),team=teams[stage];
    group.replaceChildren();
    team.forEach((id,index)=>{
      const row=document.createElement('div');row.className='group-order-row';
      const select=document.createElement('select');
      select.setAttribute('aria-label',`${workflowStages[stage]} · 候选角色 ${index+1}`);
      select.innerHTML=options(roles.filter(r=>r.id===id||!team.includes(r.id)).map(r=>[r.id,r.name]),id);
      select.onchange=()=>{team[index]=select.value;render(stage);};
      const label=document.createElement('span');label.textContent=$('wf-moderator').value?`候选 ${index+1}`:index?`备选 ${index}`:'首选';
      row.append(label,select);
      for(const [title,delta] of [['上移',-1],['下移',1]]){
        const button=document.createElement('button');button.type='button';button.textContent=delta<0?'↑':'↓';button.title=title;
        button.disabled=index+delta<0||index+delta>=team.length;
        button.onclick=()=>{[team[index],team[index+delta]]=[team[index+delta],team[index]];render(stage);};row.append(button);
      }
      const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.title='移除候选角色';remove.disabled=team.length===1;
      remove.onclick=()=>{team.splice(index,1);render(stage);};row.append(remove);group.append(row);
    });
    const next=roles.find(r=>!team.includes(r.id));
    const add=document.createElement('button');add.type='button';add.textContent='添加候选角色';add.disabled=!next;
    add.onclick=()=>{team.push(next.id);render(stage);};group.append(add);
  }
  const refresh=()=>{$('wf-moderator-hint').hidden=!$('wf-moderator').value;stages.forEach(render);};
  $('wf-moderator').onchange=refresh;
  if (!existing&&!groupTarget) $('wf-ai-plan').onclick=()=>{
    const criteria=$('wf-criteria').value.trim();
    const goal=[$('wf-goal').value.trim(),criteria&&`验收标准\n${criteria}`].filter(Boolean).join('\n\n');
    openGeneratedWorkflow(activeProject,{goal});
  };
  if (!existing&&!groupTarget) $('wf-graph-open').onclick=()=>{
    const goal=[$('wf-goal').value.trim(),$('wf-criteria').value.trim()].filter(Boolean).join('\n\n');
    openGraphWorkflow(activeProject,{goal});
  };
  refresh();
}

function openGraphWorkflow(activeProject,{goal='',draft}={}) {
  const roles = state.roles.filter(role=>{
    const location = locationOf(role.locationId);
    return role.enabled!==false && !usesExternalConversation(role.engine) &&
      activeProject.directories.some(directory=>directory.locationId===role.locationId) &&
      (location?.type==='local' || (location?.os==='linux' && role.provider==='native'));
  }).map(role=>({...role,location:locationOf(role.locationId).name,local:role.locationId==='local'}));
  let read, busy=false;
  dialog(`<h2>编排工作流</h2><div id="graph-workflow-editor">
    <div class="graph-template-bar">
      <label>模板<select id="graph-template-select"></select></label>
      <button type="button" id="graph-template-load">载入副本</button>
      <button type="button" id="graph-starter">修复与真机验收示例</button>
    </div>
    <div class="graph-inputs">
      <label>工作流名称<input id="graph-title" value="${esc(draft?.title || '')}" maxlength="100"></label>
      <label>本次任务目标<textarea id="graph-goal" rows="2" maxlength="16000">${esc(goal)}</textarea></label>
    </div>
    <p class="hint">拖动节点安排布局，从右侧出口拖到下一节点左侧。也可以在节点设置里选择下一步。</p>
    <div class="graph-editor-host"></div>
    <p id="graph-feedback" role="status" hidden></p>
  </div>`,async()=>{
    if (busy) return false;
    return perform(async()=>{
      const result=await invokeWorkflow('create',{...value(),type:'graph',projectId:activeProject.id,goal:$('graph-goal').value,startAt:readSchedule()});
      await openConversationResult(result);
      filter='workflow';renderSidebar();
    });
  },'运行工作流');
  const modal=$('dialog');
  modal.classList.add('graph-workflow-dialog');
  const root=$('graph-workflow-editor'), feedback=$('graph-feedback');
  const readSchedule=workflowScheduleOptions(root);
  const templates=[...(state.workflowTemplates || [])];
  const picker=$('graph-template-select'), load=$('graph-template-load');
  const starter=$('graph-starter'), title=$('graph-title');
  const save=document.createElement('button');
  save.type='button';save.id='graph-template-save';save.textContent='另存为模板';
  const submit=$('dialog-submit');
  $('dialog-close').before(save);
  modal.addEventListener('close',()=>save.remove(),{once:true});
  const value=()=>({...read(),title:title.value});
  function showFeedback(text,error=false) {
    feedback.hidden=false;
    feedback.className=error?'message-note':'hint';
    feedback.textContent=text;
    feedback.scrollIntoView({block:'nearest'});
  }
  async function perform(task) {
    busy=true;submit.disabled=save.disabled=load.disabled=starter.disabled=true;feedback.hidden=true;
    try { return await task(); }
    catch (error) { if (root.isConnected && modal.open) showFeedback(error.message,true); return false; }
    finally {
      busy=false;
      if (root.isConnected && modal.open) {submit.disabled=save.disabled=starter.disabled=false;load.disabled=!picker.value;}
    }
  }
  function updateTemplates(selected='') {
    picker.innerHTML=options([['',templates.length?'选择已保存模板':'暂无模板'],...templates.map(item=>[item.id,item.title])],selected);
    load.disabled=busy||!picker.value;
  }
  function mount(template={}) {
    const editor=root.querySelector('.graph-editor-host');
    editor.innerHTML=`<div class="graph-workspace"><div class="graph-toolbar">
      <button type="button" class="graph-add">添加节点</button>
      <button type="button" class="graph-zoom-out" aria-label="缩小画布">−</button>
      <button type="button" class="graph-zoom-in" aria-label="放大画布">+</button>
    </div><div class="graph-canvas" aria-label="工作流画布"></div></div><div class="graph-inspector"></div>`;
    read=window.deskGraphWorkflow.mount(editor,roles,template);
    if (template.title) title.value=template.title;
    feedback.hidden=true;
  }
  picker.onchange=()=>{load.disabled=!picker.value;};
  load.onclick=()=>{const template=templates.find(item=>item.id===picker.value);if(template) mount(template);};
  starter.onclick=()=>mount(window.deskGraphWorkflow.starter());
  save.onclick=()=>perform(async()=>{
    const saved=await invokeWorkflow('template-save',value());
    if (!root.isConnected || !modal.open) return;
    templates.unshift(saved);updateTemplates(saved.id);
    showFeedback('已保存模板「'+saved.title+'」。');
  });
  updateTemplates();
  mount(draft);
}

function openGeneratedWorkflow(activeProject,{goal='',existing,rerun=false,groupTarget,definition}={}) {
  const eligible=state.roles.filter(r=>{
    if (!r||r.enabled===false||usesExternalConversation(r.engine)||!activeProject.directories.some(d=>d.locationId===r.locationId)) return false;
    const location=locationOf(r.locationId);
    return location?.type==='local'||(location?.os==='linux'&&r.provider==='native');
  });
  if (!eligible.length) {toast('请先在项目设置中加入一位已启用且能自动运行的角色，并配置对应的工作目录。');return;}
  const flow=definition||existing?.workflow;
  const editing=existing&&!rerun;
  const title=editing||definition?.id?'编辑工作流步骤':rerun?'再次运行工作流':'AI 生成工作流';
  const projectRoles = activeProject.roleIds.map(id => eligible.find(role => role.id === id)).filter(Boolean);
  const hostOptions=eligible.map(r=>[r.id,`${r.name} · ${locationOf(r.locationId)?.name||''}`]);
  const fields=`<label ${definition?'hidden':''}>任务目标<textarea id="wf-plan-goal" rows="4" maxlength="16000" ${definition?'':'required'} ${existing||definition?'readonly':''}>${esc(flow?.goal||goal)}</textarea></label>`;
  const planning=flow?'':`<label id="wf-plan-planner-field">生成角色<select id="wf-plan-planner">${options(hostOptions,projectRoles[0]?.id || eligible[0].id)}</select></label>`;
  const preview=`<section id="wf-plan-preview" hidden><label>工作流名称<input id="wf-plan-title" maxlength="100" ${editing?'readonly':''}></label><label>未匹配规则时的主持人<select id="wf-plan-moderator">${options([['','不指定主持人'],...hostOptions],flow?.moderatorRoleId||'')}</select></label><p class="hint">每一步开始时读取角色优先级表。未匹配规则时，由这里选定的主持人选人。</p><label>整个工作流最多返工次数<input id="wf-rework-limit" type="number" min="0" max="20" value="3" required ${editing?'readonly':''}></label><div id="wf-plan-nodes"></div></section>`;
  let readNodes, requestId, root, feedback, target, submit, goalInput, plannerField, readSchedule;
  dialog(`<h2>${title}</h2><div id="wf-plan-form">${fields}${planning}${preview}<p id="wf-plan-error" class="message-note" role="status" hidden></p></div>`,async()=>{
    submit.disabled=true;feedback.hidden=true;
    try {
      if (!readNodes) {
        requestId=crypto.randomUUID();
        const plannerId=$('wf-plan-planner').value;
        feedback.textContent='正在生成工作流预览…';feedback.hidden=false;
        const plan=await invokeWorkflow('plan',{projectId:activeProject.id,goal:goalInput.value,plannerId,requestId});
        if (plan&&root.isConnected&&target.open) showPreview(plan,plannerId);
        return false;
      }
      const value={type:'generated',projectId:activeProject.id,goal:goalInput.value,title:$('wf-plan-title').value,nodes:readNodes(),reworkLimit:$('wf-rework-limit').valueAsNumber,moderatorRoleId:$('wf-plan-moderator').value};
      if (groupTarget) await saveGroupWorkflow(groupTarget,definition?.id,value);
      else if (editing) await invokeWorkflow('generated-update',existing.id,value);
      else {
        const result=await invokeWorkflow('create',{...value,startAt:readSchedule()});
        await openConversationResult(result);filter='workflow';renderSidebar();
      }
    } catch(error) {
      if (root.isConnected&&target.open) {feedback.textContent=error.message;feedback.hidden=false;feedback.scrollIntoView({block:'nearest'});}
      return false;
    } finally {
      requestId=undefined;
      if (root.isConnected&&target.open) submit.disabled=false;
    }
  },editing?'保存设置':rerun?'创建并排队':'生成预览');
  root=$('wf-plan-form');feedback=$('wf-plan-error');target=$('dialog');submit=$('dialog-submit');goalInput=$('wf-plan-goal');plannerField=$('wf-plan-planner-field');
  if(!editing&&!groupTarget)readSchedule=workflowScheduleOptions($('wf-plan-preview'));
  function showPreview(plan,moderatorId) {
    feedback.hidden=true;goalInput.readOnly=true;
    if (plannerField) plannerField.hidden=true;
    $('wf-plan-preview').hidden=false;
    $('wf-plan-title').value=plan.title;
    $('wf-rework-limit').value=plan.reworkLimit ?? 3;
    $('wf-plan-title').required=true;
    $('wf-plan-moderator').value=eligible.some(r=>r.id===moderatorId)?moderatorId:'';
    const orderedIds = new Set(plan.nodes.flatMap(node => node.roleIds || []));
    const currentRoles=[...projectRoles,...eligible.filter(item=>!activeProject.roleIds.includes(item.id) && (item.id===moderatorId || orderedIds.has(item.id)))];
    readNodes=window.deskWorkflowUI.editPlan($('wf-plan-nodes'),plan.nodes,currentRoles,state.workflowPriorities || [],editing?flow.nodeIndex:0,eligible);
    submit.textContent=editing?'保存设置':groupTarget?'保存工作流':'创建并排队';
  }
  if (flow) showPreview(flow,flow.moderatorRoleId);
  target.addEventListener('close',()=>{
    if (requestId) invokeWorkflow('plan-cancel',activeProject.id,requestId).catch(()=>{});
  },{once:true});
}

const workflowMessages = new Map([
  ['Choose 0 to 20 rework attempts.', '整个工作流最多可返工 0 到 20 次。'],
  ['Choose an earlier step for rework.', '返工目标必须是当前步骤之前的步骤。'],
  ['Rework is still required at the shared limit.', '已达到返工上限，仍有问题待修复。请查看本步骤的检查结果。'],
  ['Enter a goal and acceptance criteria (up to 16,000 characters each).', '请填写任务目标和验收标准，每项最多 16,000 字符。'],
  ['Choose distinct candidates in priority order for each stage.', '请分别为执行和验收阶段选择角色并排好顺序。同一阶段不能重复选择同一个角色。'],
  ['Choose 1 to 20 rounds.', '最多轮数须为 1 到 20 之间的整数。'],
  ['The moderator could not select a candidate. Check the moderator output before continuing.', '主持人未能选出候选角色。请查看主持人任务输出或调整选人方式后继续。'],
  ['The moderator returned an invalid workflow candidate.', '主持人返回的角色不在当前阶段的候选范围内，或返回格式有误。'],
  ['The workflow moderator timed out. Check its output before continuing.', '主持人选人超过 90 秒。请查看主持人任务输出后再继续。'],
  [workflowStepTimedOut, workflowStepTimeoutText],
  ['The workflow has invalid stages, candidates, or round limits. Review its settings before continuing.', '工作流的阶段、候选角色或轮数设置无效。请检查后再继续。'],
  ['The workflow must have 1 to 12 ordered steps with a title, instruction, domain, and duty.', '工作流须有 1 到 12 个顺序执行的步骤。每步需要名称、任务、领域和职责。请调整目标后重新生成或检查预览。'],
  ['Choose at least one distinct project role for each ordered step.', '请为每个指定名单的步骤选择至少一个可用的项目角色。同一步骤不能重复选人。'],
  ['Enter a workflow goal of up to 16,000 characters.', '请填写工作流目标，最多 16,000 字符。'],
  ['Choose a planner invited to this project.', '请选择已加入项目且能在工作目录运行的角色。'],
  ['Wait for an available workspace task slot to generate a workflow.', '当前没有空闲任务位置，请等正在运行的任务结束后再生成。'],
  ['Workflow generation timed out. Try again with a shorter goal.', '生成工作流超时，请缩短目标描述后重试。'],
  ['Workflow generation failed. Check the planner connection, login, and quota.', '生成工作流失败。请检查生成角色的连接、登录和额度。'],
  ['The moderator did not return valid coordination JSON.', 'AI 返回的方案格式无效，请重新生成。'],
  ['Moderator response exceeds the metadata limit.', 'AI 返回的方案太长，请缩小任务范围后重新生成。'],
  ['Invite a role with a configured project directory before running this workflow.', '请先邀请角色，并为其运行位置配置项目目录。'],
  ['The number of steps cannot change after the workflow starts.', '工作流启动后只能编辑未完成步骤的设置。'],
  ['No rated role could be selected. Add ratings, select a moderator, or specify roles for this step.', '请添加角色优先级规则、选主持人，或为这一步指定名单。'],
  ['No selected roles are available for this workflow step.', '当前步骤的候选角色均不可用。'],
  ['This workflow step needs your decision.', '当前步骤需要你作出决定。'],
  ['The workflow step returned no recognized completion signal.', '当前步骤未返回可识别的完成结果，请查看任务输出。'],
  ['All workflow steps completed.', '工作流的所有步骤已完成。'],
  ['The workflow reached its execution limit.', '工作流已达执行次数上限，请检查运行记录。'],
  ['Workflow cannot resume from this state.', '工作流当前无法继续。'],
  ['Enter up to 16,000 characters of additional guidance.', '补充说明最多可输入 16,000 字符。'],
  ['Teams can be changed while the workflow is stopped.', '请在工作流停止后修改角色。'],
  ['All candidates unavailable for implement.', '执行阶段的候选角色均不可用。'],
  ['All candidates unavailable for review.', '验收阶段的候选角色均不可用。'],
  ['Step outcome is unconfirmed. Inspect the transcript before continuing.', '当前步骤结果未确认。请查看运行记录后再继续。'],
  ['Acceptance criteria passed.', '已通过验收。'],
  ['Review still requires changes at the round limit.', '已达轮数上限，验收仍要求修改。'],
  ['Reviewer needs your decision.', '验收角色需要你作出决定。'],
  ['Reviewer returned no recognized verdict.', '未识别到验收角色的结论。'],
  ['Interrupted with no confirmed result. Inspect the workspace before retrying.', '运行已中断，结果尚未确认。请检查工作区后再重试。'],
  ['Role unavailable for unattended execution.', '该角色无法自动参与工作流。'],
  ['quota_or_rate_limit', '额度不足或达到速率限制'],
  ['quota unavailable', '额度不足'],
  ['capacity', '服务繁忙'],
  ['authentication', '身份验证失败'],
  ['agent setup unavailable', '角色运行环境不可用'],
  ['connection unavailable', '连接不可用'],
  ['shutdown unconfirmed', '上一角色的进程停止尚未确认'],
  ['agent process interrupted', '角色进程意外中断'],
]);

async function invokeWorkflow(command, ...args) {
  const channel = `workflow-${command}`;
  const restartMessage = '当前后台尚未加载工作流功能。请从「文件 → 退出」完全退出 AI 小队，再重新打开。';
  if (typeof api[channel] !== 'function') throw new Error(restartMessage);
  try {
    return await api[channel](...args);
  } catch (error) {
    const message = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    if (message === `No handler registered for 'desk:${channel}'`) throw new Error(restartMessage);
    throw new Error(workflowMessages.get(message) || message);
  }
}

function renderGraphWorkflow(panel, c) {
  const flow=c.workflow, busy=Boolean(state.running[c.id]);
  const node=flow.nodes[flow.nodeIndex];
  const key=JSON.stringify([c.id,flow,busy]);
  if (panel._key===key) return;
  panel._key=key;
  const nodeTitle=id=>flow.nodes.find(item=>item.id===id)?.title;
  const runSummary=node ? ` · ${esc(node.title)} · ${flow.visits[node.id] || 0} / ${node.limit} 次` : '';
  panel.innerHTML=`<strong>${esc(workflowStatuses[flow.status] || flow.status)}${runSummary}</strong>
    ${flow.reason?`<p>${esc(flow.reason)}</p>`:''}
    <details><summary>节点运行记录（${flow.attempts.length}）</summary>${flow.attempts.map(attempt=>{
      const current=flow.nodes[attempt.nodeIndex];
      const target=nodeTitle(attempt.target) || ({complete:'已通过',unresolved:'未解决'})[attempt.target];
      return `<p>${esc(current?.title)} · ${esc(attempt.roleName || role(attempt.roleId)?.name || attempt.roleId)} · ${esc(workflowStatuses[attempt.status])}
        ${attempt.outcome?' · '+esc(attempt.outcome):''}${target?' → '+esc(target):''}</p>`;
    }).join('')}</details>`;
  if (busy) return;
  const button=(label,click)=>{
    const element=document.createElement('button');
    element.type='button';element.textContent=label;element.onclick=click;panel.append(element);
  };
  button('打开流程副本',()=>openGraphWorkflow(project(),{goal:flow.goal,draft:flow}));
  button('将副本保存到群聊',()=>openGroupWorkflowDestination(flow));
  if (['paused','needs_check','unavailable'].includes(flow.status)) {
    const guidance=document.createElement('textarea');
    guidance.rows=2;guidance.maxLength=16000;guidance.placeholder='为当前节点补充说明（可选）';
    guidance.setAttribute('aria-label','补充说明');panel.append(guidance);
    button('重试当前节点',()=>action(()=>invokeWorkflow('resume',c.id,'retry',guidance.value)));
  }
}

function renderGeneratedWorkflow(panel,c) {
  const flow=c.workflow, busy=Boolean(state.running[c.id]);
  const key=JSON.stringify([c.id,flow,busy]);
  if (panel._key===key) return;
  panel._key=key;
  const selectionLabels={ordered:'指定名单',moderator:'主持人选择',priority:'角色优先级表',ratings:'按原评分选择',ratings_fallback:'主持人不可用，按评分选择',backup:'按备用顺序选择'};
  const node=flow.nodes[flow.nodeIndex];
  panel.innerHTML=`<strong>${esc(workflowStatuses[flow.status]||flow.status)} · 步骤 ${flow.nodeIndex+1} / ${flow.nodes.length} · ${esc(node?.title)}</strong>${flow.nodes.some(step=>step.reworkTo)?`<p>已返工 ${flow.reworkCount ?? 0} / ${flow.reworkLimit} 次</p>`:''}${flow.reason?`<p>${esc(workflowMessages.get(flow.reason)||flow.reason)}</p>`:''}<details><summary>查看工作流步骤</summary>${flow.nodes.map((step,index)=>`<p>${index+1}. ${esc(step.title)} · ${esc(step.domain)} × ${esc(step.duty)} · ${step.mode==='ordered'?'指定名单':'自动选人'}${step.reworkTo?` · 发现问题返回步骤 ${step.reworkTo}`:''}</p>`).join('')}</details><details ${flow.status==='unavailable'?'open':''}><summary>角色运行记录（${flow.attempts.length}）</summary>${flow.attempts.map(attempt=>`<p>步骤 ${attempt.nodeIndex+1} · ${esc(attempt.roleName||role(attempt.roleId)?.name||attempt.roleId)} · ${esc(selectionLabels[attempt.via])}${attempt.priority?`（${esc(attempt.priority.domain)} × ${esc(attempt.priority.duty)} · 第 ${attempt.priority.tier} 档 · 权重 ${attempt.priority.weight}）`:attempt.score!=null?`（${attempt.score} 分）`:''} · ${esc(workflowStatuses[attempt.status]||attempt.status)}${attempt.selectionReason?' · '+esc(attempt.selectionReason):''}${attempt.reworkTo?` · 要求步骤 ${attempt.reworkTo} 返工`:''}${attempt.reason?' · '+esc(workflowMessages.get(attempt.reason)||attempt.reason):''}</p>`).join('')}</details>`;
  if (busy) return;
  const button=(label,click)=>{const element=document.createElement('button');element.type='button';element.textContent=label;element.onclick=click;panel.append(element);};
  if (flow.status==='complete' || flow.status==='round_limit') {
    button('再次运行',()=>openGeneratedWorkflow(project(),{existing:c,rerun:true}));
    return;
  }
  if (!['paused','unavailable','needs_check'].includes(flow.status)) return;
  const guidance=document.createElement('textarea');guidance.rows=2;guidance.maxLength=16000;guidance.placeholder='为当前步骤补充说明（可选）';guidance.setAttribute('aria-label','补充说明');panel.append(guidance);
  button('编辑步骤设置',()=>openGeneratedWorkflow(project(),{existing:c}));
  button('重试当前步骤',()=>action(()=>invokeWorkflow('resume',c.id,'retry',guidance.value)));
}

function renderWorkflowStatus(c){
  const flow=c.workflow;
  if(!flow)return;
  $('composer').hidden=true;
  $('chat-settings').hidden=true;
  let panel=$('workflow-status');
  if(!panel){panel=document.createElement('section');panel.id='workflow-status';panel.className='setting-card';$('chat-banner').after(panel);}
  if (flow.type==='graph') {renderGraphWorkflow(panel,c);return;}
  if (flow.type==='generated') {renderGeneratedWorkflow(panel,c);return;}
  const moderator=role(flow.moderatorRoleId);
  const key=JSON.stringify([c.id,flow.status,flow.stage,flow.round,flow.limit,flow.reason,flow.moderatorRoleId,moderator?.name,flow.attempts,Boolean(state.running[c.id])]);
  if(panel._key===key)return;panel._key=key;
  panel.innerHTML=`<strong>${esc(workflowStatuses[flow.status] || flow.status)} · ${esc(workflowStages[flow.stage])} · 第 ${flow.round} / ${flow.limit} 轮</strong>${flow.moderatorRoleId?`<p>AI 主持 · ${esc(moderator?.name||'角色不可用')}</p>`:''}<p>${esc(workflowMessages.get(flow.reason) || flow.reason)}</p><details ${flow.status==='unavailable'?'open':''}><summary>角色运行记录（${flow.attempts.length}）</summary>${flow.attempts.map(a=>`<p>第 ${a.round} 轮 · ${esc(workflowStages[a.stage])} · ${esc(a.roleName||role(a.roleId)?.name||a.roleId)} · ${esc(workflowStatuses[a.status] || a.status)} ${esc(workflowMessages.get(a.reason) || a.reason)}</p>`).join('')}</details>`;
  if(!state.running[c.id]&&['paused','unavailable','needs_check'].includes(flow.status)){
    const edit=document.createElement('button');edit.textContent='编辑角色和主持人';edit.onclick=()=>openWorkflow(c);panel.append(edit);
    let guidance;
    if(flow.status==='needs_check'){
      guidance=document.createElement('textarea');guidance.rows=2;guidance.maxLength=16000;
      guidance.placeholder='为下一次运行补充说明';panel.append(guidance);
    }
    for(const [mode,label] of [['retry','重试当前阶段'],['review','进入验收阶段']]){
      if(mode==='review'&&flow.stage==='review')continue;
      const button=document.createElement('button');button.textContent=label;
      button.onclick=()=>action(()=>invokeWorkflow('resume',c.id,mode,guidance?.value||''));panel.append(button);
    }
  }
}

function openBranch(source) {
  dialog(`<h2>新建会话分支</h2><label>分支名称<input id="branch-name" maxlength="100" required value="${esc(source.name.slice(0,94)+' · 分支')}"></label><p class="hint">带入可用的压缩摘要和最近消息。没有摘要时，只带入最近消息片段。</p>`,async()=>{
    const result=await api['chat-branch'](source.id,$('branch-name').value);
    await openConversationResult(result);
  },'创建分支');
}
function openHandoff(source, proposal, prompt) {
  const targets=state.chats.filter(c=>c.id!==source.id&&!c.disbandedAt&&c.roleIds.some(roleEnabled)).sort((a,b)=>Number(b.projectId===source.projectId)-Number(a.projectId===source.projectId)||b.updatedAt-a.updatedAt);
  const selectedTarget=proposal?.targetChatId||targets[0]?.id;
  if(!targets.some(target=>target.id===selectedTarget)){toast('目标会话已不可用。');return;}
  const initial=prompt??(source.disbandedAt?'':composerRecipients().content);
  dialog(`<h2>转交到其他会话</h2><label>目标会话<select id="handoff-chat" required>${options(targets.map(c=>[c.id,(state.projects.find(p=>p.id===c.projectId)?.name||'')+' / '+c.name]),selectedTarget)}</select></label><label>接收角色</label><div id="handoff-roles" class="checks"></div><section id="handoff-speaking-order" hidden><h3>本次转交的发言顺序</h3><div id="handoff-speaking-list"></div></section><label>任务说明<textarea id="handoff-prompt" rows="7" maxlength="140000" required>${esc(initial)}</textarea></label><p class="hint">保存到目标会话的输入框，确认后再发送。</p>`,async()=>{
    syncOrder();
    const result=await api['chat-handoff'](source.id,$('handoff-chat').value,order.selected(),$('handoff-prompt').value);
    await openConversationResult(result);
  },'带入草稿');
  const order=window.createSpeakingOrder($('handoff-speaking-list'),{roles:state.roles});
  const setOrder=ids=>{
    order.set(ids);
    $('handoff-speaking-order').hidden=order.selected().length<2;
  };
  const syncOrder=()=>{
    const checked=new Set([...$('handoff-roles').querySelectorAll('input:checked')].map(input=>input.value));
    const retained=order.selected().filter(id=>checked.delete(id));
    setOrder([...retained,...checked]);
  };
  const refresh=()=>{
    const targetId=$('handoff-chat').value;
    const ids=(targets.find(c=>c.id===targetId)?.roleIds||[]).filter(roleEnabled);
    const checked=(targetId===proposal?.targetChatId?proposal.recipientIds:ids.length===1?ids:[]).filter(id=>ids.includes(id));
    $('handoff-roles').innerHTML=ids.map(id=>`<label><input type="checkbox" value="${esc(id)}" ${checked.includes(id)?'checked':''}>${esc(role(id)?.name)}</label>`).join('');
    setOrder(checked);
  };
  $('handoff-roles').onchange=syncOrder;
  $('handoff-chat').onchange=refresh;refresh();
}
function addChatActions(source) {
  $('dialog-body').insertAdjacentHTML('afterbegin','<div class="tool-actions"><button type="button" id="chat-branch">新建会话分支</button><button type="button" id="chat-handoff">转交任务</button></div>');
  $('chat-branch').disabled=!source.roleIds.some(roleEnabled);
  $('chat-handoff').disabled=!state.chats.some(c=>c.id!==source.id&&!c.disbandedAt&&c.roleIds.some(roleEnabled));
  $('chat-branch').onclick=()=>{$('dialog').close();openBranch(source);};
  $('chat-handoff').onclick=()=>{$('dialog').close();openHandoff(source);};
}
function openChat(c, preferredRole, onCreated) {
  if(c?.disbandedAt){
    dialog('<h2>群聊已解散</h2><p>聊天记录仍可查看。</p><button type="button" class="quiet" id="remove-disbanded-chat">移出列表并存入归档</button>',()=>{},'关闭');
    addChatActions(c);
    $('remove-disbanded-chat').onclick=()=>action(async()=>{
      if(!confirm('移出此对话？聊天记录会存入本机归档。'))return;
      await api['chat-delete'](c.id);$('dialog').close();state=await api.snapshot();chatId=chats()[0]?.id;renderList();activateChat();
    });
    return;
  }
  if (!project()) { toast('请先创建项目'); return; }
  if (!state.roles.length) { toast('请先在角色页创建一个角色'); return; }
  if (!c && !state.roles.some(role => role.enabled !== false)) { toast('请先在角色页启用一位角色'); return; }
  const selectableRoles = state.roles.filter(role => role.enabled !== false || c?.roleIds.includes(role.id));
  const targetProjectId = projectId;
  let picker,orderPicker;
  let defaultReplies = new Set(c?.defaultReplyRoleIds || []);
  dialog(`<h2>${c ? '对话设置' : '新建对话'}</h2><label>对话名称<input id="c-name" value="${esc(c?.name || '')}" placeholder="可留空，使用角色名或项目讨论组"></label><div class="role-picker-heading"><h3>选择参与角色</h3><span class="hint">选一位单聊，选多位群聊</span></div><div id="chat-role-picker"></div>`, async () => {
    const selected = orderPicker.selected();
    const defaults = selected.filter(id => defaultReplies.has(id));
    const value = { id: c?.id, projectId: targetProjectId, name: $('c-name').value, roleIds: selected, defaultReplyRoleIds: defaults,moderatorRoleId:$('c-moderator').value,moderatorCompression:$('c-moderator-compression').checked,aiInvites:readPolicy() };
    if (c) await api['chat-save'](value);
    else {
      const result = await api['chat-add'](value);
      state = await api.snapshot();
      chatId = result.id;
      if (onCreated) {
        filter='all';
        onCreated(chat());
      }
    }
    renderSidebar(); activateChat();
  }, c ? '保存' : '创建对话');
  $('dialog').classList.add('role-selection-dialog');
  if(c)addChatActions(c);
  if(c)$('dialog-body').insertAdjacentHTML('afterbegin','<p class="hint">保存后下次运行生效；交互连接需重新建立。</p>');
  if(c?.roleIds.length>1){
    $('dialog-body').insertAdjacentHTML('beforeend','<section class="setting-card"><h3>讨论工具</h3><p class="hint">总结共识、分歧和下一步，消耗模型额度。</p><button type="button" id="chat-summary" class="quiet">总结讨论</button></section>');
    $('chat-summary').disabled=Boolean(state.inputBusy?.[c.id]||state.running[c.id]||c.inputQueue?.length||!c.roleIds.some(roleEnabled));
    $('chat-summary').onclick=()=>{if(chatId!==c.id)return;$('dialog').close();send(true);};
  }
  $('chat-role-picker').insertAdjacentHTML('afterend','<section id="chat-speaking-settings"><h3>发言顺序</h3><p class="hint">从上到下发言；手动 @ 的顺序优先。</p><div id="chat-speaking-list"></div></section>');
  orderPicker=window.createSpeakingOrder($('chat-speaking-list'),{roles:state.roles,selected:c?.roleIds || (preferredRole?[preferredRole]:[])});
  $('chat-speaking-settings').insertAdjacentHTML('beforebegin','<section id="chat-default-replies"><h3>默认回复角色</h3><p class="hint">未 @ 时由勾选的角色回复；不勾选则全员回复。</p><div id="chat-default-reply-list" class="checks"></div></section>');
  function refreshDefaults(ids) {
    defaultReplies = new Set(ids.filter(id => defaultReplies.has(id)));
    $('chat-default-replies').hidden = ids.length < 2;
    $('chat-default-reply-list').innerHTML = ids.map(id => `<label><input type="checkbox" name="default-reply-role" value="${esc(id)}" ${defaultReplies.has(id) ? 'checked' : ''}>${esc(role(id)?.name || id)}</label>`).join('');
    for (const input of $('chat-default-reply-list').querySelectorAll('input')) input.onchange = () => {
      input.checked ? defaultReplies.add(input.value) : defaultReplies.delete(input.value);
    };
  }
  $('chat-speaking-settings').insertAdjacentHTML('afterend','<section id="chat-moderator-settings" class="moderator-settings"><h3>群聊主持人</h3><label>主持角色<select id="c-moderator" aria-label="群聊主持人"></select></label><label class="moderator-checkbox"><input type="checkbox" id="c-moderator-compression" '+(c?.moderatorCompression===false?'':'checked')+'>长历史自动压缩，保留原始记录</label><p class="hint">负责接力群聊的长历史压缩和结束判断，使用本对话中的模型设置。</p><p class="hint">每次任务最多压缩 2 次；压缩和结束判断均消耗模型额度。</p></section>');
  $('chat-moderator-settings').insertAdjacentHTML('afterend','<section class="setting-card" id="c-ai-invites" hidden><h3>AI 邀请</h3><div></div></section>');
  const readPolicy = window.deskCollaborationUI.policyEditor($('c-ai-invites').lastElementChild, 'chat', state.settings, project(), c);
  let moderatorConfigured=false;
  const refreshModerator=ids=>{refreshDefaults(ids);const selected=moderatorConfigured?$('c-moderator').value:c?.moderatorRoleId||'';moderatorConfigured=true;const eligible=ids.filter(id=>!usesExternalConversation(role(id)?.engine));$('c-moderator').innerHTML=options([['','不指定（各角色共同判断）'],...eligible.map(id=>[id,(role(id)?.name||id)+(roleEnabled(id)?'':'（已禁用）')])],eligible.includes(selected)?selected:'');$('chat-moderator-settings').hidden=ids.length<2||!eligible.length;$('c-ai-invites').hidden=ids.length<2||Boolean(c?.workflow);$('c-moderator-compression').disabled=!$('c-moderator').value;};
  $('c-moderator').onchange=()=>{$('c-moderator-compression').disabled=!$('c-moderator').value;};
  picker = window.createRolePicker($('chat-role-picker'), { roles: selectableRoles, selected: c?.roleIds || (roleEnabled(preferredRole) ? [preferredRole] : []), projectRoleIds: project().roleIds, locationName: id => locationOf(id)?.name, onChange: ids => { $('dialog-submit').disabled = ids.length === 0;const order=orderPicker.selected().filter(id=>ids.includes(id));for(const id of ids)if(!order.includes(id))order.push(id);orderPicker.set(order);$('chat-speaking-settings').hidden=ids.length<2;refreshModerator(order); } });
  if (c) {
    const group=c.roleIds.length>1;
    $('dialog-body').insertAdjacentHTML('beforeend',`<section class="destructive-settings"><h3>危险操作</h3>
      ${group?destructiveSetting('chat-disband','解散群聊','群聊将变为只读，历史记录仍可查看。'):''}
      ${destructiveSetting('chat-delete','删除对话并归档','对话将移出列表，聊天记录会存入本机归档。')}</section>`);
    if (group) $('chat-disband').onclick=()=>action(async()=>{
      if(!confirm(`解散「${c.name}」？聊天记录会保留为只读历史。`))return;
      clearTimeout(draftTimer);
      await api.draft(c.id,$('input').value);
      await api['chat-disband'](c.id);$('dialog').close();state=await api.snapshot();renderList();activateChat();
      toast('群聊已解散，聊天记录仍可查看。');
    });
    $('chat-delete').onclick = () => action(async () => { if (!confirm('删除此对话？聊天记录会存入本机归档。')) return; await api['chat-delete'](c.id); $('dialog').close(); chatId = chats()[0]?.id; activateChat(); });
  }
}
function editRole(r) {
  roleModelPicker?.destroy();
  refreshPriorityView = undefined;
  roleId = r?.id; renderList();
  const value = r || { name: '', avatar: 0, avatarId: 'preset-gpt', avatarUrl: '../assets/model-avatars/gpt.jpg', description: '', persona: '', examples: '', engine: 'codex', provider: 'native', locationId: 'local', model: '', effort: 'medium', executable: '', permission: 'workspace-write' };
  $('editor-view').innerHTML = `<form class="editor" id="role-form"><header><h1>${r ? '编辑角色' : '新建角色'}</h1>${r ? '<button type="button" id="role-enabled" class="quiet"></button>' : ''}${r ? '<button type="button" id="role-usage-open">查看额度</button>' : ''}<button class="primary" type="submit">保存角色</button></header><div class="role-identity"><div class="avatar-picker" id="avatar-picker">${avatar(value, 'large')}<button type="button" title="选择或上传头像" aria-label="选择或上传头像">${icon('camera')}</button></div><label>昵称<input id="r-name" value="${esc(value.name)}" placeholder="给角色起个名字" required></label></div><label class="field"><span>角色设定</span><small class="hint">描述角色背景、职责和性格</small><textarea id="r-persona" placeholder="你希望 TA 是谁？擅长什么？有哪些做事原则？">${esc(value.persona)}</textarea></label><label class="field examples"><span>发言风格示例</span><small class="hint">填写示例对话供角色模仿</small><textarea id="r-examples" placeholder="我：这个方案靠谱吗？&#10;角色：我先检查边界条件，再把需要验证的地方单独列出来。">${esc(value.examples)}</textarea></label><details id="role-connection"><summary>连接配置 <small>${esc(engineLabel(value.engine))} · ${esc(locationOf(value.locationId)?.name || '本机')} · ${esc(value.provider === 'native' ? '原生账号' : value.provider)}</small></summary><div class="form-grid"><label>智能体<select id="r-engine">${options(engineChoices,value.engine)}</select></label><label>运行位置<select id="r-location">${options(state.locations.filter(l => l.type === 'local' || l.os === 'linux').map(l => [l.id,l.name]),value.locationId)}</select></label><label>网络代理<select id="r-proxy">${options([['inherit','跟随所在位置'],['direct','不使用代理（直连）'],['proxy','使用位置代理']],value.proxyMode || 'inherit')}</select><small class="hint" id="r-proxy-hint"></small></label><label>服务来源<select id="r-provider">${options([['native','原生账号 / 已登录的 Agent'],['openai','OpenAI API'],['gemini','Gemini API'],['deepseek','DeepSeek API'],['moonshot','Kimi / Moonshot API']],value.provider)}</select></label><label>角色默认模型<div id="role-model-picker"></div><small class="hint">对话未指定模型时使用此值。</small></label><label>推理强度<select id="r-effort">${options([['','默认'],['low','低'],['medium','中'],['high','高'],['xhigh','很高']],value.effort)}</select></label><label>Agent 运行权限<select id="r-permission">${options([['workspace-write','允许修改工作目录'],['read-only','只读'],['danger-full-access','完全权限（无沙箱、不弹审批）']],value.permission)}</select><small id="permission-hint" class="hint"></small></label><label class="wide">API 密钥<input id="r-key" type="password" autocomplete="new-password" placeholder="${value.hasKey ? '已加密保存；留空保持不变' : '仅 API Provider 需要'}"></label><label class="wide">API 地址（可选）<input id="r-url" value="${esc(value.baseUrl || '')}" placeholder="留空使用 Provider 官方地址"></label><label class="wide">Agent 可执行文件（可选）<div style="display:flex;gap:8px"><input id="r-executable" style="flex:1" value="${esc(value.executable)}" placeholder="留空自动检测原生可执行文件"><button type="button" id="exe-pick">选择</button></div></label><label class="wide">列表简介<input id="r-description" value="${esc(value.description)}" placeholder="简短描述这个角色"></label></div><div class="checks"><label><input id="r-location-tools" type="checkbox" ${value.allowLocationTools !== false ? 'checked' : ''}>允许使用项目位置工具（SSH / Windows-MCP）</label></div><p class="hint">位置工具使用 SSH 用户或桌面服务权限，独立于 Agent 沙箱。</p><div style="display:flex;gap:8px;margin-top:13px"><button type="button" id="role-login">${icon('login')}登录原生账号</button></div></details><div class="form-actions"><span class="hint">更新将在下次发言时生效</span></div>${r?`<section class="destructive-settings"><h3>危险操作</h3>${destructiveSetting('role-delete','删除角色','聊天记录会保留。')}</section>`:''}</form><aside class="role-preview"><header><h2>回复预览</h2><span class="pill">仅示例</span></header><div class="preview-question">帮我看看这段代码可能有什么问题。</div><div class="preview-reply"><div id="preview-avatar">${avatar(value)}</div><div><b id="preview-name">${esc(value.name || '新角色')}</b><p id="preview-text">${esc(value.examples || '填写示例后可在此预览。')}</p></div></div><button type="button" id="role-try">${icon('send')}开始单聊试用</button><p class="hint">试用会创建对话并消耗模型额度。</p></aside>`;
  const personaSection=document.createElement('details');personaSection.id='role-persona';
  personaSection.innerHTML='<summary>人设与发言风格 <small>可选设置</small></summary><div class="role-persona-content"><div class="role-persona-fields"></div></div>';
  const personaFields=personaSection.querySelector('.role-persona-fields');
  personaFields.append($('r-persona').closest('label'),$('r-examples').closest('label'),$('r-description').closest('label'));
  personaSection.querySelector('.role-persona-content').append($('editor-view').querySelector('.role-preview'));
  $('role-form').insertBefore(personaSection,$('role-form').querySelector('.form-actions'));
  $('avatar-picker').closest('.role-identity').insertAdjacentHTML('afterend','<div id="r-default-duty"></div>');
  const readDefaultDuty = window.deskCollaborationUI.dutyEditor($('r-default-duty'), {scope:'global', role:value, value:value.defaultDuty});
  $('role-try').type='button';
  $('r-provider').closest('label').insertAdjacentHTML('afterend', `<label id="r-login-source-field">Codex 登录来源<select id="r-login-source">${options([['isolated','独立登录（此角色专用）'],['desktop','复用桌面版 Codex 登录']],value.codexLoginSource || 'isolated')}</select><small class="hint" id="r-login-source-hint"></small></label>`);
  $('r-login-source-field').insertAdjacentHTML('afterend','<div id="r-desktop-tools-field" class="wide"><div class="desktop-tool-inheritance"><strong id="r-desktop-tools-status"></strong><button type="button" id="r-desktop-tools-toggle" aria-describedby="r-desktop-tools-status"></button></div><input type="checkbox" id="r-desktop-tools" '+(value.codexDesktopTools===false?'':'checked')+' hidden><small class="hint">继承桌面版已启用的 MCP 和插件，适用于发言和主持人。关闭后仅使用本工具提供的工具。</small></div>');
  const remoteAntigravity = () => $('r-engine').value === 'antigravity' && $('r-location').value !== 'local';
  const customAcp = () => $('r-engine').value === 'custom-acp';
  const useSlack = () => $('r-engine').value === slackChatEngine;
  const executableField = $('r-executable').closest('label');
  executableField.insertAdjacentHTML('beforebegin', `
    <label id="r-slack-channel-field" class="wide" hidden>Slack 私信链接或会话 ID<input id="r-slack-channel" value="${esc(value.slackChannel || '')}" placeholder="D…" maxlength="256" spellcheck="false"><small class="hint">先在 Slack 和你的 Dot 或 Grok Bot 建立一对一私信。</small></label>
    <label id="r-slack-token-field" class="wide" hidden>Slack User OAuth Token<input id="r-slack-token" type="password" autocomplete="new-password" placeholder="${value.hasSlackKey ? '已加密保存，留空沿用' : 'xoxp-…'}"><small class="hint">用自己的 Slack 应用签发用户令牌，授权 chat:write、im:read 和 im:history。</small></label>`);
  const executableLabel = executableField.firstChild;
  const savedPreset = Object.keys(acpPresets).find(id => acpPresets[id].command === value.executable);
  executableField.insertAdjacentHTML('afterend', `<label class="wide" id="r-acp-preset-field" hidden>启动预设<select id="r-acp-preset">${options([['','自定义命令'],...Object.entries(acpPresets).map(([id, preset]) => [id,preset.label])],savedPreset || '')}</select><small class="hint">选择预设可填入命令和参数，账号和模型服务在 Agent 自身的界面配置。</small></label>
    <label class="wide" hidden>启动参数<textarea id="r-acp-args" rows="2" spellcheck="false">${esc(JSON.stringify(value.acpArgs || []))}</textarea><small class="hint">使用 JSON 数组，每个参数占一个元素，例如 ["acp"]。</small></label>
    <label class="wide" hidden>环境变量<textarea id="r-acp-env" rows="3" spellcheck="false">${esc(JSON.stringify(value.acpEnv || {}, null, 2))}</textarea><small class="hint">使用 JSON 对象。密钥请用 ${esc('${API_KEY}')} 的形式引用本机环境变量。</small></label>`);
  executableField.before($('r-acp-preset-field'));
  const acpFields = () => {
    if (!customAcp()) return {};
    try {
      return {
        acpArgs: JSON.parse($('r-acp-args').value.trim() || '[]'),
        acpEnv: JSON.parse($('r-acp-env').value.trim() || '{}'),
      };
    } catch {
      throw new Error('请检查 ACP 启动参数和环境变量的 JSON 格式。');
    }
  };
  let savedRoleId = r?.id;
  const loginSource = () => $('r-login-source').disabled ? 'isolated' : $('r-login-source').value;
  const refreshLoginSource = () => {
    const enabled = $('r-engine').value === 'codex' && $('r-provider').value === 'native' && $('r-location').value === 'local';
    $('r-login-source-field').hidden = !enabled; $('r-login-source').disabled = !enabled;
    const shared = enabled && loginSource() === 'desktop';
    $('r-desktop-tools-field').hidden=!shared;$('r-desktop-tools').disabled=!shared;
    $('r-desktop-tools-status').textContent=$('r-desktop-tools').checked?'已继承桌面版 MCP 和插件':'已关闭桌面工具继承';$('r-desktop-tools-toggle').textContent=$('r-desktop-tools').checked?'关闭继承':'开启继承';$('r-desktop-tools-toggle').disabled=!shared;
    $('r-login-source-hint').textContent = shared ? '共用桌面版账号；切换或退出登录会影响共用角色。' : '此角色单独登录账号。';
    $('role-login').innerHTML = icon('login') + (remoteAntigravity() ? '配置并登录 VPS' : shared ? '检查桌面版登录' : $('r-engine').value===geminiWebEngine?'在浏览器打开 Gemini':$('r-engine').value==='workbuddy'?'打开 WorkBuddy 登录':vendorKinds[$('r-engine').value]?'登录 '+vendorKinds[$('r-engine').value]+' 账号':'登录原生账号');
    if ($('r-engine').value==='zcode') $('role-login').textContent = '登录智谱账号';
    if (useSlack()) $('role-login').textContent = '检查 Slack 授权';
    $('role-login').classList.toggle('primary', remoteAntigravity());
    $('role-login').hidden = customAcp();
  };
  for (const id of ['r-engine','r-provider','r-location','r-login-source']) $(id).addEventListener('change',refreshLoginSource); refreshLoginSource();
  $('r-desktop-tools-toggle').onclick=()=>{$('r-desktop-tools').checked=!$('r-desktop-tools').checked;refreshLoginSource();};
  $('role-connection').querySelector('summary').insertAdjacentHTML('afterend','<section class="agent-runtime-card" id="agent-runtime-card" hidden><strong id="agent-runtime-title"></strong><p class="hint" id="agent-runtime-help"></p><p class="hint" id="agent-runtime-status"></p><div class="agent-runtime-actions"><button type="button" id="agent-runtime-detect">检测引擎</button><button type="button" id="agent-runtime-install" hidden>安装 / 更新官方 CLI（本工具独立目录）</button><button type="button" id="agent-runtime-account" hidden>改用官方 CLI 账号（无需 API Key）</button><button type="button" id="agent-runtime-guide">官方安装 / 登录说明</button></div></section>');
  let runtimeRequest=0;const runtimeCard=$('agent-runtime-card');
  const defaultLoginActions = $('role-login').parentElement;
  runtimeCard.insertAdjacentHTML('afterend','<p id="gemini-web-role-hint" class="hint" hidden>使用默认浏览器登录。通过复制和粘贴转接文字，点击对话头像可绑定网页链接。</p>');
  const detectRuntime = async () => {
    const engine = $('r-engine').value, locationId = $('r-location').value;
    if (!vendorKinds[engine]) return;
    const request = ++runtimeRequest, remote = remoteAntigravity();
    $('agent-runtime-status').textContent = remote ? '正在通过 SSH 检测 VPS 上的 agy…' : '正在检测本机引擎…';
    try {
      const info = await api['agent-info']({ engine, locationId, executable: $('r-executable').value });
      if (!runtimeCard.isConnected || request !== runtimeRequest) return;
      $('agent-runtime-status').textContent = remote
        ? (info.installed ? '已找到 VPS 上的 agy，可验证登录。' : '未找到 VPS 上的 agy，可通过「配置并登录 VPS」自动安装。')
        : info.source === 'custom-acp'
          ? (info.installed ? '已找到启动程序：' + info.executable : '未找到启动程序。请检查 PATH 或填写完整路径。')
          : (info.installed ? (info.source === 'desktop-engine' ? '已找到桌面引擎，兼容性待验证' : '已找到官方引擎，可登录账号') : '未检测到引擎，请安装官方 CLI 或选择运行时文件。' + (info.error ? ' ' + info.error : ''));
    } catch (error) {
      if (runtimeCard.isConnected && request === runtimeRequest) $('agent-runtime-status').textContent = uiError(error);
    }
  };
  const executables = new Map();
  let runtimeKey = value.engine + ':' + value.locationId;
  function refreshAgentKind(){
    const engine=$('r-engine').value,vendor=Boolean(vendorKinds[engine]);runtimeCard.hidden=!vendor;$('agent-runtime-install').hidden=!['kimi','codebuddy','antigravity'].includes(engine);$('agent-runtime-account').hidden=engine!=='workbuddy';$('r-provider').disabled=engine!=='codex';if(engine!=='codex')$('r-provider').value='native';
    const web = engine === geminiWebEngine;
    for (const option of $('r-location').options) {
      const location = locationOf(option.value);
      const linuxSsh = location?.os === 'linux' && location.control === 'ssh';
      option.disabled = option.value !== 'local' && (usesExternalConversation(engine) || (vendor && (engine !== 'antigravity' || !linuxSsh)));
    }
    if ($('r-location').selectedOptions[0]?.disabled) $('r-location').value = 'local';
    const remote = remoteAntigravity(), nextKey = engine + ':' + $('r-location').value;
    if (runtimeKey !== nextKey && (customAcp() || runtimeKey.startsWith('custom-acp:') || remote || (runtimeKey.startsWith('antigravity:') && runtimeKey !== 'antigravity:local'))) {
      executables.set(runtimeKey, $('r-executable').value);
      $('r-executable').value = executables.get(nextKey) || (customAcp() ? (acpPresets[$('r-acp-preset').value]?.command || '') : '');
    }
    runtimeKey = nextKey;
    runtimeRequest++;
    $('agent-runtime-status').textContent = '';
    $('agent-runtime-install').hidden ||= remote;
    const login = $('role-login');
    const loginActions = remote ? runtimeCard.querySelector('.agent-runtime-actions') : defaultLoginActions;
    if (login.parentElement !== loginActions) loginActions.prepend(login);
    $('exe-pick').hidden = remote;
    executableLabel.nodeValue = customAcp() ? 'ACP 启动命令' : 'Agent 可执行文件（可选）';
    $('r-executable').placeholder = customAcp() ? 'PATH 中的命令，或可执行文件、Node.js 脚本的完整路径' : remote ? '留空自动检测，或填写 VPS 上的 / 或 ~/ 路径' : '留空自动检测原生可执行文件';
    for (const id of ['r-location','r-proxy','r-provider','role-model-picker','r-effort','r-permission','r-key','r-url','r-executable','r-location-tools']) $(id).closest('label').hidden=web;
    if (useSlack()) for (const id of ['r-location','r-provider','role-model-picker','r-effort','r-permission','r-key','r-url','r-executable','r-location-tools']) $(id).closest('label').hidden=true;
    if (engine === 'zcode') for (const id of ['r-location','r-provider','role-model-picker','r-effort','r-key','r-url','r-location-tools']) $(id).closest('label').hidden=true;
    for (const id of ['r-slack-channel-field','r-slack-token-field']) $(id).hidden=!useSlack();
    for (const id of ['r-acp-preset','r-acp-args','r-acp-env']) $(id).closest('label').hidden=!customAcp();
    if (customAcp()) for (const id of ['r-provider','r-key','r-url','r-effort']) $(id).closest('label').hidden = true;
    $('agent-runtime-guide').hidden = customAcp() && !$('r-acp-preset').value;
    $('agent-runtime-guide').textContent = customAcp() ? '查看预设安装说明' : '官方安装 / 登录说明';
    $('agent-runtime-detect').textContent = customAcp() ? '检查启动程序' : '检测引擎';
    for (const id of ['r-proxy-hint','permission-hint']) $(id).hidden=web;
    if (useSlack()) $('permission-hint').hidden=true;
    $('r-location-tools').closest('.checks').nextElementSibling.hidden=usesExternalConversation(engine)||engine==='zcode';
    $('gemini-web-role-hint').hidden=!web;
    $('r-effort').disabled=!supportsEffort(engine);if(!supportsEffort(engine))$('r-effort').value='';
    $('r-key').disabled=$('r-provider').value==='native';$('r-url').disabled=$('r-provider').value==='native';
    if (customAcp()) {
      $('agent-runtime-title').textContent = vendorKinds[engine] + ' · 本机';
      $('agent-runtime-help').textContent = '先安装并配置支持 ACP 的智能体。模型可刷新列表、输入 ID，或留空使用 Agent 的默认模型。';
    } else if(engine==='zcode'){
      $('agent-runtime-title').textContent='ZCode · 本机';
      $('agent-runtime-help').textContent='登录智谱账号后使用 ZCode 配置中的默认模型。可用「检测引擎」检查运行时路径。';
      if($('role-connection').open)action(detectRuntime);
    } else if(vendor){$('agent-runtime-title').textContent=vendorKinds[engine]+(remote ? ' · ' + locationOf($('r-location').value).name : ' · 官方账号优先');$('agent-runtime-help').textContent=engine==='antigravity'?(remote ? '一键检测和安装官方 agy，然后在本机浏览器授权。登录归这个 VPS 的 SSH 用户使用。' : '使用 Google 账号登录；模型以列表为准，额度可用 /usage 查看。'):engine==='workbuddy'?'桌面引擎登录尚未兼容，请改用官方 CLI，以 WorkBuddy 同站点、同账号登录。':engine==='kimi'?'使用 Kimi Code 账号登录，首次需浏览器授权。':engine==='cursor'?'使用 Cursor 账号登录，可能需单独完成浏览器授权。':'使用 WorkBuddy 同站点、同账号登录 CLI；各角色共用登录，额度按站点和套餐计算。';if(!remote&&$('role-connection').open)action(detectRuntime);}
    refreshLoginSource();
  }
  $('r-engine').addEventListener('change',refreshAgentKind);$('r-provider').addEventListener('change',refreshAgentKind);$('r-location').addEventListener('change',refreshAgentKind);refreshAgentKind();
  $('agent-runtime-account').onclick=()=>{ $('r-executable').value='';$('r-url').value='';$('r-effort').value='';$('r-model').value='';$('r-engine').value='codebuddy';$('r-engine').dispatchEvent(new Event('change'));toast('已切换到官方 CLI。保存后用 WorkBuddy 同站点、同账号登录。'); };
  $('agent-runtime-install').onclick=()=>action(async()=>{const engine=$('r-engine').value,button=$('agent-runtime-install');button.disabled=true;button.textContent='正在安装官方 CLI…';try{const result=await api['agent-install'](engine);if(runtimeCard.isConnected&&$('r-engine').value===engine){if(!$('r-executable').value)$('r-executable').value=result.executable;await detectRuntime();roleModelPicker?.reset();toast('官方 CLI '+result.version+' 已安装，请登录账号');}}finally{if(button.isConnected){button.disabled=false;button.textContent='安装 / 更新官方 CLI（本工具独立目录）';}}});
  $('agent-runtime-detect').onclick=()=>action(detectRuntime);$('agent-runtime-guide').onclick=()=>action(()=>api['agent-guide']($('r-engine').value,$('r-acp-preset').value));
  $('role-connection').addEventListener('toggle',()=>{if($('role-connection')?.open&&runtimeCard.isConnected&&!remoteAntigravity())action(detectRuntime);});
  let editorModels=[];
  const editorOffering=()=>modelOffering(editorModels,$('r-model').value.trim());
  const isCursor = () => $('r-engine').value === 'cursor';
  const syncEditorEfforts=(selected,promote=false)=>{
    if (!isCursor()) renderEfforts($('r-effort'),editorOffering(),selected,{promote});
  };
  const catalogDraft=()=>({ id:savedRoleId, engine:$('r-engine').value, provider:$('r-provider').value, locationId:$('r-location').value, baseUrl:customAcp()?'':$('r-url').value, executable:$('r-executable').value, apiKey:customAcp()?'':$('r-key').value, proxyMode:$('r-proxy').value, codexLoginSource:loginSource(), ...acpFields() });
  roleModelPicker = window.createModelPicker($('role-model-picker'), { value:value.model, load:force=>api.models(catalogDraft(),{force}),
    cursor: { active: isCursor, effort: $('r-effort') }, onCatalog:models=>{
    editorModels=models;
    syncEditorEfforts($('r-effort').value);
    if(models.length&&r)api.models(r.id,{cacheOnly:true}).then(result=>{
      if(result.models?.length)receiveRoleCatalog(r.id,result.models);
    }).catch(()=>{});
  } });
  $('r-model').addEventListener('change',()=>syncEditorEfforts($('r-effort').value,true));
  syncEditorEfforts(supportsEffort(value.engine)?value.effort||'':'');
  const picker = roleModelPicker;
  const autoReadModels = () => $('role-connection')?.open && picker === roleModelPicker && !usesExternalConversation($('r-engine').value) && !remoteAntigravity() && !customAcp() && $('r-engine').value!=='zcode';
  $('role-connection').addEventListener('toggle', () => { if (autoReadModels()) picker.update(); });
  for (const id of ['r-engine','r-provider','r-location','r-key','r-url','r-executable','r-proxy','r-login-source','r-acp-args','r-acp-env']) $(id).addEventListener('change', () => {
    picker.reset();
    if (autoReadModels()) picker.update();
  });
  $('r-acp-preset').onchange = () => {
    const preset = acpPresets[$('r-acp-preset').value];
    if (preset) {
      $('r-executable').value = preset.command;
      $('r-acp-args').value = JSON.stringify(preset.args);
      $('r-model').value = '';
    }
    refreshAgentKind();
    picker.reset();
  };
  const refreshProxyHint = () => { const target = locationOf($('r-location').value); const config = target?.proxy || { mode: 'system' }; $('r-proxy-hint').textContent = $('r-proxy').value === 'direct' ? '直连模型服务。' : '使用「' + (target?.name || '') + '」的代理设置：' + (config.mode === 'custom' ? config.url : config.mode === 'direct' ? '直连' : target?.type === 'local' ? '系统代理' : '服务器环境变量') + '。'; };
  $('r-proxy').addEventListener('change', refreshProxyHint); $('r-location').addEventListener('change', refreshProxyHint); refreshProxyHint();
  if(value.engine==='claude'&&value.permission==='acceptEdits')$('r-permission').value='workspace-write';
  function refreshPermission() {
    const codex = $('r-engine').value === 'codex',claude=$('r-engine').value==='claude',vendor=Boolean(vendorKinds[$('r-engine').value]);
    $('r-permission').disabled = !codex && !claude && !vendor;if((codex||claude||vendor)&&!$('r-permission').value)$('r-permission').value='workspace-write';
    $('r-permission').querySelector('[value="workspace-write"]').textContent=claude?'标准权限（自动接受编辑）':vendor?'标准权限（按官方 Agent 规则）':'允许修改工作目录';
    $('r-permission').querySelector('[value="read-only"]').textContent=claude?'计划模式（按 Claude 规则）':'只读';
    $('r-permission').querySelector('[value="danger-full-access"]').textContent=claude?'完全权限（跳过工具审批）':vendor?'完全权限（自动同意工具审批）':'完全权限（无沙箱、不弹审批）';
    if(claude){$('permission-hint').textContent=$('r-permission').value==='danger-full-access'?'跳过工具审批；仍受系统权限、容器挂载和 MCP 授权限制。':$('r-permission').value==='read-only'?'Claude 计划模式，并非系统级只读沙箱。':'自动接受编辑；部分工具仍需审批，可在交互终端处理。';return;}
    if ($('r-engine').value==='zcode') {
      $('r-permission').querySelector('[value="read-only"]').textContent='计划模式（按 ZCode 规则）';
      $('r-permission').querySelector('[value="workspace-write"]').textContent='编辑模式（按 ZCode 规则）';
      $('r-permission').querySelector('[value="danger-full-access"]').textContent='完全权限（跳过常规工具确认）';
      $('permission-hint').textContent='ZCode 负责审批。计划模式限制普通写入和命令执行，具体范围由 ZCode 的工具规则决定。';
      return;
    }
    if (customAcp()) {
      $('r-permission').querySelector('[value="workspace-write"]').textContent = '标准权限（按 Agent 规则）';
      $('permission-hint').textContent = '工具权限由 Agent 自身管理。只读模式需要 Agent 支持；完全权限会自动同意 Agent 发给 AI 小队的单次审批。';
      return;
    }
    if(vendor){$('permission-hint').textContent='标准模式保留官方审批规则，额外审批请求会被拒绝；完全权限自动批准工具请求。';return;}
    $('permission-hint').textContent = !codex ? '权限由所选 Agent 管理。' : $('r-permission').value === 'danger-full-access' ? '允许访问项目外文件、运行命令和联网，不弹审批；仍受系统权限和容器挂载限制。' : '使用 Codex 沙箱；额外权限请求不会自动批准。';
  }
  $('r-permission').onchange = refreshPermission;
  $('r-engine').addEventListener('change', () => { if ($('r-engine').value === 'codex' && !$('r-permission').value) $('r-permission').value = 'workspace-write'; refreshPermission(); });
  refreshPermission();
  let selectedAvatar = value.avatar, selectedAvatarId = value.avatarId || '', selectedAvatarUrl = value.avatarUrl || '';
  const refreshPreview = () => { $('preview-name').textContent = $('r-name').value || '新角色'; $('preview-text').textContent = $('r-examples').value || '填写示例后可在此预览。'; };
  $('r-name').oninput = refreshPreview; $('r-examples').oninput = refreshPreview;
  if(r)$('role-usage-open').onclick=()=>openUsage(r.name);
  $('avatar-picker').onclick = () => action(() => openAvatarPicker({ avatar: selectedAvatar, avatarId: selectedAvatarId, avatarUrl: selectedAvatarUrl }, chosen => {
    selectedAvatar = chosen.avatar; selectedAvatarId = chosen.avatarId; selectedAvatarUrl = chosen.avatarUrl;
    $('avatar-picker').querySelector('.avatar').outerHTML = avatar(chosen, 'large'); $('preview-avatar').innerHTML = avatar(chosen);
  }));
  const save = async () => {
    const effort = useSlack() || isCursor() ? '' : $('r-effort').value;
    assertEffort(editorOffering(),effort);
    const slack = useSlack() ? {slackChannel:$('r-slack-channel').value, slackToken:$('r-slack-token').value} : {};
    const next = await api['role-save']({ ...catalogDraft(), ...slack, name: $('r-name').value, avatar: selectedAvatar, avatarId: selectedAvatarId, persona: $('r-persona').value, examples: $('r-examples').value, defaultDuty:readDefaultDuty(), model: picker.value(), effort, description: $('r-description').value, permission: $('r-permission').value, codexDesktopTools:$('r-desktop-tools').checked, allowLocationTools: $('r-location-tools').checked });
    $('r-slack-token').value='';
    savedRoleId = next.id;
    roleId = next.id;
    roleCatalogs.delete(next.id);
    return next;
  };
  $('role-connection').open=true;
  $('role-form').onsubmit = e => { e.preventDefault(); action(async () => { const next = await save();toast('角色已保存，下次发言生效'); editRole({...role(next.id),...next}); }); };
  $('exe-pick').onclick = () => action(async () => { const files = await api.pick('file'); if (files[0]) { $('r-executable').value = files[0]; $('r-executable').dispatchEvent(new Event('change')); } });
  $('role-login').onclick = () => action(async () => {
    if ($('r-engine').value === geminiWebEngine) return api['gemini-web-open']();
    const button = $('role-login'), remote = remoteAntigravity();
    const target = $('r-location').value;
    button.disabled = true;
    if (remote) $('agent-runtime-status').textContent = '正在检查 VPS、安装（如有需要）并验证登录…';
    try {
      const next = await save();
      const result = await loginRole(next.id);
      if (remote && runtimeCard.isConnected && remoteAntigravity() && $('r-location').value === target) {
        $('agent-runtime-status').textContent = result?.vpsConfigured ? 'VPS 登录已通过验证。' : '登录已取消，可重新配置。';
        if (result?.vpsConfigured) void picker.update(true);
      }
    } catch (error) {
      if (remote && runtimeCard.isConnected && remoteAntigravity() && $('r-location').value === target) $('agent-runtime-status').textContent = uiError(error);
      throw error;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });

  if (r) {
    const button = $('role-enabled'), tryButton = $('role-try');
    let enabled = r.enabled !== false;
    const refreshEnabled = () => {
      button.textContent = enabled ? '禁用角色' : '启用角色';
      button.title = enabled ? '暂停接收新任务，保留配置和会话' : '恢复接收新任务';
      tryButton.disabled = !enabled;
      $('role-usage-open').hidden = !enabled;
    };
    refreshEnabled();
    button.onclick = () => action(async () => {
      button.disabled = true;
      try {
        const next = await api['role-enabled'](r.id, !enabled);
        enabled = next.enabled;
        if (button.isConnected) refreshEnabled();
        toast(enabled ? '角色已启用' : '角色已禁用，配置和会话已保留');
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  $('role-try').onclick = () => action(async () => { const next = await save(); if (!project()) { toast('请先创建项目'); return; } const p = project(); if (!p.roleIds.includes(next.id)) await api['project-save']({ ...p, roleIds: [...p.roleIds, next.id] }); showPage('projects'); openChat(null,next.id); });
  if ($('role-delete')) {
    $('role-delete').onclick = () => action(async () => { if (confirm('删除这个角色？聊天记录会保留。')) { await api['role-delete'](r.id); state=await api.snapshot();editRole(state.roles[0]); } });
  }
}
function renderLocationTunnelStatus(id = locationId) {
  const statusEl = $('location-tunnel-status');
  const startBtn = $('location-mcp-start');
  const stopBtn = $('location-mcp-stop');
  if (!statusEl || !id || id === 'local') return;
  const local = state.mcpTunnels?.localMcp || {};
  const tunnel = state.mcpTunnels?.tunnels?.[id] || {};
  const localLabel = local.state === 'ready' ? `就绪（127.0.0.1:${local.localPort || 8111}）` : local.state === 'starting' ? '启动中…' : '未启动';
  const tunnelLabel = tunnel.state === 'ready' ? `已打通（服务器 127.0.0.1:${tunnel.remotePort}）` : tunnel.state === 'connecting' ? '正在打通隧道…' : tunnel.state === 'error' ? '失败' : '未连接';
  const syncLabel = tunnel.syncedRemoteEnv && tunnel.remoteEnvPath ? ` · 已同步 ${tunnel.remoteEnvPath}` : '';
  const errLabel = tunnel.error ? `\n错误：${tunnel.error}` : '';
  const requests = tunnel.directoryRequests || [];
  const approved = requests.filter(request => request.status === 'approved');
  const details = approved.map(request => `${request.directory}（${request.access === 'read-write' ? '读写' : '只读'}）`);
  if (requests.some(request => request.status === 'pending')) details.push('有目录权限申请等待确认');
  const directoryLabel = details.length ? `\n远程 MCP 目录权限：${details.join('；')}` : '';
  statusEl.textContent = `本机 Windows-MCP：${localLabel} · 反向隧道：${tunnelLabel}${syncLabel}${errLabel}${directoryLabel}`;
  const revokeBtn = $('location-mcp-revoke-directories');
  if (revokeBtn) revokeBtn.hidden = !requests.length;
  if (startBtn) {
    startBtn.textContent = tunnel.state === 'ready' ? '重新验证／重启 MCP 隧道' : tunnel.state === 'connecting' ? '正在配置并打通隧道…' : '一键配置并启动 MCP 隧道';
    startBtn.disabled = tunnel.state === 'connecting';
  }
  if (stopBtn) stopBtn.hidden = tunnel.state !== 'ready';
}
function editLocation(l) {
  locationId = l?.id; renderList(); const local = l?.id === 'local'; const managed = l?.managed;
  const tunnelCfg = l?.mcpTunnel || { enabled: false, remotePort: 18111, autoStart: false, syncRemoteEnv: true };
  $('editor-view').innerHTML = `<form class="editor simple-form" id="location-form"><header><h1>${local ? '本机' : l ? '编辑位置' : '添加位置'}</h1><button type="submit" class="primary">保存位置</button></header><label class="field"><span>位置名称</span><input id="l-name" value="${esc(l?.name || '')}" ${local ? 'disabled' : 'required'} placeholder="例如：开发服务器"></label><div class="setting-card"><h3>1. 连接方式</h3><div class="form-grid"><label>连接方式<select disabled><option>${local ? '本地（内置）' : 'SSH'}</option></select></label><label>操作系统<select id="l-os" ${local || managed ? 'disabled' : ''}>${options([['linux','Linux'],['windows','Windows']],l?.os || 'linux')}</select></label>${!local ? `<label>主机地址<input id="l-host" value="${esc(l?.host || '')}" required ${managed ? 'disabled' : ''}></label><label>端口<input id="l-port" type="number" value="${l?.port || 22}" min="1" max="65535" required ${managed ? 'disabled' : ''}></label><label>SSH 用户<input id="l-user" value="${esc(l?.username || '')}" required ${managed ? 'disabled' : ''}></label><label>私钥口令（可选）<input id="l-passphrase" type="password" autocomplete="new-password" placeholder="留空保持不变"></label><label class="wide">私钥路径（留空使用 SSH Agent）<input id="l-key" value="${esc(l?.keyPath || '')}" ${managed ? 'disabled' : ''}></label>` : ''}</div>${managed ? '<p style="margin-top:15px">地址和密钥在原界面修改。共享 MCP／隧道时，请保持提供服务的界面运行。</p>' : ''}</div><div class="setting-card"><h3>2. Agent 操控方式与 MCP 隧道</h3><p>SSH 用于命令、文件和终端；Windows-MCP 用于从远端操作本机 Windows 桌面。</p><label class="field"><span>操控方式</span><select id="l-control" ${local ? 'disabled' : ''}>${options(local ? [['ssh','本地命令 / 终端']] : [['ssh','SSH 命令与文件'],['windows-mcp','外部 Windows-MCP 端点']],l?.control || 'ssh')}</select></label>${!local ? `<div id="l-mcp-fields"><label class="field"><span>Windows-MCP 地址（选择外部端点时必填）</span><input id="l-mcp" value="${esc(l?.mcpUrl || '')}" placeholder="http://127.0.0.1:8111/mcp"></label><label class="field"><span>MCP 访问令牌</span><input id="l-token" type="password" autocomplete="new-password" placeholder="留空保持已保存值"></label><p>MCP 地址须能从 Agent 所在机器访问。</p></div><div id="l-tunnel-fields" class="tunnel-section"><p class="hint">可一键在本机启动 Windows-MCP，并通过 SSH 反向隧道映射到这台 Linux 服务器（不限于 Relay VPS）。</p><label class="field"><span>服务器反向隧道端口（127.0.0.1）</span><input id="l-tunnel-port" type="number" min="1024" max="65535" value="${esc(tunnelCfg.remotePort || 18111)}" ${managed ? 'disabled' : ''}></label><div class="checks"><label><input id="l-tunnel-enabled" type="checkbox" ${managed || tunnelCfg.enabled ? 'checked' : ''} ${managed ? 'disabled' : ''}>允许该位置上的 Agent 自动使用此 MCP 隧道</label><label><input id="l-tunnel-auto" type="checkbox" ${tunnelCfg.autoStart ? 'checked' : ''}>启动工作台时自动连接并开启此隧道</label><label><input id="l-tunnel-sync" type="checkbox" ${managed || tunnelCfg.syncRemoteEnv !== false ? 'checked' : ''} ${managed ? 'disabled' : ''}>同步 ~/.windows-mcp/tunnel.env 到服务器（供网关或脚本读取）</label></div><div id="location-tunnel-status" class="hint tunnel-status" role="status"></div><div class="tunnel-actions"><button type="button" id="location-mcp-start">一键配置并启动 MCP 隧道</button><button type="button" id="location-mcp-revoke-directories" class="quiet" hidden>收回目录权限</button><button type="button" id="location-mcp-stop" class="quiet" hidden>停止 MCP 隧道</button></div></div>` : ''}</div><div class="setting-card"><h3>3. 模型服务代理</h3><p>角色默认使用此代理，可单独选择直连。</p><label class="field"><span>默认代理方式</span><select id="l-proxy-mode">${options([['system',local ? '跟随 Windows 系统代理' : '继承服务器代理环境变量'],['direct','不使用代理（直连）'],['custom','自定义 HTTP / HTTPS 代理']],l?.proxy?.mode || 'system')}</select></label><label class="field" id="l-proxy-address"><span>代理地址</span><input id="l-proxy-url" value="${esc(l?.proxy?.url || '')}" placeholder="http://127.0.0.1:7890"></label><p>${local ? '127.0.0.1 指当前电脑。' : '127.0.0.1 指服务器自身。'}支持 HTTP／HTTPS，无账号密码认证。</p></div><div id="location-test-result" class="hint"></div><div class="form-actions"><button type="button" id="location-test">${icon('refresh')}测试连接</button></div>${l&&!local&&!managed?`<section class="destructive-settings"><h3>危险操作</h3>${destructiveSetting('location-delete','删除位置','此位置将从列表移除。正在使用它的角色或项目需要先改用其他位置。')}</section>`:''}</form>`;
  const proxyValue = () => ({ mode: $('l-proxy-mode').value, url: $('l-proxy-url').value });
  $('l-proxy-mode').onchange = () => { $('l-proxy-address').hidden = $('l-proxy-mode').value !== 'custom'; }; $('l-proxy-mode').onchange();
  if (!local) {
    const syncControlFields = () => {
      $('l-mcp-fields').hidden = $('l-control').value !== 'windows-mcp';
      $('l-tunnel-fields').hidden = $('l-os').value !== 'linux';
    };
    $('l-control').onchange = syncControlFields;
    $('l-os').onchange = syncControlFields;
    syncControlFields();
    renderLocationTunnelStatus(l?.id);
  }
  const locationValue = () => ({
    id: l?.id, name: $('l-name').value, host: $('l-host').value.trim(), port: Number($('l-port').value),
    username: $('l-user').value.trim(), keyPath: $('l-key').value, passphrase: $('l-passphrase').value,
    os: $('l-os').value, control: $('l-control').value, mcpUrl: $('l-mcp').value,
    mcpToken: $('l-token').value, proxy: proxyValue(), ...($('l-os').value === 'linux' ? { mcpTunnel: { enabled: $('l-tunnel-enabled').checked, remotePort: Number($('l-tunnel-port').value || 18111), autoStart: $('l-tunnel-auto').checked, syncRemoteEnv: $('l-tunnel-sync').checked } } : {}),
  });
  const save = async () => local ? api['location-proxy-save'](l.id, proxyValue()) : api['location-save'](locationValue());
  $('location-form').onsubmit = e => { e.preventDefault(); action(async () => { const next = await save(); toast('位置已保存'); editLocation(locationOf(next.id)); }); };
  $('location-test').onclick = () => action(async () => { $('location-test-result').textContent = '正在连接…'; const next = await save(); const result = await api['location-test'](next.id); $('location-test-result').textContent = result; });
  if ($('location-mcp-start')) {
    $('location-mcp-start').onclick = () => {
      const form = $('location-form');
      if (!form.reportValidity()) return;
      action(async () => {
        $('location-tunnel-status').textContent = '正在连接 SSH、启动本机 Windows-MCP 并打通反向隧道…';
        $('location-mcp-start').disabled = true;
        try {
          const result = await api['location-mcp-start'](managed ? l.id : locationValue());
          state = await api.snapshot();
          toast('MCP 反向隧道已打通' + (result.status?.remotePort ? `（服务器 127.0.0.1:${result.status.remotePort}）` : ''));
          editLocation(locationOf(result.location.id));
        } finally {
          if ($('location-mcp-start')) renderLocationTunnelStatus(l?.id);
        }
      });
    };
  }
  if ($('location-mcp-stop')) {
    $('location-mcp-stop').onclick = () => action(async () => {
      if (!l?.id) return;
      await api['location-mcp-stop'](l.id);
      state = await api.snapshot();
      renderLocationTunnelStatus(l.id);
      toast('MCP 反向隧道已停止');
    });
  }
  if ($('location-mcp-revoke-directories')) {
    $('location-mcp-revoke-directories').onclick = () => action(async () => {
      if (!l?.id) return;
      await api['location-mcp-revoke-directories'](l.id);
      state = await api.snapshot();
      renderLocationTunnelStatus(l.id);
      toast('已收回远程 MCP 目录权限');
    });
  }
  if (!local && !managed) bindSshKeySetup(locationValue);
  if ($('location-delete')) $('location-delete').onclick = () => action(async () => { if (confirm('删除这个位置？')) { await api['location-delete'](l.id); editLocation(state.locations[0]); } });
}
function bindSshKeySetup(locationValue) {
  const form = $('location-form');
  const status = $('location-test-result');
  status.setAttribute('role', 'status');
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'location-setup-ssh-key';
  button.textContent = '配置免密登录';
  $('location-test').after(button);
  const os = $('l-os');
  const updateButton = () => { button.hidden = os.value !== 'linux'; };
  os.addEventListener('change', updateButton);
  updateButton();

  async function setup(value, password) {
    const controls = [...form.elements].filter(control => !control.disabled);
    for (const control of controls) control.disabled = true;
    status.textContent = password ? '正在配置并验证公钥登录…' : '正在检查本机 SSH 密钥…';
    try {
      const result = await api['location-setup-ssh-key'](value, password);
      if (!form.isConnected) return;
      if (result.needsPassword) {
        status.textContent = '';
        dialog(
          '<h2>输入 SSH 登录密码</h2><p>' + esc(value.username + '@' + value.host + ':' + value.port) +
          '</p><p>应用会用此密码登录一次，将公钥添加到这个账号。密码仅用于本次连接。</p>' +
          '<label class="field">服务器登录密码<input id="ssh-setup-password" type="password" autocomplete="off" maxlength="4096" required autofocus></label>',
          () => {
            const field = $('ssh-setup-password');
            const entered = field.value;
            field.value = '';
            $('dialog').close();
            void setup(value, entered);
            return false;
          },
          '配置免密登录',
        );
        const field = $('ssh-setup-password');
        $('dialog').addEventListener('close', () => { field.value = ''; }, { once: true });
        return;
      }
      editLocation(result.location);
      toast('SSH 免密登录已配置并通过验证。');
    } catch (error) {
      if (form.isConnected) status.textContent = '配置免密登录失败。' + uiError(error);
    } finally {
      for (const control of controls) control.disabled = false;
    }
  }

  button.onclick = () => {
    if (form.reportValidity()) void setup(locationValue());
  };
}
function renderAbout() {
  cliUpdatesView = claudeUpdateView = undefined;
  const version = state?.appVersion ? `v${esc(state.appVersion)}` : '';
  $('editor-view').innerHTML = `
    <section class="editor simple-form about-page" aria-labelledby="about-title">
      <header>
        <h1 id="about-title">关于</h1>
        <button type="button" id="about-github" class="icon-button" aria-label="在浏览器中打开 GitHub 仓库" title="在浏览器中打开 GitHub 仓库">${icon('brand-github')}</button>
      </header>
      <div class="setting-card about-intro">
        <div class="about-brand">
          <div class="group-avatar">${icon('message-circle')}</div>
          <div class="about-brand-text">
            <div class="about-title-row">
              <h2>AI 小队</h2>
              ${version ? `<span class="pill">${version}</span>` : ''}
            </div>
            <p class="about-subtitle">中文优先的多 AI 协作桌面工作台</p>
          </div>
        </div>
        <p class="about-summary">在同一个项目内组织多个 AI 角色单聊、接力讨论或按工作流分工，支持接入本机或 Linux VPS 上的 Claude Code、Codex CLI 等工具，并在工作台内直接查看项目文件与共享终端。</p>
        <p class="about-summary">对话记录、API 密钥和登录态均保存在本地。</p>
        <div class="about-links">
          <button type="button" id="about-repo-link" class="quiet about-repo-button">${icon('brand-github')}GitHub 仓库 · LevyDeng/ai-team${icon('external-link')}</button>
        </div>
      </div>
      <div class="setting-card about-notice" aria-labelledby="about-notice-title">
        <h3 id="about-notice-title" class="about-section-title">${icon('info-circle')}合规提示与免责声明</h3>
        <ul class="about-notice-list">
          <li><strong>仅作本地工作台</strong>：仅调用你自行安装的官方 CLI、官方协议入口（如 ACP）或官方 API；不内置、不代管、不转售账号，也不导出、复制或解密其他客户端登录凭据。</li>
          <li><strong>订阅账号编排风险</strong>：部分厂商对个人订阅账号接入第三方编排、多轮自动讨论或工作流有严格限制（如 Google Antigravity、Anthropic Claude 等均已收紧条款与风控），存在被限流、拦截或账号受限的风险，使用前请自行核对各厂商最新条款。</li>
          <li><strong>使用注意事项</strong>：多轮群聊、自动工作流或较高频率调用优先使用官方按量付费 API Key（或厂商允许的按量追加计费），谨慎用主力个人订阅跑重度自动编排；勿用于多人共享账号、号池轮询、商业转售或绕过限流；开启写文件、命令执行或桌面操控权限时请核对任务范围与目录。</li>
        </ul>
        <p class="hint">免责声明：本项目与 OpenAI、Anthropic、Google、Cursor、Moonshot、腾讯等任何模型或工具厂商均无官方合作、关联或背书。本软件按“现状”提供，用户需自行遵守所接入服务的条款及适用法律法规；因账号使用方式、额度消耗、API 计费、账号限流／封禁或命令执行产生的任何损失与后果，均由用户自行承担。</p>
      </div>
      <div class="setting-card about-support">
        <h3 class="about-support-title">${icon('heart')}支持与打赏</h3>
        <p class="about-summary">这是一个开源免费的个人项目。如果它帮你省下了一些时间和折腾成本，欢迎请作者喝杯咖啡，感谢每一份支持。</p>
        <p class="hint">打赏完全自愿，不影响任何功能使用。哪里用着不顺手，直接拉源码自己改改或提个 PR 就好；打开微信或支付宝「扫一扫」即可。</p>
        <div class="support-codes">
          <figure class="support-code">
            <figcaption>微信赞赏</figcaption>
            <img src="../assets/support/wechat-appreciation.png" width="720" height="720" alt="微信赞赏码">
          </figure>
          <figure class="support-code">
            <figcaption>支付宝收钱</figcaption>
            <img src="../assets/support/alipay-collection.webp" width="480" height="720" alt="支付宝收钱码">
          </figure>
        </div>
      </div>
    </section>`;
  const openRepo = () => action(() => api['workbench-support']());
  $('about-github').onclick = openRepo;
  $('about-repo-link').onclick = openRepo;
}
function renderSettings() {
  const themeList = window.deskThemes?.themes || [
    { id: 'system', label: '跟随系统', description: '随 Windows 浅色 / 深色自动切换', swatches: ['#ffffff', '#f4f5f7', '#17a74e'] },
    { id: 'light', label: '浅色', description: '清爽明亮的默认浅色界面', swatches: ['#ffffff', '#f4f5f7', '#17a74e'] },
    { id: 'dark', label: '深色（夜间模式）', description: '标准深灰夜间界面', swatches: ['#191d23', '#272f39', '#15803d'] },
  ];
  const swatches = themeList.map(theme => `<button type="button" class="theme-swatch" data-theme-choice="${theme.id}" aria-pressed="${state.settings.theme === theme.id}"><span class="theme-swatch-preview" aria-hidden="true">${theme.swatches.map(color => `<span style="background:${color}"></span>`).join('')}</span><span class="theme-swatch-text"><strong>${esc(theme.label)}</strong><small>${esc(theme.description)}</small></span></button>`).join('');
  $('editor-view').innerHTML = `<form class="editor simple-form" id="settings-form"><header><h1>通用设置</h1><button class="primary" type="submit">保存设置</button></header><div class="setting-card"><h3>运行与唤醒</h3><div class="checks"><label><input type="checkbox" id="s-awake" ${state.settings.keepAwake ? 'checked' : ''}>保持电脑唤醒（前台和后台）</label></div><p>防止自动休眠和屏保；手动锁屏仍由 Windows 管理。</p><label class="field"><span>同时运行的讨论上限</span><input id="s-limit" type="number" min="1" max="8" value="${state.settings.maxJobs}"></label><p>群聊中的角色依次发言。</p></div><div class="setting-card"><h3>外观</h3><label class="field"><span>界面主题</span><select id="s-theme">${options(themeList.map(theme => [theme.id, theme.label]), state.settings.theme)}</select></label><div class="theme-swatches" role="group" aria-label="主题色预设">${swatches}</div><p>切换后立即生效，提供护眼绿、暖纸米、雾霭蓝与低蓝光深色主题。</p></div><div class="form-actions"><span class="hint">设置保存后即时生效</span></div></form>`;
  $('settings-form').querySelector('.form-actions').insertAdjacentHTML('beforebegin','<section class="setting-card"><h3>AI 邀请</h3><div id="s-ai-invites"></div></section>');
  const readPolicy = window.deskCollaborationUI.policyEditor($('s-ai-invites'), 'global', state.settings);
  $('settings-form').onsubmit = e => { e.preventDefault(); action(async () => { await api.settings({ keepAwake: $('s-awake').checked, maxJobs: Number($('s-limit').value), theme: $('s-theme').value, aiInvites:readPolicy() }); toast('设置已保存'); }); };
  const applyThemeChoice = chosen => {
    $('s-theme').value = chosen;
    for (const button of $('editor-view').querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === chosen));
    }
    window.applyDeskTheme(chosen);
    return action(() => api.settings({ ...state.settings, theme: chosen }));
  };
  $('s-theme').onchange = () => applyThemeChoice($('s-theme').value);
  for (const button of $('editor-view').querySelectorAll('[data-theme-choice]')) {
    button.onclick = () => applyThemeChoice(button.dataset.themeChoice);
  }
  cliUpdatesView = claudeUpdateView = undefined;
}
function renderUpdateBadges() {
  const count = state.cliUpdates?.reminders ? state.cliUpdates.count : 0;
  for (const [id, label] of [['cli-nav-badge', '设置'], ['cli-settings-badge', '更新中心']]) {
    const badge = $(id);
    if (!badge) continue;
    badge.textContent = count || '';
    badge.hidden = !count;
    badge.closest('button').setAttribute('aria-label', count ? label + '，' + count + ' 个 CLI 有可用更新' : label);
  }
}
let appUpdate = { status: 'idle' };
function renderAppUpdate() {
  const status = $('app-update-status');
  if (!status) return;
  const version = appUpdate.version;
  status.textContent = appUpdate.error || {
    checking: '正在检查应用更新…',
    available: appUpdate.direct ? `发现新版 v${version}，可在应用内下载并安装。` : `发现新版 v${version}，可手动下载 ZIP。`,
    current: '目前没有可用的应用更新。',
    'no-release': 'GitHub 上暂无正式发布版本。',
    'no-package': '最新发布暂未提供 Windows x64 下载包。',
    downloading: '正在下载并校验更新包，请保持应用开启…',
    ready: `新版 v${version} 已准备好。安装时会保存数据、退出并重新启动。`,
    installing: '正在保存并退出，安装完成后将自动重新启动…',
    installed: `已更新到 v${version}。`,
    'rolled-back': `v${version} 未能安装，已恢复原版本。可以重新检查更新。`,
  }[appUpdate.status] || '';
  const busy = ['checking', 'downloading', 'installing'].includes(appUpdate.status);
  $('app-update-check').disabled = busy;
  $('app-update-download').hidden = appUpdate.status !== 'available';
  $('app-update-download').textContent = appUpdate.direct ? '下载更新' : '在浏览器中下载新版';
  $('app-update-install').hidden = appUpdate.status !== 'ready';
}

function renderUpdateCenter() {
  const source = state.appPackaged === false;
  $('editor-view').innerHTML = `<div class="editor simple-form cli-updates-page"><header><h1>更新中心</h1></header>
    <section class="setting-card" aria-labelledby="app-update-title">
      <h3 id="app-update-title">应用更新</h3>
      ${source ? '<p>当前从源码启动。通过 Git 同步代码后，重启应用即可使用更新。</p>' : `<p>当前版本 v${esc(state.appVersion)}</p>`}
      <div class="cli-update-actions">
        ${source ? '' : `<button type="button" id="app-update-check">检查应用更新</button>
        <button type="button" id="app-update-download" hidden>下载更新</button>
        <button type="button" id="app-update-install" hidden>更新并重启</button>`}
        <button type="button" id="app-update-release-page">查看 GitHub 发布页</button>
      </div>
      ${source ? '' : '<p class="hint" id="app-update-status" role="status"></p>'}
    </section>
    <div id="cli-updates"></div><div id="claude-updater"></div><p class="hint">包括 Claude Code、OpenCode、Cursor Agent、WorkBuddy 以及自定义 ACP 角色正在使用的 CLI，可在此检查并安装可用更新。</p></div>`;
  cliUpdatesView = window.createCliUpdatesView($('cli-updates'), {
    request: (verb, ...args) => api['cli-update-' + verb](...args),
    error: problem => toast(problem.message),
  });
  claudeUpdateView = window.createClaudeUpdateView($('claude-updater'), {
    request: operation => api['claude-cli'](operation), error: problem => toast(problem.message),
  });
  cliUpdatesView.render(state.cliUpdates);
  claudeUpdateView.render(state.claudeUpdate);
  $('app-update-release-page').onclick = () => action(() => api['app-update-release-page']());
  if (source) return;
  $('app-update-check').onclick = async () => {
    appUpdate = { status: 'checking' };
    renderAppUpdate();
    try { appUpdate = await api['app-update-check'](); }
    catch (error) { appUpdate = { status: 'idle', error: uiError(error) }; }
    renderAppUpdate();
  };
  $('app-update-download').onclick = async () => {
    if (!appUpdate.direct) { await action(() => api['app-update-download']()); return; }
    appUpdate = { ...appUpdate, status: 'downloading', error: '' };
    renderAppUpdate();
    try { await api['app-update-prepare'](); appUpdate.status = 'ready'; }
    catch (error) { appUpdate.status = 'available'; appUpdate.error = uiError(error); }
    renderAppUpdate();
  };
  $('app-update-install').onclick = async () => {
    appUpdate = { ...appUpdate, status: 'installing', error: '' };
    renderAppUpdate();
    try {
      if (!await api['app-update-install']()) appUpdate.status = 'ready';
    } catch (error) { appUpdate.status = 'ready'; appUpdate.error = uiError(error); }
    renderAppUpdate();
  };
  renderAppUpdate();
  if (appUpdate.status === 'idle' && !appUpdate.error) api['app-update-status']().then(({ result, version }) => {
    if (result && appUpdate.status === 'idle' && !appUpdate.error) {
      appUpdate = { status: result, version };
      renderAppUpdate();
    }
  }).catch(() => {});
}
function renderToolDirectory() { const select = $('tool-directory'); const previous = select.value; select.innerHTML = options((project()?.directories || []).map((d,i) => [i, (locationOf(d.locationId)?.name || d.locationId) + ' · ' + d.path]), previous || 0); }
let groupWorkflowEditor;
const groupWorkflowSelection = new Map();

async function saveGroupWorkflow(c,id,value) {
  const saved=await invokeWorkflow('group-save',c.id,id,value);
  groupWorkflowSelection.set(c.id,saved.id);
  state=await api.snapshot();
  if (chat()?.id===c.id) renderGroupWorkflows();
  toast('已保存工作流「'+saved.title+'」。');
  return saved;
}

function openGroupWorkflowDestination(graph) {
  const candidates=chats().filter(item=>!item.workflow&&!item.disbandedAt);
  const open=async target=>{
    await openConversationResult(target);
    if (graph) groupWorkflowSelection.set(target.id,'');
    await openTools('workflow');
    if (graph) mountGroupWorkflow(target,groupWorkflowEditor.key,graph,false);
  };
  if (!candidates.length) {
    openChat(undefined,undefined,target=>action(()=>open(target)));
    return;
  }
  if (candidates.length===1) {action(()=>open(candidates[0]));return;}
  dialog(`<h2>选择工作流所在群聊</h2><label>群聊<select id="group-workflow-destination">${options(candidates.map(item=>[item.id,item.name]))}</select></label>`,
    ()=>open(candidates.find(item=>item.id===$('group-workflow-destination').value)),'打开画板');
}

function mountGroupWorkflow(c, key, draft, readOnly) {
  const board=$('group-workflow-board');
  const p=project();
  const roles=state.roles.filter(role=>{
    const location=locationOf(role.locationId);
    return role.enabled!==false&&!usesExternalConversation(role.engine)&&p.directories.some(dir=>dir.locationId===role.locationId)&&
      (location?.type==='local'||location?.os==='linux'&&role.provider==='native');
  }).map(role=>({...role,location:locationOf(role.locationId).name,local:role.locationId==='local'}));
  const chats=state.chats.map(item=>({id:item.id,name:item.id===c.id?'本群 · '+item.name:
    (state.projects.find(project=>project.id===item.projectId)?.name||'')+' / '+item.name}));
  board.innerHTML=`<div class="graph-workspace"><div class="graph-toolbar">
    <button type="button" class="graph-add">添加角色</button>
    <button type="button" class="graph-fit">适应画布</button>
    <button type="button" class="graph-zoom-out" aria-label="缩小画布">−</button>
    <button type="button" class="graph-zoom-in" aria-label="放大画布">+</button>
  </div><div class="graph-canvas" aria-label="工作流画布"></div></div><div class="graph-inspector"></div>`;
  const read=window.deskGraphWorkflow.mount(board,roles,draft,{chats,readOnly});
  board.querySelector('.graph-fit').onclick=read.fit;
  $('group-workflow-title').value=draft.title||'';
  groupWorkflowEditor={key,read};
  requestAnimationFrame(()=>{if(groupWorkflowEditor?.read===read&&!board.closest('[hidden]')) read.fit();});
}

function renderGroupWorkflows() {
  const c=chat(), section=$('workflow-tools'), picker=$('group-workflow-select');
  const available=c&&!c.workflow&&!c.disbandedAt;
  for (const element of section.children) element.hidden=!available;
  if (!available) {
    $('tools-title').textContent='工作流 · 请打开群聊';
    return;
  }
  $('tools-title').textContent='群聊工作流';
  const definitions=c.workflowDefinitions||[];
  const active=c.workflowRuns?.find(run=>['queued','running'].includes(run.status));
  const id=groupWorkflowSelection.get(c.id)??active?.definitionId??definitions[0]?.id??'';
  const definition=definitions.find(item=>item.id===id);
  const run=definition&&c.workflowRuns?.findLast(item=>item.definitionId===definition.id);
  const readOnly=Boolean(active&&run===active);
  const resumable=run&&['paused','needs_check','unavailable'].includes(run.status);
  const isGraph=!definition||!['generated','teams'].includes(definition.type);
  const templatePicker=$('group-workflow-template');
  const updateOptions=(element,items,value)=>{
    const content=options(items,value);
    if (element._options!==content) {
      element.innerHTML=content;
      element._options=content;
    }
    element.value=value;
  };
  updateOptions(picker,[['','新工作流'],...definitions.map(item=>[item.id,item.title])],definition?.id||'');
  const templates=(state.workflowTemplates||[]).map(item=>[item.id,item.title]);
  updateOptions(templatePicker,[['','选择模板'],...templates],templates.some(([id])=>id===templatePicker.value)?templatePicker.value:'');
  $('group-workflow-load').disabled=!templatePicker.value;
  const key=JSON.stringify([c.id,definition?.id,readOnly?run.id:null]);
  $('group-workflow-board').hidden=!isGraph;
  const plan=$('group-workflow-plan');
  plan.hidden=isGraph;
  if (isGraph&&groupWorkflowEditor?.key!==key) mountGroupWorkflow(c,key,readOnly?run:definition||{structured:true},readOnly);
  const progress=readOnly&&run.frames?.length?run.frames:readOnly&&run.nodes?.[run.nodeIndex]?[{nodeId:run.nodes[run.nodeIndex].id}]:[];
  if (isGraph) groupWorkflowEditor.read.setProgress(progress);
  else {
    $('group-workflow-title').value=definition.title;
    const shown=readOnly?run:definition;
    const steps=shown.type==='generated'?shown.nodes.map(node=>node.title):[
      '执行 · '+shown.teams.implement.map(id=>role(id)?.name||'原角色不可用').join('、'),
      '验收 · '+shown.teams.review.map(id=>role(id)?.name||'原角色不可用').join('、'),
    ];
    const current=readOnly?(shown.type==='generated'?shown.nodeIndex:Number(shown.stage==='review')):-1;
    plan.innerHTML=`<ol>${steps.map((title,index)=>`<li ${index===current?'aria-current="step"':''}>${esc(title)}</li>`).join('')}</ol>
      <button type="button" ${readOnly?'disabled':''}>编辑工作流</button>`;
    plan.querySelector('button').onclick=()=>shown.type==='generated'
      ?openGeneratedWorkflow(project(),{groupTarget:c,definition})
      :openWorkflow(undefined,{groupTarget:c,definition});
  }
  const labels={queued:'排队中',running:'运行中',paused:'已暂停',needs_check:'待检查',unavailable:'角色不可用',
    complete:'已完成',unresolved:'未解决',round_limit:'已达轮次上限'};
  const step=run?.attempts?.at(-1);
  const path=step?.path?.map(node=>node.title+(node.round?' · 第 '+node.round+' 轮':'')).join(' / ');
  const status=run?[state.running[c.id]?.stopping&&readOnly?'正在停止…':labels[run.status],path,
    run.reason&&(workflowMessages.get(run.reason)||uiError(run.reason)),
    run.stopUnconfirmed?'进程停止尚未确认。请先检查任务输出和相关进程。':''].filter(Boolean).join('\n'):
    definition?'已保存，等待启动。':'填写节点和连线后保存，启动时再填写任务目标。';
  $('group-workflow-state').textContent=[status,definition?.maxSteps?'最多 '+definition.maxSteps+' 个执行步骤':''].filter(Boolean).join('\n');
  $('group-workflow-title').disabled=readOnly||!isGraph;
  $('group-workflow-save').hidden=!isGraph;
  $('group-workflow-template-save').hidden=!isGraph;
  $('group-workflow-save').disabled=readOnly;
  $('group-workflow-template-save').disabled=readOnly;
  $('group-workflow-start').hidden=readOnly||Boolean(resumable);
  $('group-workflow-start').disabled=!definition||Boolean(active||state.inputBusy[c.id]);
  $('group-workflow-stop').hidden=!readOnly;
  $('group-workflow-stop').disabled=Boolean(state.running[c.id]?.stopping);
  $('group-workflow-resume').hidden=!resumable;
  $('group-workflow-resume').disabled=Boolean(active||state.inputBusy[c.id]||run?.stopUnconfirmed);
  $('group-workflow-finish').hidden=!resumable;
  $('group-workflow-finish').disabled=Boolean(active||run?.stopUnconfirmed);
  $('group-workflow-confirm').hidden=!run?.stopUnconfirmed;
  const select = selected=>{
    groupWorkflowSelection.set(c.id,selected);
    groupWorkflowEditor=undefined;
    renderGroupWorkflows();
  };
  picker.onchange=()=>select(picker.value);
  $('group-workflow-new').onclick=()=>select('');
  $('group-workflow-generate').onclick=()=>openGeneratedWorkflow(project(),{groupTarget:c});
  $('group-workflow-teams').onclick=()=>openWorkflow(undefined,{groupTarget:c});
  templatePicker.onchange=()=>{$('group-workflow-load').disabled=!templatePicker.value;};
  $('group-workflow-load').onclick=()=>{
    const template=(state.workflowTemplates||[]).find(item=>item.id===templatePicker.value);
    if (!template) return;
    select('');
    mountGroupWorkflow(c,groupWorkflowEditor.key,template,false);
  };
  const value=()=>({...groupWorkflowEditor.read(),title:$('group-workflow-title').value});
  $('group-workflow-save').onclick=()=>action(()=>saveGroupWorkflow(c,definition?.id,value()));
  $('group-workflow-template-save').onclick=()=>action(async()=>{
    const saved=await invokeWorkflow('template-save',value());
    toast('已保存模板「'+saved.title+'」。');
  });
  $('group-workflow-start').onclick=()=>{
    dialog(`<h2>启动工作流</h2>
      <p class="hint">使用已保存的工作流版本，并在启动时读取群聊上文。目标留空时使用本群上文。</p>
      <label>本次任务目标<textarea id="group-workflow-goal" rows="4" maxlength="16000"></textarea></label>`,async()=>{
      const goal=$('group-workflow-goal').value, at=readSchedule();
      if(at){await api['schedule-workflow'](c.id,definition.id,goal,at);toast('已安排定时启动');}
      else await invokeWorkflow('group-start',c.id,definition.id,goal);
    },'启动');
    const readSchedule=workflowScheduleOptions($('dialog-body'));
  };
  $('group-workflow-stop').onclick=()=>action(()=>invokeWorkflow('group-stop',c.id,run.id));
  $('group-workflow-resume').onclick=()=>dialog(`<h2>继续工作流</h2><p class="hint">沿用启动时的定义和群聊上文。已有可用结果时会沿唯一出口继续。</p>
    <label>补充说明（可选）<textarea id="group-workflow-guidance" rows="4" maxlength="16000"></textarea></label>`,
    ()=>invokeWorkflow('group-resume',c.id,run.id,$('group-workflow-guidance').value),'继续');
  $('group-workflow-finish').onclick=()=>{
    if(confirm('将这次运行标记为未解决，并把步骤和结果纳入群聊上下文？')) action(()=>invokeWorkflow('group-finish',c.id,run.id));
  };
  $('group-workflow-confirm').onclick=()=>{
    if(confirm('已检查并确认此节点的进程结束？')) action(()=>invokeWorkflow('group-confirm-stop',c.id,run.id));
  };
}

async function openTools(mode, directoryIndex) {
  if (!project()) return;
  toolMode = mode;
  $('tools-panel').hidden = false;
  $('tools-rail').hidden = true;
  $('terminal-tools').hidden = mode !== 'terminal';
  $('file-tools').hidden = mode !== 'files';
  $('activity-tools').hidden = mode !== 'activity';
  $('workflow-tools').hidden = mode !== 'workflow';
  $('tool-directory').hidden = mode === 'activity' || mode === 'workflow';
  $('tools-title').textContent = ({terminal:'项目终端',files:'项目文件',activity:'对话任务输出',workflow:'群聊工作流'})[mode];
  if (mode === 'workflow') {
    if (directoryIndex && chat()) groupWorkflowSelection.set(chat().id,directoryIndex);
    renderGroupWorkflows();
    return;
  }
  renderToolDirectory();
  if (mode === 'files') {
    if (directoryIndex !== undefined) $('tool-directory').value = String(directoryIndex);
    await loadFiles();
  } else if (mode === 'activity') {
    agentTerminals=await api['agent-terminals']();
    renderActivity();
  } else {
    await refreshTerminals();
    if (!terminals.some(t => t.projectId === projectId)) toast('点击加号打开此项目的共享终端');
    fitTerminal();
  }
}
let activityRuns, activityRequest = 0;
async function renderActivity() {
  const c = chat();
  const request = ++activityRequest;
  const interactive=activityMode==='interactive';
  const names = new Map((c?.roleIds || []).map(id=>[id,role(id)?.name || id]));
  const activeRole = state.running[c?.id]?.roleId;
  let entries = [];
  if (!interactive && c) {
    try {
      if (activityRuns?.id !== c.id || activityRuns.revision !== c.historyVersion) {
        const list = await api['chat-runs'](c.id);
        if (request !== activityRequest || c.id !== chat()?.id) return;
        activityRuns = { id: c.id, revision: c.historyVersion, list };
      }
      entries = activityRuns.list;
    } catch (error) {
      if (request === activityRequest) toast('无法加载任务列表。' + uiError(error));
      return;
    }
  }
  if (!interactive) {
    for (const message of entries) {
      if (message.kind==='assistant' && message.roleId && !names.has(message.roleId)) {
        names.set(message.roleId,role(message.roleId)?.name || message.roleName || message.roleId);
      }
    }
    if (activeRole && !names.has(activeRole)) names.set(activeRole,role(activeRole)?.name || activeRole);
  }
  if (!names.has(activityRoleId)) {
    activityRoleId = names.has(activeRole) ? activeRole : names.keys().next().value;
    activityRunId = undefined;
  }
  $('activity-role').innerHTML = options([...names],activityRoleId);
  $('activity-mode').value=activityMode;$('activity-host').hidden=interactive;$('agent-terminal-host').hidden=!interactive;$('activity-run').hidden=interactive;
  $('agent-terminal-start').hidden=!interactive;$('agent-terminal-end').hidden=!interactive;
  if($('agent-terminal-active-log'))$('agent-terminal-active-log').hidden=true;
  if(interactive){renderAgentTerminal();return;}
  $('activity-hint').textContent='选中文字后 Ctrl+C 或右键复制；点击路径链接打开文件。可切换到交互终端操作 Claude / Codex。';
  const runs = entries.filter(m => m.roleId === activityRoleId);
  if (activityFollow || !runs.some(m => m.id === activityRunId)) activityRunId = runs.at(-1)?.id;
  $('activity-run').innerHTML = options(runs.slice().reverse().map(m => [m.id, new Date(m.at).toLocaleTimeString('zh-CN') + ' · ' +
    (isWorkflowStepTimeout(c, m) ? '超时中断' : ({ running:'运行中', complete:'完成', failed:'失败', cancelled:'暂停', interrupted:'中断' }[m.status] || m.status))]),activityRunId);
  if (!activityView) {
    const element = document.createElement('div'); element.className = 'terminal-container'; $('activity-host').append(element);
    const term = new Terminal({ fontSize:14, fontFamily:'Cascadia Mono, Consolas, monospace', theme:{ background:'#18202a', foreground:'#e0e8ed' }, disableStdin:true, convertEol:true, scrollback:8000, cursorBlink:false });
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(element);
    window.relayTerminalUI.installCopy(term,element,{copy:text=>api.copy(text),readOnly:true,error:e=>toast(e.message)});
    window.relayTerminalUI.installLinks(term,{openPath:value=>openPathReference(value,chat()?.projectId,{chatId,messageId:activityRunId}),openLink:value=>api.open(value,chat()?.projectId),error:e=>toast(e.message)});
    activityView = { term,fit,source:'',output:'' };
  }
  const message = runs.find(m => m.id === activityRunId);
  let log = '此对话还没有任务输出。';
  if (message) {
    try { log = await api['message-details'](c.id, message.id, 'terminal') || '正在等待 CLI 输出…'; }
    catch (error) { log = '无法读取任务输出。' + uiError(error); }
  }
  if (request !== activityRequest || c?.id !== chat()?.id || $('tools-panel').hidden) return;
  const output = message && isWorkflowStepTimeout(c, message) ? workflowStepTimeoutText + '\r\n\r\n' + log : log;
  const source = c?.id + ':' + activityRunId;
  if (activityView.source !== source || !output.startsWith(activityView.output)) { activityView.term.reset(); activityView.term.write(output); }
  else if (output !== activityView.output) activityView.term.write(output.slice(activityView.output.length));
  activityView.source = source; activityView.output = output; fitTerminal();
}
function selectedAgentTerminal(){const matches=agentTerminals.filter(t=>t.chatId===chatId&&t.roleId===activityRoleId);return matches.findLast(t=>t.state!=='ended')||matches.at(-1);}
function renderAgentTerminal(){
  for(const [id,view] of agentTerminalViews)if(!agentTerminals.some(t=>t.id===id)){view.term.dispose();view.element.remove();agentTerminalViews.delete(id);}
  const current=selectedAgentTerminal(),supported=['claude','codex'].includes(role(activityRoleId)?.engine),active=current&&current.state!=='ended';
  const job=state.running[chatId],pending=terminalConnectPending.has(chatId+':'+activityRoleId),jobName=role(job?.roleId)?.name||'其他角色';
  const blocked=chat()?.disbandedAt?'群聊已解散，聊天记录只读。':role(activityRoleId)?.enabled===false?'请先启用此角色，再打开交互终端。':!supported?'此角色暂不支持交互终端。请使用任务日志或项目终端。':pending||current?.state==='opening'?'正在建立交互连接，请稍候。':active?'此角色的交互终端已连接。':job?'本对话正在由 '+jobName+(job.stopping?' 停止任务':' 执行'+(job.phase==='compact'?'历史压缩':job.phase==='review'?'讨论判断':'任务'))+'，暂不能另开交互终端。请等待结束，或在聊天区暂停任务后连接。':'';
  $('agent-terminal-start').disabled=Boolean(blocked);
  $('agent-terminal-start').title=blocked||'打开所选角色的交互终端。';
  $('agent-terminal-start').textContent=pending||current?.state==='opening'?'正在连接…':active?'已连接':'建立连接';
  $('agent-terminal-end').disabled=!active;
  $('agent-terminal-end').title=active?'结束所选角色的交互连接。':'此角色尚未建立交互连接。';
  $('activity-hint').textContent=blocked&&!active?blocked:'终端与聊天同步。原生命令和审批请在终端操作；退出 App 将结束进程。Ctrl+Shift+C／V 复制粘贴。';
  let inspect=$('agent-terminal-active-log');if(!inspect){inspect=document.createElement('button');inspect.id='agent-terminal-active-log';inspect.type='button';inspect.className='quiet';$('activity-hint').insertAdjacentElement('afterend',inspect);}
  inspect.hidden=!job||Boolean(active);inspect.textContent='查看 '+jobName+' 的任务日志';inspect.onclick=()=>{activityRoleId=job.roleId;activityMode='log';activityFollow=true;renderActivity();};
  for(const [id,view] of agentTerminalViews){view.element.hidden=id!==current?.id;view.term.options.disableStdin=id!==current?.id||current.state!=='ready';}
  if(!current){$('agent-terminal-empty')?.remove();const empty=document.createElement('p');empty.id='agent-terminal-empty';empty.className='hint';empty.textContent=blocked||'点击“建立连接”打开交互终端。';$('agent-terminal-host').append(empty);return;}
  $('agent-terminal-empty')?.remove();
  let view=agentTerminalViews.get(current.id);
  if(!view){
    const element=document.createElement('div');element.className='terminal-container';$('agent-terminal-host').append(element);
    const term=new Terminal({fontSize:14,fontFamily:'Cascadia Mono, Consolas, monospace',theme:{background:'#18202a',foreground:'#e0e8ed'},cursorBlink:true,scrollback:8000,disableStdin:current.state!=='ready'});
    const fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(element);
    let screenTimer;term.onWriteParsed(()=>{clearTimeout(screenTimer);screenTimer=setTimeout(()=>{
      const b=term.buffer.active,lines=[];for(let n=b.baseY;n<Math.min(b.length,b.baseY+term.rows);n++)lines.push(b.getLine(n)?.translateToString(true)||'');
      api['agent-terminal-screen'](current.id,lines.join('\n').slice(-30000)).catch(()=>{});
    },120);});
    term.onData(value=>api['agent-terminal-input'](current.id,value).catch(e=>toast(e.message)));
    term.onResize(({cols,rows})=>api['agent-terminal-resize'](current.id,cols,rows).catch(e=>toast(e.message)));
    window.relayTerminalUI.installCopy(term,element,{copy:text=>api.copy(text),readClipboard:()=>api['clipboard-text'](),error:e=>toast(e.message)});
    window.relayTerminalUI.installLinks(term,{openPath:value=>openPathReference(value,current.projectId),openLink:value=>api.open(value,current.projectId),error:e=>toast(e.message)});
    term.write(current.output||'');view={element,term,fit,sequence:current.sequence||0};agentTerminalViews.set(current.id,view);
  }
  view.element.hidden=false;view.term.options.disableStdin=current.state!=='ready';fitTerminal();
}
async function refreshTerminals() { terminals = await api.terminals(); refreshTerminalTabs(); }
function refreshTerminalTabs() {
  const list = terminals.filter(t => t.projectId === projectId);
  if (!list.some(t => t.id === terminalId)) terminalId = list[0]?.id;
  $('terminal-list').innerHTML = options(list.map(t => [t.id, (t.kind === 'local' ? 'Windows' : 'Linux') + ' ' + t.number + (t.state === 'ended' ? ' · 已结束' : '')]), terminalId);
  for (const info of list) ensureTerminal(info);
  for (const [id, view] of terminalViews) view.element.hidden = id !== terminalId;
  fitTerminal();
}
function ensureTerminal(info) {
  if (terminalViews.has(info.id)) return terminalViews.get(info.id);
  const element = document.createElement('div'); element.className = 'terminal-container'; $('terminal-host').append(element);
  const term = new Terminal({ fontSize: 13, fontFamily: 'Cascadia Mono, Consolas, monospace', theme: { background: '#18202a', foreground: '#e0e8ed' }, cursorBlink: true, scrollback: 5000 }); const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(element);
  term.onData(value => api['terminal-input'](info.id,value)); term.onResize(({cols,rows}) => api['terminal-resize'](info.id,cols,rows));
  window.relayTerminalUI.installCopy(term,element,{copy:text=>api.copy(text),readClipboard:()=>api['clipboard-text'](),error:e=>toast(e.message)});
  window.relayTerminalUI.installLinks(term,{openPath:value=>openPathReference(value,info.projectId),openLink:value=>api.open(value,info.projectId),error:e=>toast(e.message)});
  if (info.output) term.write(info.output); const view = { element, term, fit, sequence: info.sequence || 0 }; terminalViews.set(info.id,view); return view;
}
function fitTerminal() { requestAnimationFrame(() => { if (!$('tools-panel').hidden) try { if (toolMode === 'terminal') terminalViews.get(terminalId)?.fit.fit(); else if (toolMode === 'activity') {if(activityMode==='interactive')agentTerminalViews.get(selectedAgentTerminal()?.id)?.fit.fit();else activityView?.fit.fit();} } catch {} }); }
async function loadFiles(operation = 'list', parts) {
  const request = ++fileRequest;
  const targetProject = projectId;
  const directoryIndex = Number($('tool-directory').value);
  const directory = project()?.directories[directoryIndex];
  if (!fileView || fileView.projectId !== targetProject || fileView.directoryIndex !== directoryIndex ||
      fileView.directory.path !== directory?.path || fileView.directory.locationId !== directory?.locationId) {
    fileView = undefined;
    $('file-list').replaceChildren();
    $('file-path').textContent = '';
    $('file-preview').hidden = true;
    $('file-back').hidden = $('file-open').hidden = $('file-explorer').hidden = true;
    $('file-up').disabled = true;
  }
  if (!directory) return;
  const targetParts = parts ?? fileView?.parts ?? [];
  const result = await api.files(targetProject, directoryIndex, targetParts, operation);
  if (request !== fileRequest || projectId !== targetProject) return;

  const listing = operation === 'list';
  const local = directory.locationId === 'local';
  const explore = relativeParts => action(() => api['file-explorer'](targetProject, directoryIndex, relativeParts));
  fileView = {projectId:targetProject, directoryIndex, directory, parts:targetParts, operation};
  $('file-path').textContent = result.path;
  $('file-list').hidden = !listing;
  $('file-preview').hidden = $('file-back').hidden = $('file-open').hidden = listing;
  $('file-up').disabled = !targetParts.length;
  $('file-explorer').hidden = !local;
  $('file-explorer').onclick = () => explore(targetParts);
  $('file-open').textContent = local ? '系统打开' : '复制远端路径';
  $('file-open').onclick = () => action(async () => {
    if (local) await openPathReference(result.path, targetProject);
    else { await api.copy(result.path); toast('已复制远端路径'); }
  });
  if (!listing) {
    $('file-preview').textContent = result.binary ? '二进制文件暂不支持文本预览。' : result.text + (result.truncated ? '\n\n[预览已截断]' : '');
    return;
  }

  const entries = result.entries.sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  const list = $('file-list');
  list.innerHTML = entries.map((entry, index) => {
    const name = esc(entry.name);
    const reveal = local ? `<button type="button" class="icon-button file-reveal" data-reveal-file="${index}" title="在资源管理器中打开" aria-label="在资源管理器中打开 ${name}">${icon('external-link')}</button>` : '';
    return `<div class="file-entry"><button type="button" class="file-row" data-file="${index}" title="${name}">${icon(entry.directory ? 'folder' : 'file')}<span>${name}</span></button>${reveal}</div>`;
  }).join('');
  for (const button of list.querySelectorAll('[data-file]')) {
    const entry = entries[Number(button.dataset.file)];
    button.onclick = () => action(() => loadFiles(entry.directory ? 'list' : 'read', [...targetParts, entry.name]));
  }
  for (const button of list.querySelectorAll('[data-reveal-file]')) {
    const entry = entries[Number(button.dataset.revealFile)];
    button.onclick = () => explore([...targetParts, entry.name]);
  }
  if (result.truncated) toast('目录文件较多，仅显示前 600 项');
}
function attachmentError(error){
  const value=String(error.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');
  const queueErrors={'The input queue is full (20 messages). Remove an entry before sending.':'待发送队列已满（20 条），请先移除一些消息；本次输入已保留。','Clear the current draft before restoring a queued message.':'请先处理输入框中的文字和附件，再编辑排队消息；两边的内容均已保留。','This message is being submitted. Wait a moment.':'这条消息正在提交，请稍候。','Wait for the pending message to finish submitting before interrupting.':'正在提交一条消息，请稍候再插队。','This queued message no longer exists.':'这条消息已经发送或移除了。','This agent is not ready to interrupt. The queued message is preserved.':'当前 Agent 还不能确认中断，消息已留在队列中。'};
  if(queueErrors[value])return queueErrors[value];
  const messages={'Choose a readable local file path.':'无法读取文件的本机路径，请重新拖入或选择文件。','The attached file is unavailable. Remove it and add it again.':'附件已移动、删除或无法访问，请移除后重新添加；输入内容已保留。','The attached file changed. Remove it and add it again.':'附件添加后发生了变化，请移除后重新添加；输入内容已保留。','Only files can be attached; folders are not supported.':'暂不支持添加文件夹，请选择文件。','Each attachment must be at most 16 MiB.':'单个附件不能超过 16 MiB。','Attach at most 8 files per message.':'每条消息最多添加 8 个附件。','Attachments must total at most 32 MiB.':'每条消息的附件总大小不能超过 32 MiB。','Attachment references expired. Add the files again.':'附件引用已失效，请重新添加；输入内容已保留。'};
  return messages[value]||value;
}
function attachmentCards(container,files,{remove,projectId:targetProjectId}={}){
  container.replaceChildren();
  for(const file of files){
    const card=document.createElement('div');card.className='attachment-card';card.dataset.attachmentId=file.id;
    const open=document.createElement('button');open.type='button';open.className='attachment-open';open.title=file.path;open.setAttribute('aria-label','打开 '+file.name);
    const image=document.createElement('img');image.alt='';image.src=file.kind==='clipboard-image'&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(file.thumbnail||'')?file.thumbnail:'icons/file.svg';image.className=file.kind==='clipboard-image'?'attachment-thumbnail':'attachment-icon';
    const details=document.createElement('span');details.className='attachment-details';const name=document.createElement('strong');name.textContent=file.kind==='clipboard-image'?'剪贴板图片':file.name;
    const meta=document.createElement('small');const size=file.sizeBytes<1024?file.sizeBytes+' B':file.sizeBytes<1048576?(file.sizeBytes/1024).toFixed(1)+' KiB':(file.sizeBytes/1048576).toFixed(1)+' MiB';meta.textContent=(file.width?file.width+'×'+file.height+' · ':'')+size+' · 本机路径';details.append(name,meta);open.append(image,details);open.onclick=()=>action(()=>openPathReference(file.path,targetProjectId));
    const copy=document.createElement('button');copy.type='button';copy.className='attachment-copy';copy.innerHTML=icon('copy');copy.title='复制文件路径';copy.setAttribute('aria-label','复制 '+file.name+' 的路径');copy.onclick=()=>action(async()=>{await api.copy(file.path);toast('已复制文件路径');});card.append(open,copy);
    if(remove){const button=document.createElement('button');button.type='button';button.className='attachment-remove';button.innerHTML=icon('x');button.title='移除附件';button.setAttribute('aria-label','移除 '+file.name);button.onclick=()=>action(()=>remove(file.id));card.append(button);}
    container.append(card);
  }
}
function renderSteerButton(){
  const c=chat(),{roleIds,content}=composerRecipients();
  const button=$('steer-send');
  button.hidden=!c||roleIds.length!==1||!agentTerminals.some(t=>t.chatId===c.id&&t.roleId===roleIds[0]&&t.state==='ready'&&t.steerReady);
  button.disabled=!content||Boolean(c?.draftAttachments?.length||attachmentTasks.get(c?.id)||sendingChats.has(c?.id));
}
function renderAttachments(){
  const c=chat(),files=c?.draftAttachments||[],pending=attachmentTasks.get(c?.id)||0;
  attachmentCards($('attachments'),files,{projectId:c?.projectId,remove:async id=>{try{const next=await api['attachment-remove'](c.id,id);const current=state.chats.find(item=>item.id===c.id);if(current)current.draftAttachments=next;if(chatId===c.id)renderAttachments();}catch(e){toast(attachmentError(e));}}});
  $('attachments').hidden=!files.length&&!pending;
  if(files.length||pending){const hint=document.createElement('small');hint.className='attachment-hint';hint.textContent=pending?'正在添加附件…':'仅发送文件路径，不上传原文件 · 最多 8 个，单个 16 MiB';$('attachments').append(hint);}
  const available = c?.roleIds.some(roleEnabled);
  $('input').placeholder = c && !available ? '此对话没有已启用的角色。可先撰写草稿。' : '发送消息，输入 @ 选择发言角色…';
  $('send').disabled=Boolean(pending||sendingChats.has(c?.id)||!available);
  $('interrupt-send').disabled=$('send').disabled;
  renderSteerButton();
}
async function attachmentTask(id,task){
  attachmentTasks.set(id,(attachmentTasks.get(id)||0)+1);if(chatId===id)renderAttachments();
  try{const files=await task();const current=state.chats.find(c=>c.id===id);if(current)current.draftAttachments=files;if(chatId===id){renderAttachments();$('input').focus();}toast(chatId===id?'附件已就绪，仅发送本机路径':'已为“'+(current?.name||'原对话')+'”添加附件');}
  catch(e){toast(attachmentError(e));}
  finally{const remaining=(attachmentTasks.get(id)||1)-1;if(remaining)attachmentTasks.set(id,remaining);else attachmentTasks.delete(id);if(chatId===id)renderAttachments();}
}
async function insertPaths(paths,id=chatId){if(!paths.length)return;if(page!=='projects'||!state.chats.some(c=>c.id===id)){toast('请先选择一个对话再添加附件');return;}await attachmentTask(id,()=>api['attachment-stage'](id,paths));}
async function chooseFiles(){const id=chatId;if(!chat()){toast('请先选择一个对话');return;}const paths=await api.pick('files');await insertPaths(paths,id);}
async function pasteImage(){const id=chatId;if(!chat()){toast('请先选择一个对话');return;}await attachmentTask(id,()=>api.image(id));}
async function restoreInput(id,messageId){
  clearTimeout(draftTimer);
  try{const result=await api['attachment-restore'](id,messageId),current=state.chats.find(c=>c.id===id);if(current){current.draft=result.text;current.draftAttachments=result.attachments;}if(chatId===id){$('input').value=result.text;renderAttachments();mentions.close();quickSettings();renderSpeakingOrder();$('input').focus();}toast('已恢复文字和附件，请核对后发送');}catch(e){toast(attachmentError(e));}
}
document.querySelectorAll('[data-page]').forEach(b => { b.onclick = () => showPage(b.dataset.page); });
$('empty-create').onclick = () => filter==='workflow'?openGroupWorkflowDestination():openChat(); $('chat-settings').onclick = () => openChat(chat());
$('dialog-cancel').onclick = $('dialog-close').onclick = () => $('dialog').close();
$('dialog').addEventListener('close', () => { usageCenter?.destroy();usageCenter=undefined;chatModelPicker?.destroy(); chatModelPicker = undefined;markReadAtBottom(); });
$('dialog-form').onsubmit = e => { e.preventDefault(); action(async () => { if (await dialogSubmit() !== false) $('dialog').close(); }); };
$('history-pages').insertAdjacentHTML('beforebegin','<details class="input-queue" id="scheduled-tasks" open hidden><summary id="scheduled-tasks-title"></summary><div id="scheduled-tasks-list"></div></details>');
$('attachments').insertAdjacentHTML('afterend','<div id="draft-schedule" hidden><span>定时发送</span><button type="button" id="draft-schedule-time" class="quiet" aria-label="修改定时发送时间"></button><button type="button" id="draft-schedule-clear" class="icon-button" aria-label="移除定时发送时间">'+icon('x')+'</button></div>');
const sendButton=$('send'), sendSplit=document.createElement('div');sendSplit.className='send-split';
sendButton.before(sendSplit);sendSplit.append(sendButton);
sendSplit.insertAdjacentHTML('beforeend','<button type="button" id="send-options" aria-label="发送选项" aria-expanded="false" aria-controls="send-options-menu">'+icon('chevron-down')+'</button><div id="send-options-menu" hidden><button type="button" id="send-schedule">定时发送</button></div>');
$('send-options').onclick=()=>{
  if(!$('send-options-menu').hidden){closeSendOptions();return;}
  $('send-options-menu').hidden=false;$('send-options').setAttribute('aria-expanded','true');$('send-schedule').focus();
};
sendSplit.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('send-options-menu').hidden){event.stopPropagation();closeSendOptions();$('send-options').focus();}});
document.addEventListener('pointerdown',event=>{if(!sendSplit.contains(event.target))closeSendOptions();});
$('send-schedule').onclick=$('draft-schedule-time').onclick=openDraftSchedule;
$('draft-schedule-clear').onclick=()=>{draftSchedules.delete(chatId);renderScheduleSelection(chat());$('input').focus();};
$('send').onclick = () => send();
$('end-task').onclick = () => action(() => api.pause(chatId));
$('interrupt-send').onclick=()=>send(false,'interrupt');
$('steer-send').onclick=()=>send(false,'steer');
$('queue-resume').onclick=()=>{
  const id=chatId,target=state.forceStops?.[id];
  if(!target?.unconfirmed||confirm('上一个后台任务尚未确认结束。请在系统中确认它已经结束，再继续发送队列中的消息。'))action(()=>api['queue-resume'](id,target?.unconfirmed?target.id:undefined));
};
$('queue-pause').onclick=()=>action(()=>api['queue-pause'](chatId));
$('rounds').oninput = renderDiscussion;
$('rounds').onchange = () => action(saveDiscussionSettings);
$('auto-stop').onchange = () => { renderDiscussion(); action(saveDiscussionSettings); };
$('input').onkeydown = e => { if (skillCommands.keydown(e)||mentions.keydown(e)) { e.preventDefault(); return; } if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !e.ctrlKey && !e.altKey) { e.preventDefault(); send(); } };
$('input').oninput = () => { const id = chatId, text = $('input').value;skillCommands.update(); mentions.update(true); const target = composerRecipients().roleIds.join(','); if (target !== composerTargetKey) { composerTargetKey = target; quickSettings(); } renderSpeakingOrder(); clearTimeout(draftTimer); if (chat()) chat().draft = text; draftTimer = setTimeout(() => api.draft(id,text).catch(e => toast(e.message)),350); };
$('input').addEventListener('paste', e => { if ([...(e.clipboardData?.items || [])].some(x => x.type.startsWith('image/'))) { e.preventDefault(); action(pasteImage); } });
$('quick-model').onchange = () => {const r=quickRole();if(r)refreshQuickEfforts(r,true);action(saveQuick);}; $('quick-effort').onchange = () => action(saveQuick);
$('reply-flow').onchange = () => action(async () => { await api['chat-flow'](chatId, $('reply-flow').value !== 'independent'); renderSpeakingOrder(); });
$('group-order').onclick = openGroupOrder;
$('expand-input').onclick = () => { $('composer').classList.toggle('expanded'); $('expand-input').textContent = $('composer').classList.contains('expanded') ? '收起' : '展开'; };
$('attach').onclick = () => action(chooseFiles); $('paste-image').onclick = () => action(pasteImage); api.onFiles(paths=>{action(()=>insertPaths(paths));},dragging=>$('composer').classList.toggle('file-drag-over',dragging&&page==='projects'&&Boolean(chat())));
$('messages').onscroll = markReadAtBottom; window.addEventListener('focus', markReadAtBottom);
$('toggle-tools').onclick = $('tool-terminal').onclick = () => action(() => openTools('terminal')); $('tool-files').onclick = () => action(() => openTools('files'));
$('tools-panel').append($('workflow-tools'));
$('tool-workflow').onclick = () => action(() => openTools('workflow'));
$('tool-activity').onclick = () => { activityFollow = true; action(() => openTools('activity')); };
$('activity-role').onchange = e => { activityRoleId = e.target.value; activityRunId = undefined; activityFollow = true; renderActivity(); };
$('activity-mode').onchange=e=>{activityMode=e.target.value;renderActivity();};
$('agent-terminal-start').onclick=()=>action(async()=>{const id=chatId,rid=activityRoleId,key=id+':'+rid;terminalConnectPending.add(key);renderActivity();let problem;try{await api['agent-terminal-open'](id,rid);}catch(error){problem=error;}try{agentTerminals=await api['agent-terminals']();}catch(error){problem||=error;}finally{terminalConnectPending.delete(key);if(toolMode==='activity')renderActivity();}if(problem)throw problem;if(chatId===id&&activityRoleId===rid)agentTerminalViews.get(selectedAgentTerminal()?.id)?.term.focus();});
$('agent-terminal-end').onclick=()=>action(async()=>{const t=selectedAgentTerminal();if(t&&confirm('结束此交互终端？正在执行的任务会停止，聊天记录保留。'))await api['agent-terminal-close'](t.id);});
$('activity-run').onchange = e => { activityRunId = e.target.value; activityFollow = activityRunId === activityRuns?.list.findLast(m => m.roleId === activityRoleId)?.id; renderActivity(); };
let activitySelection='';$('activity-copy').onpointerdown=()=>{const view=activityMode==='interactive'?agentTerminalViews.get(selectedAgentTerminal()?.id):activityView;activitySelection=view?.term.getSelection()||'';};
$('activity-copy').onclick = () => action(async () => {const view=activityMode==='interactive'?agentTerminalViews.get(selectedAgentTerminal()?.id):activityView;await api.copy(activitySelection || view?.term.getSelection() || (view?window.relayTerminalUI.text(view.term):'') || '');activitySelection=''; toast('已复制任务输出'); });
$('tools-close').onclick = () => { $('tools-panel').hidden = true; $('tools-rail').hidden = false; document.body.classList.remove('tools-wide'); $('tools-wide').textContent = '展开'; };
$('tools-wide').onclick = () => {
  document.body.classList.toggle('tools-wide');
  $('tools-wide').textContent = document.body.classList.contains('tools-wide') ? '还原' : '展开';
  if (toolMode==='workflow'&&!$('group-workflow-board').hidden&&groupWorkflowEditor) {
    requestAnimationFrame(()=>groupWorkflowEditor?.read.fit());
  } else fitTerminal();
};
$('tool-directory').onchange = () => { if (toolMode === 'files') action(loadFiles); };
$('terminal-new').onclick = () => action(async () => { terminalId = await api['terminal-open'](projectId,Number($('tool-directory').value)); await refreshTerminals(); });
$('terminal-list').onchange = e => { terminalId = e.target.value; refreshTerminalTabs(); terminalViews.get(terminalId)?.term.focus(); };
$('terminal-copy').onclick = () => action(() => api.copy(terminalViews.get(terminalId)?.term.getSelection() || ''));
$('terminal-end').onclick = () => action(() => api['terminal-close'](terminalId));
$('file-up').onclick = $('file-back').onclick = () => action(() => loadFiles('list', fileView?.parts.slice(0, -1)));
$('file-refresh').onclick = () => action(() => loadFiles(fileView?.operation));
api.on('terminal', event => { if (event.type === 'data') { const view = terminalViews.get(event.id); if (view && event.sequence > view.sequence) { view.term.write(event.data); view.sequence = event.sequence; } } else if (event.type === 'closed') { const view = terminalViews.get(event.id); view?.term.dispose(); view?.element.remove(); terminalViews.delete(event.id); refreshTerminals(); } else refreshTerminals(); });
window.addEventListener('resize',fitTerminal); new ResizeObserver(fitTerminal).observe($('terminal-host')); new ResizeObserver(fitTerminal).observe($('activity-host'));
new ResizeObserver(fitTerminal).observe($('agent-terminal-host'));
api.on('agent-terminal',event=>{
  if(event.type==='data'){const t=agentTerminals.find(t=>t.id===event.id);if(t&&event.sequence>(t.sequence||0)){t.output=((t.output||'')+event.data).slice(-200000);t.sequence=event.sequence;}const view=agentTerminalViews.get(event.id);if(view&&event.sequence>view.sequence){view.term.write(event.data);view.sequence=event.sequence;}}
  else{const index=agentTerminals.findIndex(t=>t.id===event.info.id);if(index<0)agentTerminals.push({...event.info,output:'',sequence:0});else Object.assign(agentTerminals[index],event.info);if(toolMode==='activity'&&activityMode==='interactive')renderActivity();}
});
bindWorkbenchFooter();
api.on('state', value => {
  if (!state) return;
  state = value;
  window.applyDeskTheme(value.settings.theme);
  if ($('s-theme')) {
    $('s-theme').value = value.settings.theme;
    for (const button of $('editor-view').querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === value.settings.theme));
    }
  }
  if ($('usage-center') && $('dialog').open) usageCenter?.render(value);
  if (page === 'settings' && settingsSection === 'updates') {
    cliUpdatesView?.render(value.cliUpdates);
    claudeUpdateView?.render(value.claudeUpdate);
  }
  if (page === 'projects' && !project() && state.projects.length) {
    projectId = orderedProjects()[0]?.id;
    chatId = chats()[0]?.id;
    renderSidebar();
  }
  const previousChat = chatId;
  if (!chat()) chatId = chats()[0]?.id;
  renderList();
  if (page === 'locations') renderLocationTunnelStatus();
  refreshPriorityView?.();
  if (page === 'projects') {
    renderProjectOptions();
    if (previousChat !== chatId || historyView?.id !== chat()?.id) activateChat();
    else { renderMessages(); renderAttachments(); }
  }
  renderWorkbenchFooter();
  renderProjectNotifications();
});
api.on('message', ({ chatId: messageChatId, message, updatedAt, lastMessage, atEnd }) => {
  const conversation = state?.chats.find(item => item.id === messageChatId);
  if (!conversation) return;
  const previous = conversation.lastMessage;
  conversation.updatedAt = updatedAt;
  conversation.lastMessage = lastMessage;
  if (activityRuns?.id === messageChatId && message.kind === 'assistant') {
    const index = activityRuns.list.findIndex(run => run.id === message.id);
    const {id, roleId, roleName, at, status, errorCode, workflowAttemptId, kind} = message;
    const run = {id, roleId, roleName, at, status, errorCode, workflowAttemptId, kind};
    if (index < 0) activityRuns.list.push(run);
    else activityRuns.list[index] = run;
  }
  if (historyView?.id === messageChatId) {
    historyView.request?.pending.set(message.id, {message, atEnd});
    applyMessage(historyView, message, atEnd);
    messageRenderTimer ??= setTimeout(() => {
      messageRenderTimer = undefined;
      renderHistoryControls();
      renderMessages();
    }, 90);
  }
  if (previous?.id !== lastMessage?.id || previous?.status !== lastMessage?.status) {
    renderList();
    if (conversation.projectId === projectId && lastMessage?.status !== 'running') refreshSidebarSearch();
  }
});
action(async () => {
  state = await api.snapshot();
  window.applyDeskTheme(state.settings.theme);
  projectId = state.settings.lastProjectId;
  if (!project()) projectId = orderedProjects()[0]?.id;
  chatId = chats()[0]?.id;
  renderSidebar();
  activateChat();
  await api['app-update-ready']();
});
