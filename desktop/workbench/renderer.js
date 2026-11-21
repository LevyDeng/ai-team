/* The renderer only receives sanitized state; credentials stay in the main process. */
const api = window.desk;
const $ = id => document.getElementById(id);
const quotaPanel = window.createQuotaPanel($('account-usage'), { refresh: () => api['usage-refresh'](), error: problem => toast(problem.message) });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<img src="icons/${name}.svg" alt="">`;
const avatar = (role, extra = '') => `<div class="avatar a${role?.avatar || 0} ${role?.avatarUrl ? 'custom' : ''} ${extra}" title="${esc(role?.name || '')}">${role?.avatarUrl ? `<img src="${esc(role.avatarUrl)}" alt="">` : ''}</div>`;
const group = () => `<div class="group-avatar">${icon('users')}</div>`;
let state, page = 'projects', projectId, chatId, roleId, locationId, filter = 'all', query = '', autoBottom = true, draftTimer, toastTimer, dialogSubmit, fileParts = [], filePath = '', toolMode = 'terminal', terminals = [], terminalId;
const terminalViews = new Map();
const agentTerminalViews=new Map();let agentTerminals=[],activityMode='log';
const terminalConnectPending=new Set();
const attachmentTasks=new Map(),sendingChats=new Set();
const vendorKinds = { antigravity:'Antigravity（反重力）',workbuddy:'WorkBuddy（兼容测试）',kimi:'Kimi Code',cursor:'Cursor Agent',codebuddy:'CodeBuddy Code' };
const geminiWebEngine = 'gemini-web';
const engineChoices = [['codex','Codex CLI'],['claude','Claude Code CLI'],...Object.entries(vendorKinds),['opencode','OpenCode'],[geminiWebEngine,'Gemini 网页版']];
const workflowStages = { implement: '执行阶段', review: '验收阶段' };
const workflowStatuses = {
  queued: '排队中', running: '运行中', paused: '已暂停', complete: '已完成',
  unavailable: '候选角色不可用', needs_check: '待人工确认', round_limit: '已达轮数上限',
  failed: '失败', interrupted: '已中断', cancelled: '已取消',
};
const {supportsEffort, modelOffering, modelDefault}=window.deskChatSettings;
const effortLabels={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'Ultra'};
const fallbackEfforts=['low','medium','high','xhigh'];
const roleCatalogs=new Map();
let claudeUpdateView, usageCenter, composerTargetKey, roleModelPicker, chatModelPicker, activityView, activityRoleId, activityRunId, activityFollow = true;
let skillId,skillEditorVersion=0;
const participantsForChat = () => (chat()?.roleIds || []).map(chatRole).filter(Boolean);
const composerRecipients = () => window.deskMentions.resolve($('input').value, participantsForChat(), chat()?.defaultReplyRoleIds);
const mentions = window.deskMentions.create($('input'), $('mention-menu'), { roles: participantsForChat, portrait: r => r.id === 'all' ? group() : avatar(r), changed: () => $('input').dispatchEvent(new Event('input')) });
const skillCommands=window.deskSkills.commands($('input'),$('skill-menu'),{skills:()=>state?.skills||[],changed:()=>$('input').dispatchEvent(new Event('input'))});
const project = () => state.projects.find(p => p.id === projectId);
const chat = () => state.chats.find(c => c.id === chatId && c.projectId === projectId);
const role = id => state.roles.find(r => r.id === id);
const chatRole = id => { const value = role(id); return value ? window.deskChatSettings.effectiveRole(chat(), value) : undefined; };
const roleButton = (id, extra = '') => `<button type="button" class="chat-role-avatar ${extra}" data-chat-role="${esc(id)}" title="${esc(role(id)?.name)} · 本对话模型设置">${avatar(role(id))}</button>`;
const locationOf = id => state.locations.find(l => l.id === id);
const chats = () => state.chats.filter(c => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
const engineLabel = engine => ({ codex:'Codex CLI', claude:'Claude Code', opencode:'OpenCode', [geminiWebEngine]:'Gemini 网页版', ...vendorKinds }[engine] || engine);
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
  ['Only Relay Desk skills can be edited here.', '请到技能来源修改外部导入的技能。'],
  ['Enter a unique command, a short name without spaces, and skill instructions.', '请填写唯一命令、不含空格的简短名称和技能说明。'],
  ['Choose a supported skill type.', '请选择受支持的技能类型。'],
  ['Skill name or command is already used.', '技能名称或命令已被使用。'],
  ['Wait for this skill to finish before editing it.', '请等技能执行完毕后再编辑。'],
  ['Wait for this skill to finish before deleting it.', '请等技能执行完毕后再删除。'],
  ['Keep API keys in the credential field, not in skill instructions.', '请把 API 密钥填入密钥栏，并从技能说明中移除。'],
  ['Use an HTTPS API base URL, or HTTP on localhost.', '请使用 HTTPS 接口地址。本机 localhost 也可使用 HTTP。'],
  ['Invalid image model ID.', '生图模型 ID 格式有误。'],
  ['App closed before completion. The partial response is preserved.', '应用在任务完成前退出，已收到的回复仍保留。'],
  ['Relay Desk is closing.', 'Relay Desk 正在退出。'],
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
  if (result?.loginSource === 'desktop') toast('已确认桌面版 Codex 登录，可直接发送消息');
  if(result?.desktopOpened)toast('请在官方桌面版完成账号登录，再回到这里发送消息');
  if (result?.terminalId) { projectId = result.projectId; chatId = chats()[0]?.id; terminalId = result.terminalId; showPage('projects'); await openTools('terminal'); }
}
function options(items, selected) { return items.map(([id, name]) => `<option value="${esc(id)}" ${String(id) === String(selected) ? 'selected' : ''}>${esc(name)}</option>`).join(''); }
function searchMarkup(placeholder) { return `<label class="search">${icon('search')}<input id="search" value="${esc(query)}" placeholder="${placeholder}"></label>`; }
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
  $('workbench-support').onclick=()=>{setOpen(false,true);return action(()=>api['workbench-support']());};
}
function renderProjectNotifications() {
  const select=$('project-select'),badge=$('project-unread');if(!select||!badge)return;
  const unread=new Set(state.chats.filter(c=>c.unread).map(c=>c.projectId));
  const others=state.projects.filter(p=>p.id!==projectId&&unread.has(p.id));
  for(const option of select.options){const p=state.projects.find(p=>p.id===option.value);if(!p)continue;const n=state.chats.filter(c=>c.projectId===p.id&&state.running[c.id]).length;option.textContent=(p.id!==projectId&&unread.has(p.id)?'● ':'')+p.name+(n?' ('+n+')':'');}
  badge.hidden=!others.length;badge.parentElement.classList.toggle('has-unread',Boolean(others.length));
  const label=others.length?'新回复：'+others.map(p=>p.name).join('、'):'';badge.setAttribute('aria-label',label||'其他项目有新回复');select.title=label;
}
function renderSidebar() {
  if (!state.projects.some(p => p.id === projectId)) projectId = state.projects[0]?.id;
  if (page === 'projects') {
    $('sidebar-top').innerHTML = `<div class="project-selector"><div class="project-select-wrap"><select id="project-select" aria-label="项目">${options(state.projects.map(p => [p.id, p.name]), projectId)}</select><span id="project-unread" class="badge project-unread" role="img" aria-label="其他项目有新回复" hidden></span></div><button class="icon-button" id="project-edit" title="项目设置">${icon('dots')}</button><button class="icon-button" id="project-new" title="新项目">${icon('plus')}</button></div>${searchMarkup('搜索会话、角色或消息')}<div class="tabs"><button data-filter="all" class="${filter === 'all' ? 'active' : ''}">全部</button><button data-filter="direct" class="${filter === 'direct' ? 'active' : ''}">单聊</button><button data-filter="group" class="${filter === 'group' ? 'active' : ''}">群聊</button><button id="chat-new" class="icon-button" title="新建对话">${icon('plus')}</button></div>`;
    $('project-select').onchange = e => { saveDraftNow(); projectId = e.target.value; chatId = chats()[0]?.id; fileParts = []; renderSidebar(); activateChat(); renderToolDirectory(); refreshTerminalTabs(); };
    $('chat-new').insertAdjacentHTML('beforebegin','<button data-filter="workflow">工作流</button>');
    $('sidebar-top').querySelector('[data-filter="workflow"]').classList.toggle('active',filter==='workflow');
    $('chat-new').title = filter === 'workflow' ? '新建工作流' : '新建对话';
    $('project-edit').onclick = () => openProject(project()); $('project-new').onclick = () => openProject(); $('chat-new').onclick = () => filter==='workflow'?openWorkflow():openChat();
    document.querySelectorAll('[data-filter]').forEach(b => { b.onclick = () => { saveDraftNow();filter = b.dataset.filter;
      if(filter==='workflow'&&!chat()?.workflow)chatId=chats().find(item=>item.workflow)?.id;
      renderSidebar();activateChat(); }; });
  } else {
    const title = page === 'roles' ? '角色' : page==='skills'?'技能': page === 'locations' ? '位置' : '设置';
    $('sidebar-top').innerHTML = `<div class="sidebar-title"><h2>${title}</h2>${page === 'skills' ? `<button id="skill-sources" class="icon-button" title="技能来源" aria-label="技能来源">${icon('settings')}</button>` : ''}${page !== 'settings' ? `<button id="entry-new" class="icon-button" title="新建${title}">${icon('plus')}</button>` : ''}</div>${page !== 'settings' ? searchMarkup('搜索' + title + '…') : ''}`;
    if ($('skill-sources')) $('skill-sources').onclick = openSkillSources;
    if ($('entry-new')) $('entry-new').onclick = () => page === 'roles' ? editRole() : page==='skills'?action(()=>editSkill()):editLocation();
  }
  if ($('search')) $('search').oninput = e => { query = e.target.value; renderList(); if (page === 'projects') highlightSearch(); };
  renderList();
  renderProjectNotifications();
  renderWorkbenchFooter();
}
function renderList() {
  const q = query.toLowerCase();
  if (page === 'projects') {
    const entries = chats().filter(c => (filter === 'all' || (filter === 'workflow' ? Boolean(c.workflow) : !c.workflow && (filter === 'direct' ? c.roleIds.length === 1 : c.roleIds.length > 1))) && (!q || [c.name, ...c.roleIds.map(id => role(id)?.name), ...c.messages.map(m => window.deskAttachments.messageText(m))].join('\n').toLowerCase().includes(q)));
    $('sidebar-list').innerHTML = entries.map(c => {
      const last = c.messages.findLast(m=>!m.moderatorTask); const busy = state.running[c.id];
      const preview=c.workflow?`${c.workflow.type==='generated'?'步骤 '+(c.workflow.nodeIndex+1):workflowStages[c.workflow.stage]} · ${workflowStatuses[c.workflow.status] || c.workflow.status}`:c.disbandedAt?'已解散 · 仅查看历史':last?.kind==='skill'?last.skillName+' · '+({running:'执行中',complete:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'}[last.status]||last.status):'';
      const waiting = busy?.phase==='web-reply'&&!busy.stopping;
      const indicator=waiting?'<span role="img" aria-label="待录入回复" title="待录入回复">…</span>':busy?'<img class="spinner" src="icons/refresh.svg" alt="运行中">':c.unread?'<span class="badge" title="有新回复"></span>':'';
      return `<button class="list-row ${c.id === chatId ? 'active' : ''}" data-chat="${c.id}">${c.roleIds.length > 1 ? group() : avatar(role(c.roleIds[0]))}<div class="row-text"><div class="row-title">${indicator}<span class="conversation-title" title="${esc(c.name)}">${esc(c.name)}</span><time>${new Date(c.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><p>${esc((waiting?'待录入 Gemini 回复':preview) || last?.text?.replace(/[#*`\n]/g, '').slice(0, 55) || (c.roleIds.length + ' 人 · 等待开始对话'))}</p></div></button>`;
    }).join('') || `<p class="hint" style="padding:18px 9px">${q ? '没有匹配的会话。' : '还没有对话，点击上方加号开始。'}</p>`;
    document.querySelectorAll('[data-chat]').forEach(b => { b.onclick = () => { saveDraftNow(); chatId = b.dataset.chat; autoBottom = true; renderList(); activateChat(); }; });
  } else if (page === 'roles') {
    $('sidebar-list').innerHTML = state.roles.filter(r => (r.name + r.description).toLowerCase().includes(q)).map(r => `<button data-role="${r.id}" class="list-row ${r.id === roleId ? 'active' : ''}">${avatar(r)}<div class="row-text"><div class="row-title">${esc(r.name)}</div><p>${esc(r.description || engineLabel(r.engine) + ' · ' + locationOf(r.locationId)?.name)}</p><small class="role-usage-summary">${esc(window.deskUsage.summary(state.accountUsage?.find(e=>e.roleIds.includes(r.id))))}</small></div></button>`).join('');
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
    $('sidebar-list').innerHTML = state.locations.filter(l => l.name.toLowerCase().includes(q)).map(l => `<button data-location="${l.id}" class="list-row ${l.id === locationId ? 'active' : ''}"><div class="group-avatar">${icon(l.type === 'local' ? 'device-desktop' : 'server')}</div><div class="row-text"><div class="row-title">${esc(l.name)}</div><p>${l.type === 'local' ? '本地 · 内置' : esc(l.username + '@' + l.host)}</p></div></button>`).join('');
    document.querySelectorAll('[data-location]').forEach(b => { b.onclick = () => editLocation(locationOf(b.dataset.location)); });
  } else $('sidebar-list').innerHTML = `<button class="list-row active">${icon('settings')}通用设置</button>`;
}
function showPage(next) {
  saveDraftNow(); roleModelPicker?.destroy(); roleModelPicker = undefined; page = next; query = '';
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
  else renderSettings();
}
function saveDraftNow() { if (chatId && state?.chats.some(c => c.id === chatId) && !$('composer').hidden) { clearTimeout(draftTimer); const text = $('input').value; const current = state.chats.find(c => c.id === chatId); current.draft = text; return api.draft(chatId, text).catch(e => toast(e.message)); } }
function activateChat() {
  skillCommands.close();
  $('workflow-status')?.remove();
  const c = chat(); const has = Boolean(c); $('composer').hidden = !has || Boolean(c.disbandedAt); $('empty-chat').hidden = has; $('messages').hidden = !has;
  const workflowFilter = filter === 'workflow';
  $('empty-chat').querySelector('h2').textContent = workflowFilter ? '还没有工作流' : '让想法在这里碰面';
  $('empty-chat').querySelector('p').textContent = workflowFilter ? '填写任务目标和验收标准，选择执行和验收角色。' : '与一个角色深入交流，或邀请多个角色一起讨论。';
  $('empty-create').innerHTML = icon('plus') + (workflowFilter ? '新建工作流' : '新建对话');
  $('chat-settings').hidden = !has; $('participants').innerHTML = has && !c.disbandedAt ? c.roleIds.map(id => roleButton(id)).join('') : '';
  $('chat-avatar').innerHTML = has ? (c.roleIds.length > 1 ? group() : roleButton(c.roleIds[0])) : group();
  $('chat-title').textContent = c?.name || project()?.name || '开始一段对话';
  $('chat-subtitle').textContent = has ? (c.disbandedAt?'群聊已解散':c.workflow?.type==='generated'?c.workflow.nodes.length+' 个步骤':c.roleIds.length+' 名角色参与')+' · '+project().name : workflowFilter ? '从当前项目创建工作流' : '选择项目，邀请你的 AI 角色';
  $('input').value = c?.draft || ''; renderAttachments();
  mentions.close(); composerTargetKey = undefined;
  $('round-limit-control').hidden = !has || c.roleIds.length === 1;$('auto-stop-control').hidden=!has||c.roleIds.length===1;
  $('rounds').value=c?.maxRounds||1;$('auto-stop').checked=c?.autoStop!==false;
  $('group-flow').hidden = !has || c.roleIds.length < 2; if (has) $('reply-flow').value = c.relayReplies === false ? 'independent' : 'relay';
  bindChatRoleAvatars();
  window.deskMessageImages.clear(); $('messages').replaceChildren(); autoBottom = true; renderMessages(); quickSettings(); renderToolDirectory();
}
function renderMessages() {
  const c = chat(); if (!c || page !== 'projects') return;
  const list = $('messages'); const shouldScroll = autoBottom || list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  for (const m of c.messages) {
    if(m.moderatorTask){renderModeratorMessage(list,c,m);continue;}
    if(m.kind==='skill'){let element=document.getElementById('msg-'+m.id);if(!element){element=document.createElement('article');element.id='msg-'+m.id;list.append(element);}window.deskSkills.message(element,m,{caller:role(m.callerRoleId)?.name,open:file=>action(()=>api.open(file,c.projectId)),copy:text=>action(()=>api.copy(text)),cancel:id=>action(()=>api['skill-cancel'](c.id,id)),review:()=>openHandoff(c,m.handoff,m.request)});continue;}
    if (m.kind === 'system' && document.getElementById('msg-' + m.id)) continue;
    let element = document.getElementById('msg-' + m.id);
    if (!element) {
      element = document.createElement('article'); element.id = 'msg-' + m.id; element.className = 'message ' + m.kind;
      if (m.kind === 'system') { element.className = 'system-message'; element.textContent = m.text; list.append(element); continue; }
      element.innerHTML = `${m.kind === 'user' ? `<img class="user-icon" src="icons/user.svg" alt="我">` : roleButton(m.roleId)}<div class="message-content">${m.kind === 'assistant' ? `<div class="message-meta"><b>${esc(m.roleName)}</b><span>${esc(engineLabel(role(m.roleId)?.engine))} · ${esc(locationOf(m.locationId)?.name || '')}${m.model ? ' · ' + esc(m.model) : ''}</span></div>` : ''}<div class="message-bubble"></div><div class="message-images" hidden></div><details class="message-reasoning" hidden><summary>思考摘要（CLI 提供）</summary><pre></pre></details><details class="message-tools" hidden><summary>工具活动</summary><ul></ul></details><div class="message-note" hidden></div><div class="message-footer"><time>${new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><span class="message-state"></span><button class="quiet task-output" ${m.kind !== 'assistant' ? 'hidden' : ''}>任务输出</button><button class="quiet copy-full">复制全文</button><button class="quiet restore" ${m.kind !== 'user' ? 'hidden' : ''}>恢复文字</button></div></div>`;
      element.querySelector('.copy-full').onclick = () => action(async () => { const current=state.chats.find(item=>item.id===c.id)?.messages.find(item=>item.id===m.id)||m;await api.copy(window.deskAttachments.messageText(current)); toast('已复制整条消息'); });
      element.querySelector('.restore').textContent='恢复输入';
      element.querySelector('.restore').onclick = () => {if(!chat()?.disbandedAt)restoreInput(c.id,m.id);};
      element.querySelector('.task-output').onclick = () => { activityMode=m.nativeTerminalId&&agentTerminals.some(t=>t.id===m.nativeTerminalId&&t.state!=='ended')?'interactive':'log';activityRoleId = m.roleId; activityRunId = m.id; activityFollow = false; action(() => openTools('activity')); };
      if (m.kind === 'assistant') {
        const login = document.createElement('button'); login.type = 'button'; login.className = 'quiet native-login'; login.textContent = '登录此角色'; login.hidden = true;
        login.onclick = () => action(() => loginRole(m.roleId)); element.querySelector('.message-footer').append(login);
        const model = document.createElement('button'); model.type = 'button'; model.className = 'quiet select-task-model'; model.textContent = '选择本对话模型'; model.hidden = true;
        model.onclick = () => openChatRole(m.roleId); element.querySelector('.message-footer').append(model);
        const diagnostic=document.createElement('button');diagnostic.type='button';diagnostic.className='quiet diagnostic-copy';diagnostic.textContent='复制诊断';diagnostic.hidden=true;diagnostic.onclick=()=>action(async()=>{const current=state.chats.find(item=>item.id===c.id)?.messages.find(item=>item.id===m.id);if(current?.diagnostics){await api.copy(JSON.stringify(current.diagnostics,null,2));toast('已复制诊断元数据，不包含提示词、图片或密钥');}});element.querySelector('.message-footer').append(diagnostic);
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
    const tools = element.querySelector('.message-tools'); tools.hidden = !m.activities?.length;
    const activityKey = JSON.stringify(m.activities || []); if (tools._key !== activityKey) { tools._key = activityKey; tools.querySelector('ul').innerHTML = (m.activities || []).map(item => `<li><span>${esc(({ running:'运行中', failed:'失败', interrupted:'中断', complete:'完成' })[item.status] || item.status)}</span>${esc(item.title)}</li>`).join(''); }
    if (m.kind === 'assistant') element.querySelector('.message-meta>span').textContent = engineLabel(role(m.roleId)?.engine) + ' · ' + (locationOf(m.locationId)?.name || '') + (m.model ? ' · ' + m.model : '');
    if(m.kind==='assistant'&&m.nativeSession){const meta=element.querySelector('.message-meta');let badge=meta.querySelector('.native-session-label');if(!badge){badge=document.createElement('span');badge.className='native-session-label';meta.append(badge);}badge.textContent=m.nativeSession.mode==='resumed'?'沿用原生会话':m.nativeSession.mode==='compatibility'?'历史衔接（CLI 不支持恢复）':'新原生会话';badge.title=m.nativeSession.id||'等待 CLI 返回会话 ID';}
    const login = element.querySelector('.native-login'); if (login) { login.hidden = !['CODEX_LOGIN_REQUIRED','CODEX_LOGIN_CHECK_FAILED','CODEX_DESKTOP_LOGIN_REQUIRED','CODEX_DESKTOP_LOGIN_CHECK_FAILED','VENDOR_LOGIN_REQUIRED'].includes(m.errorCode); login.textContent = m.errorCode?.startsWith('CODEX_DESKTOP_') ? '检查桌面版登录' : '登录此角色'; }
    const modelChoice = element.querySelector('.select-task-model'); if (modelChoice) modelChoice.hidden = m.errorCode !== 'CODEX_MODEL_REQUIRED';
    const diagnostic=element.querySelector('.diagnostic-copy');if(diagnostic)diagnostic.hidden=!m.diagnostics||m.status==='running';
    if(m.kind==='assistant')window.deskMessageImages.render(element.querySelector('.message-images'),m,{chatId:c.id,load:(id,messageId)=>api['message-images'](id,messageId),open:file=>api.open(file,c.projectId),copy:text=>api.copy(text),error:e=>toast(e.message),layout:follow=>{if(chatId!==c.id)return false;if(follow==='before')return list.scrollHeight-list.scrollTop-list.clientHeight<100;if(follow)requestAnimationFrame(()=>{if(chatId===c.id)list.scrollTop=list.scrollHeight;});}});
    const key = m.text + '\0' + m.status + '\0' + m.activity + '\0' + m.note + '\0' + m.errorCode + '\0' + m.warningCode + '\0' + JSON.stringify(m.contextTransfer) + '\0' + JSON.stringify(m.cliShutdown);
    if (element._key !== key) {
      element._key = key;
      const body = element.querySelector('.message-bubble');
      if (m.kind === 'user') {body.replaceChildren();if(m.text){const text=document.createElement('div');text.className='user-message-text';text.textContent=m.text;body.append(text);}if(m.attachments?.length){const files=document.createElement('div');files.className='message-attachments';attachmentCards(files,m.attachments,{projectId:c.projectId});body.append(files);}}
      else if (m.text) window.relayMarkdown.render(body, m.text, { copy: text => api.copy(text), openLink: value => api.open(value, projectId), openPath: value => api.open(value, projectId), error: e => toast(e.message) });
      else body.textContent = m.errorCode === 'WORKBUDDY_DESKTOP_AUTH_UNAVAILABLE' ? '尚未接通 WorkBuddy 桌面账号，本次未收到回复。' : m.errorCode === 'CODEX_MODEL_REQUIRED' ? '请先选择本对话使用的模型。' : m.errorCode === 'CODEX_DESKTOP_LOGIN_REQUIRED' ? '请先在桌面版 Codex 中登录，再重新发送。' : m.errorCode === 'CODEX_LOGIN_REQUIRED' ? '需要登录此角色后才能开始任务。' : m.status === 'running' ? '正在思考…' : '没有收到回复内容。';
      const statusLabels={running:m.geminiWeb?'待录入回复':'生成中',complete:'',failed:'失败',interrupted:'已中断',cancelled:'已暂停',submitting:'等待 CLI 接收',unconfirmed:'提交未确认'};
      element.querySelector('.message-state').textContent = m.status==='running'&&['Finishing agent','Closing the finished agent process'].includes(m.activity)?'正在收尾':statusLabels[m.status]||'';
      const note = element.querySelector('.message-note'); note.hidden = !m.note; note.textContent = m.errorCode === 'WORKBUDDY_DESKTOP_AUTH_UNAVAILABLE' ? '桌面版已登录不代表独立子进程能获得加密凭据。当前桌面账号兼容接入仍未完成；不会自动改用 API Key 或另一种计费方式。原提问已保留，无需重复输入。' : m.errorCode === 'CODEX_MODEL_REQUIRED' ? '对话模型留空时会跟随角色默认。两处均未设置，请点击“选择本对话模型”；复用登录不会自动采用桌面版的默认模型，原提问已保留。' : m.errorCode?.startsWith('CODEX_DESKTOP_LOGIN_') ? '此角色复用桌面版 Codex 的登录。请在桌面版完成登录后重试；无需在这里重复授权，原提问已保留。' : m.errorCode === 'CODEX_LOGIN_REQUIRED' ? '此角色尚未登录 Codex。点击“登录此角色”完成授权后，再发送消息。也可在角色设置中选择复用桌面版登录；原提问已保留在聊天记录中。' : m.errorCode === 'CODEX_LOGIN_CHECK_FAILED' ? '无法确认此角色的 Codex 登录状态。请点击“登录此角色”重新授权；原提问已保留在聊天记录中。' : m.note ? uiError(m.note) : '';
      if(m.warningCode==='CLAUDE_PERMISSION_DENIED'||m.note==='Some tools require approval. Use the project terminal or classic interface to approve them.')note.textContent=m.permission==='danger-full-access'?'本次已使用 Claude 完全权限，仍有工具被拒绝。请检查 Claude 管理策略、工具自身限制或 MCP 服务授权；容器和 Linux 用户权限不会自动提升。':'本次有工具需要审批。可在角色 → 连接配置 → Agent 运行权限中选择完全权限，保存后重新发送任务。已结束的请求无法在另一个终端补批；原提问和回复已保留。';
      if(m.note==='CLI submission was not confirmed. Restore this message to retry.')note.textContent='连接结束前尚未确认 CLI 收到消息。文字和附件已保留，可点击“恢复输入”重试。';
      if(m.errorCode==='REMOTE_CHANNEL_CLOSED'){note.hidden=false;note.textContent='远程 SSH 通道中断，未收到退出状态；这条错误不能用于判断账号被停用。请重新连接后继续，已收到的回复和发送记录保留，任务没有自动重试。';}
      if(m.status==='cancelled'&&m.stopConfirmed===false){note.hidden=false;note.textContent='远程任务尚未确认停止。请检查 VPS 上的任务后再继续。';}
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
    }
    if(m.recovery){let recovery=element.querySelector('.message-recovery');if(!recovery){recovery=document.createElement('p');recovery.className='message-recovery hint';element.querySelector('.message-content').append(recovery);}const labels={waiting:'等待自动续接',resuming:'正在恢复同一个 session',recovered:'自动续接成功',stopped:'自动续接已停止',cancelled:'自动续接已取消'};recovery.textContent=(labels[m.recovery.state]||'自动续接')+' · '+m.recovery.attempt+'/'+m.recovery.maxRetries+' 次'+(m.recovery.transport==='uncompressed'?' · 已关闭本次请求压缩':'')+'；保留已有操作记录，不重新提交原始任务。';}
  }
  const busy = state.running[c.id]; $('chat-banner').hidden = !busy;
  if (busy) {
    const current=c.messages.findLast(m=>m.kind==='assistant'&&m.roleId===busy.roleId&&m.status==='running');
    const finishing=['Finishing agent','Closing the finished agent process'].includes(current?.activity);
    const waiting=busy.phase==='web-reply'&&!busy.stopping;
    const activity=busy.stopping?'正在停止…':busy.phase==='workflow-route'?'正在选择下一位角色…':busy.phase==='compact'?'主持人正在压缩历史…':busy.phase==='review'?'主持人正在判断是否继续…':waiting?'待录入回复':finishing?'已完成，正在收尾…':'正在发言';
    const indicator=waiting?'':'<img class="spinner" src="icons/refresh.svg" alt="">';
    const progress=c.workflow?.type==='generated'?`步骤 ${busy.round} / ${busy.rounds}`:`第 ${busy.round} 轮 / 上限 ${busy.rounds} 轮`;
    $('chat-banner').innerHTML=`${indicator}${progress} · ${esc(role(busy.roleId)?.name)} ${activity}<button id="banner-pause">${icon('player-pause')}${c.workflow?'暂停工作流':'暂停讨论'}</button>`;
    $('banner-pause').onclick=()=>action(()=>api.pause(c.id));
  }
  renderWorkflowStatus(c);
  renderDiscussion();
  $('reply-flow').disabled = false; $('group-order').disabled = false;
  renderSpeakingOrder(); if (toolMode === 'activity' && !$('tools-panel').hidden) renderActivity();
  const inputBusy=Boolean(state.inputBusy?.[c.id]||busy),queued=Boolean(c.inputQueue?.length);
  $('pause').hidden = !busy; $('send').hidden = false; $('send').innerHTML=icon(inputBusy||queued?'plus':'send')+(inputBusy||queued?'加入队列':'发送');
  $('interrupt-send').hidden=!inputBusy&&!queued;if($('chat-summary'))$('chat-summary').disabled=Boolean(inputBusy||queued);
  renderInputQueue(c);
  if (shouldScroll) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; autoBottom = false; markReadAtBottom(); });
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
  const key=JSON.stringify([c.id,entries.map(entry=>[entry.id,entry.state]),state.roles.map(role=>[role.id,role.name]),c.queuePaused,c.queueReason,c.queueError]);if(panel._key===key)return;panel._key=key;
  $('queue-title').textContent='待发送 '+entries.length+' 条'+(c.queuePaused?' · 已暂停':'');
  const reasons={restart:'App 已重开，确认后继续发送。',manual:'已手动暂停队列。',failed:'当前任务失败，后续消息已保留。',needs_user:'当前任务需要你的信息或决定。',unconfirmed:'讨论结束状态未确认，请检查回复后继续。',moderator_failed:'主持人调用失败，请检查后继续。',moderator_budget:'主持人已达到调用上限，请检查后继续。',paused:'当前任务已暂停。',blocked:'消息暂未发送，请处理问题后继续。',interrupt_timeout:'尚未确认任务已停止，队列已暂停。请检查任务输出后继续。',stop_unconfirmed:'连接已断开，但尚未确认原任务已停止。请检查远程进程后再继续队列。',terminal_ended:'交互终端已结束，请检查后继续。'};
  $('queue-note').textContent=c.queuePaused?(reasons[c.queueReason]||'队列已暂停，请检查后继续。')+(c.queueError?' '+attachmentError(c.queueError):''):'当前任务完整结束后，按顺序发送；失败或需要确认时自动暂停。';
  $('queue-resume').hidden=!c.queuePaused;$('queue-pause').hidden=Boolean(c.queuePaused);
  const list=$('queue-items');list.replaceChildren();
  for(const [index,entry]of entries.entries()){
    const row=document.createElement('article');row.className='queued-input';row.dataset.queueId=entry.id;
    const info=document.createElement('div');info.className='queued-input-content';
    const label=document.createElement('small');label.textContent=(index+1)+'. '+entry.value.roleIds.map(id=>role(id)?.name||'已移除角色').join(' → ')+(entry.state==='dispatching'?' · 正在提交…':'');label.title=entry.value.roleIds.map(id=>(role(id)?.name||id)+' · '+(entry.value.roleSettings?.[id]?.model||'默认模型')).join('\n');
    const preview=document.createElement('p');preview.textContent=entry.value.text||'仅附件消息';preview.title=entry.value.text.slice(0,1000);
    info.append(label,preview);if(entry.value.files?.length){const files=document.createElement('small');files.textContent='附件：'+entry.value.files.map(file=>file.name).join('、');info.append(files);}
    const controls=document.createElement('div');controls.className='queued-input-actions';
    const add=(label,title,run,disabled=false)=>{const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=label;button.title=title;button.setAttribute('aria-label',title);button.disabled=disabled||entry.state==='dispatching';button.onclick=()=>action(run);controls.append(button);};
    add('↑','上移',()=>api['queue-move'](c.id,entry.id,-1),index===0);add('↓','下移',()=>api['queue-move'](c.id,entry.id,1),index===entries.length-1);
    add('插队','停止当前轮后优先发送；不会自动重做被中断的任务',()=>api['queue-now'](c.id,entry.id));
    add('编辑','移回空输入框后修改',async()=>{if(chatId===c.id)saveDraftNow();const draft=await api['queue-restore'](c.id,entry.id),current=state.chats.find(chat=>chat.id===c.id);if(current){current.draft=draft.text;current.draftAttachments=draft.attachments;}if(chatId===c.id){$('input').value=draft.text;renderAttachments();quickSettings();renderSpeakingOrder();$('input').focus();}});
    add('×','移除这条排队消息',()=>api['queue-remove'](c.id,entry.id));row.append(info,controls);list.append(row);
  }
}
function renderModeratorMessage(list,c,m){
  let element=document.getElementById('msg-'+m.id);if(!element){element=document.createElement('article');element.id='msg-'+m.id;element.className='moderator-message';element.innerHTML='<details><summary></summary><p class="moderator-note"></p><details class="moderator-memory" hidden><summary>查看上下文摘要</summary><pre></pre><button type="button" class="quiet copy-moderator-summary">复制摘要</button></details><button type="button" class="quiet task-output">查看主持人任务输出</button></details>';list.append(element);element.querySelector('.task-output').onclick=()=>{activityMode='log';activityRoleId=m.roleId;activityRunId=m.id;activityFollow=false;action(()=>openTools('activity'));};element.querySelector('.copy-moderator-summary').onclick=()=>{const current=state.chats.find(item=>item.id===c.id)?.messages.find(item=>item.id===m.id);return action(()=>api.copy(current?.moderatorResult?.summary||''));};}
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
function markReadAtBottom() { const c = chat(); if (page === 'projects' && c?.unread && !$('dialog').open && $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 50 && document.hasFocus()) { c.unread = false; api.read(c.id).catch(() => {}); renderList(); renderProjectNotifications(); } }
function highlightSearch() { if (!query || !chat()) return; const match = chat().messages.find(m => m.text?.toLowerCase().includes(query.toLowerCase())); if (match) { document.getElementById('msg-' + match.id)?.scrollIntoView({ block: 'center' }); autoBottom = false; } }
function quickRole() { const ids = composerRecipients().roleIds; return ids.length === 1 ? chatRole(ids[0]) : undefined; }
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
  const hidden=!r || r.engine===geminiWebEngine;
  $('quick-model').hidden=hidden;$('quick-effort').hidden=hidden||!supportsEffort(r?.engine);
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
  if (r.engine === geminiWebEngine) {
    const link = c.geminiWebChats?.[id] || '';
    dialog(`<h2>${esc(r.name)} · 网页对话</h2><label>私有对话链接<input id="gemini-web-link" type="url" value="${esc(link)}" placeholder="https://gemini.google.com/app/…"></label><p class="hint">从地址栏复制链接。留空时打开 Gemini 首页。</p><button type="button" id="gemini-web-open">打开 Gemini</button>`,
      () => api['gemini-web-link'](c.id, id, $('gemini-web-link').value));
    $('gemini-web-open').onclick = () => action(() => api['gemini-web-open'](c.id, id));
    return;
  }
  const selection = c.roleSettings?.[id] || {};
  dialog(`<h2>${esc(r.name)} · 本对话设置</h2><p class="hint">仅对此对话生效；留空跟随角色，保存后下次发言生效。</p><label>模型<div id="chat-model-picker"></div></label><label>推理强度<select id="chat-effort">${options([['','跟随角色'],['low','低'],['medium','中'],['high','高'],['xhigh','很高'],...(r.effort && !['low','medium','high','xhigh'].includes(r.effort) ? [[r.effort,r.effort]] : [])],selection.effort || '')}</select></label><p class="hint">角色默认：${esc(role(id)?.model || '未设置模型')} · ${esc(role(id)?.effort || '未指定强度')}。${esc(engineLabel(r.engine))} · ${esc(locationOf(r.locationId)?.name)}。</p><button type="button" id="chat-role-output" class="quiet">查看任务输出</button>`, async () => {
    const model=$('chat-model-picker').querySelector('input').value.trim();
    const effort=$('chat-effort').value;
    assertEffort(modelOffering(roleCatalogs.get(id)||[],model||role(id)?.model),effort||role(id)?.effort);
    await api['chat-role-settings'](c.id, id, {model,effort});
    quickSettings(); toast('已保存本对话模型设置，下次发言生效');
  });
  const syncEfforts=(selected,promote=false)=>{
    const model=$('chat-model-picker').querySelector('input').value.trim()||role(id)?.model;
    const offering=modelOffering(roleCatalogs.get(id)||[],model), inherited=role(id)?.effort;
    if(!selected&&promote&&inherited&&offering?.efforts&&!offering.efforts.includes(inherited))selected=modelDefault;
    renderEfforts($('chat-effort'),offering,selected,{inherit:true,promote});
  };
  chatModelPicker = window.createModelPicker($('chat-model-picker'), { value: selection.model || '', load: force => api.models(r, { force }), onCatalog:models=>{receiveRoleCatalog(id,models);syncEfforts($('chat-effort').value);} });
  const modelInput=$('chat-model-picker').querySelector('input');
  modelInput.placeholder = '留空跟随角色：' + (role(id)?.model || '未设置模型');
  modelInput.addEventListener('change',()=>syncEfforts($('chat-effort').value,true));
  syncEfforts(selection.effort||'');
  $('chat-effort').disabled = !supportsEffort(r.engine);if(!supportsEffort(r.engine)){$('chat-effort').value='';$('chat-effort').title='此 Agent 无独立推理强度参数，请选择其模型变体或使用原生设置。';}
  chatModelPicker.update();
  $('chat-role-output').onclick = () => { $('dialog').close(); activityRoleId = id; activityRunId = undefined; activityFollow = true; action(() => openTools('activity')); };
  const native=c.nativeSessions?.[id];$('chat-role-output').insertAdjacentHTML('afterend','<section class="native-session-setting"><h3>原生会话</h3><p class="hint" id="chat-native-session"></p><button type="button" class="quiet" id="chat-session-reset">重新建立原生会话</button><p class="hint">重建后下次发送使用新会话，聊天记录保留。</p></section>');
  $('chat-native-session').textContent=native?.id?'会话 ID：'+native.id+(native.status==='uncertain'?' · 上一轮状态未确认':'')+(native.disableRequestCompression?' · 已为此会话关闭请求压缩（兼容恢复）':''):'尚未建立原生会话';$('chat-session-reset').disabled=!native;
  $('chat-session-reset').onclick=()=>action(async()=>{state=await api['chat-session-reset'](c.id,id);$('chat-native-session').textContent='下次发送将建立新的原生会话，聊天记录已保留。';$('chat-session-reset').disabled=true;toast('已清除本角色的原生会话绑定');});
}
function renderSpeakingOrder() {
  const ids = composerRecipients().roleIds;
  const text = '发言顺序：' + ids.map(id => role(id)?.name || id).join(' → ')+(chat()?.relayReplies!==false&&chat()?.moderatorRoleId?'；主持人：'+(role(chat().moderatorRoleId)?.name||'未配置'):'');
  $('speaking-order').textContent = text; $('speaking-order').title = text;
  $('reply-flow').title = chat()?.relayReplies === false ? '各角色只读取用户消息和自己的历史回复' : '后一个角色可以读取前面的角色回复';
  renderDiscussion();
}
function renderDiscussion(){
  const c=chat();if(!c)return;const participants=composerRecipients().roleIds.length,relay=c.relayReplies!==false&&participants>1;
  $('rounds').disabled=!relay;$('auto-stop').disabled=!relay;
  const moderated=relay&&c.moderatorRoleId,hint=relay?'轮数仅为上限，不要求跑满。最多 '+(Number($('rounds').value)||1)*participants+' 次角色发言；'+(moderated?($('auto-stop').checked?'主持人每轮额外判断一次；':'主持人本次不进行结束判断；')+(c.moderatorCompression!==false?'每次发送最多两次长历史压缩调用。':'长历史自动压缩已关闭。'):'轮数不能精确限制 Token。'):'单聊或独立作答每位角色仅回答一次。';
  $('round-limit-control').title=hint;$('auto-stop-control').title=relay?moderated?'每轮由所选主持人判断是否结束；关闭后不额外调用主持人判断，仍保留已启用的历史压缩。':'每轮全部参与者判断结束；信号不完整时停止自动追加。取消勾选则按指定上限执行。':hint;
  const result=c.lastDiscussion,box=$('discussion-result');box.hidden=!result||Boolean(state.running[c.id])||c.roleIds.length<2;
  if(result){const labels={complete:'AI 判断讨论已收敛，提前结束',needs_user:'讨论已暂停：需要你的信息或决定',unconfirmed:'结束判定不完整，已停止自动追加',limit:'已达到轮数上限，是否继续由你决定',paused:'讨论已暂停',failed:'角色调用失败，后续发言已停止',moderator_failed:'主持人协调未完成，已停止自动追加',moderator_budget:'主持人压缩达到本次任务上限，已暂停以控制消耗',answered:'已完成本次作答',summary:'总结已完成'};box.textContent=(labels[result.state]||'本次讨论已结束')+' · 完成 '+result.rounds+' 轮 / 上限 '+result.maxRounds+' 轮'+(result.reason?' · '+result.reason:'');box.title='结束判定由 AI 给出，可能有误；你仍可发送消息继续讨论。';}
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
    window.deskSkills.system($('editor-view'),draft,enabled=>action(()=>api['skill-system-enabled'](id,enabled)));
    return;
  }
  window.deskSkills.editor($('editor-view'),draft,{error:error=>toast(uiError(error)),models:(value,options)=>api['skill-models'](value,options),save:async value=>{const saved=await api['skill-save'](value);state=await api.snapshot();renderSidebar();await editSkill(saved.id);toast('技能已保存');},remove:async id=>{await api['skill-delete'](id);state=await api.snapshot();skillId=state.skills[0]?.id;renderSidebar();await editSkill(skillId);}});
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
    const submit=$('dialog-form').querySelector('button[type=submit]');
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
  const r=quickRole();if(!r||r.engine===geminiWebEngine)return;
  const model=$('quick-model').value.trim(), effort=$('quick-effort').value;
  assertEffort(quickOffering(r),effort||role(r.id)?.effort);
  if(r.model!==model || (chat()?.roleSettings?.[r.id]?.effort||'')!==effort)await api['chat-role-settings'](chatId,r.id,{model,effort});
}
async function send(summary = false, mode = 'queue') {
  const c = chat(); if (!c || c.disbandedAt) return; const draft = $('input').value; const recipients = composerRecipients(); const text = summary ? '请总结当前讨论中的共识、分歧、待确认问题和下一步行动。' : draft;
  if(sendingChats.has(c.id))return;if(attachmentTasks.get(c.id)){toast('正在添加附件，请稍候再发送');return;}
  const files=summary?[]:[...(c.draftAttachments||[])];
  if ((!text.trim()&&!files.length)||(!summary&&!recipients.content&&!files.length)) return; saveDraftNow();
  sendingChats.add(c.id);renderAttachments();
  const maxRounds=summary?1:Number($('rounds').value),autoStop=$('auto-stop').checked;
  try { await saveQuick(); const result = await api.send({ chatId: c.id, text,attachmentIds:files.map(file=>file.id), roleIds: summary ? [c.roleIds[0]] : recipients.roleIds, rounds:maxRounds,autoStop, summary,mode }); if(result.accepted&&!summary){const current=state.chats.find(item=>item.id===c.id);if(current){const ids=new Set(files.map(file=>file.id));current.draftAttachments=(current.draftAttachments||[]).filter(file=>!ids.has(file.id));}if(chatId===c.id&&$('input').value===draft){$('input').value='';if(current)current.draft='';mentions.close();quickSettings();}} }
  catch (e) { toast(attachmentError(e)); }
  finally { sendingChats.delete(c.id);renderAttachments(); }
}
function dialog(html, submit, label = '保存') { usageCenter?.destroy();usageCenter=undefined;chatModelPicker?.destroy(); chatModelPicker = undefined; dialogSubmit = submit; $('dialog').classList.remove('role-selection-dialog','usage-center-dialog','native-quota-open'); $('dialog-body').innerHTML = html;const heading=$('dialog-body').querySelector('h2');$('dialog-title').textContent=heading?.textContent||'设置';heading?.remove(); const button = $('dialog-form').querySelector('button[type=submit]'); button.textContent = label; button.disabled = false; $('dialog').showModal(); }
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
    const button = $('avatar-upload'); const submit = $('dialog-form').querySelector('button[type=submit]');
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
function openProject(p) {
  dialog(`<h2>${p ? '项目设置' : '新建项目'}</h2><label>项目名称<input id="p-name" value="${esc(p?.name || '')}" placeholder="例如：我的项目" required></label><label>项目工作目录<span class="hint">首个目录默认打开；请为角色的运行位置配置目录。</span></label><div id="directory-rows">${directoryRows(p?.directories || [{ locationId: 'local', path: '' }])}</div><button type="button" id="directory-add" class="quiet">${icon('plus')}添加目录</button><label>邀请角色</label><div class="checks">${state.roles.map(r => `<label><input type="checkbox" name="project-role" value="${r.id}" ${(!p || p.roleIds.includes(r.id)) ? 'checked' : ''}>${esc(r.name)}</label>`).join('')}</div>${p ? `<div class="tool-actions"><button type="button" id="project-up" class="quiet">${icon('arrow-up')}上移项目</button><button type="button" id="project-down" class="quiet">${icon('arrow-down')}下移项目</button><button type="button" id="project-delete" class="quiet">${icon('trash')}移除项目</button></div>` : ''}`, async () => {
    const result = await api['project-save']({ id: p?.id, name: $('p-name').value, directories: [...document.querySelectorAll('.directory-row')].map(row => ({ locationId: row.querySelector('select').value, path: row.querySelector('input').value })), roleIds: [...document.querySelectorAll('[name=project-role]:checked')].map(x => x.value) });
    projectId = result.id; if (chat()?.projectId !== result.id) chatId = chats()[0]?.id; renderSidebar(); activateChat();
  });
  $('directory-add').onclick = () => { $('directory-rows').insertAdjacentHTML('beforeend', directoryRows([{ locationId: 'local', path: '' }])); bindDirectoryButtons(); }; bindDirectoryButtons();
  if (p) { $('project-up').onclick = () => action(async () => { await api['project-move'](p.id, -1); toast('项目顺序已更新'); }); $('project-down').onclick = () => action(async () => { await api['project-move'](p.id, 1); toast('项目顺序已更新'); }); $('project-delete').onclick = () => action(async () => { if (await api['project-delete'](p.id)) { $('dialog').close(); projectId = state.projects[0]?.id; chatId = undefined; renderSidebar(); activateChat(); } }); }
}
async function openConversationResult(result) {
  saveDraftNow();
  state=await api.snapshot();
  projectId=result.projectId;chatId=result.id;filter='all';query='';
  renderSidebar();activateChat();refreshTerminalTabs();
}
function openWorkflow(existing){
  const activeProject = project();
  if (!activeProject) { toast('请先创建或选择一个项目。'); return; }
  const roles=state.roles.filter(r=>r.engine!==geminiWebEngine&&activeProject.directories.some(d=>d.locationId===r.locationId));
  if(!roles.length){toast('当前项目没有可以运行工作流的角色。请先在项目设置中为角色的运行位置添加工作目录。');return;}
  const stages=['implement','review'];
  const teams={implement:[roles[0].id],review:[(roles[1]||roles[0]).id]};
  if(existing)for(const stage of stages)teams[stage]=existing.workflow.teams[stage].filter(id=>roles.some(role=>role.id===id));
  const moderators=roles.filter(role=>['codex','claude'].includes(role.engine));
  const moderatorId=existing?.workflow.moderatorRoleId||'';
  const moderationOptions=[['','按候选顺序'],...moderators.map(role=>[role.id,`AI 主持 · ${role.name}`])];
  if(moderatorId&&!moderators.some(role=>role.id===moderatorId))moderationOptions.push([moderatorId,'原主持角色不可用']);
  const fields=existing?'':'<button type="button" id="wf-ai-plan">AI 生成工作流</button><label>任务目标<textarea id="wf-goal" rows="3" maxlength="16000" required></textarea></label><label>验收标准<textarea id="wf-criteria" rows="3" maxlength="16000" required></textarea></label><label>最多轮数<input id="wf-limit" type="number" min="1" max="20" value="3" required></label>';
  const moderation=`<label>选人方式<select id="wf-moderator" aria-describedby="wf-moderator-hint">${options(moderationOptions,moderatorId)}</select></label><p id="wf-moderator-hint" class="hint" hidden>有多个候选时由主持人先选一位。该角色不可用时，按列表顺序尝试其余候选。</p>`;
  const title=existing?'编辑工作流角色和主持人':'新建工作流';
  dialog(`<h2>${title}</h2>${fields}${moderation}${stages.map(stage=>`<section class="setting-card"><h3>${stage==='review'?'验收角色':'执行角色'}</h3><div id="wf-${stage}"></div></section>`).join('')}<p id="wf-error" class="message-note" role="alert" hidden></p>`,async()=>{
    const submit=$('dialog-form').querySelector('[type=submit]');submit.disabled=true;
    const feedback = $('wf-error');
    feedback.hidden = true;
    try{
      const moderatorRoleId=$('wf-moderator').value;
      if(existing){await invokeWorkflow('teams',existing.id,teams,moderatorRoleId);return;}
      const result=await invokeWorkflow('create',{projectId:activeProject.id,goal:$('wf-goal').value,criteria:$('wf-criteria').value,limit:Number($('wf-limit').value),teams,moderatorRoleId});
      await openConversationResult(result);filter='workflow';renderSidebar();
    }catch(error){
      feedback.textContent = error.message;
      feedback.hidden = false;
      feedback.scrollIntoView({block:'nearest'});
      return false;
    }finally{submit.disabled=false;}
  },existing?'保存设置':'创建并排队');
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
  if (!existing) $('wf-ai-plan').onclick=()=>{
    const criteria=$('wf-criteria').value.trim();
    const goal=[$('wf-goal').value.trim(),criteria&&`验收标准\n${criteria}`].filter(Boolean).join('\n\n');
    openGeneratedWorkflow(activeProject,{goal});
  };
  refresh();
}

function openGeneratedWorkflow(activeProject,{goal='',existing,rerun=false}={}) {
  const eligible=activeProject.roleIds.map(role).filter(r=>{
    if (!r||r.engine===geminiWebEngine||!activeProject.directories.some(d=>d.locationId===r.locationId)) return false;
    const location=locationOf(r.locationId);
    return location?.type==='local'||(location?.os==='linux'&&r.provider==='native');
  });
  const moderators=eligible.filter(r=>['codex','claude'].includes(r.engine));
  if (!existing && !moderators.length) {toast('请先在项目设置中邀请一个能在项目目录运行的 Codex 或 Claude 角色。');return;}
  if (existing && !eligible.length) {toast('请先邀请角色并为其运行位置配置项目目录。');return;}
  const flow=existing?.workflow;
  const editing=existing&&!rerun;
  const title=editing?'编辑工作流步骤':rerun?'再次运行工作流':'AI 生成工作流';
  const hostOptions=moderators.map(r=>[r.id,`${r.name} · ${locationOf(r.locationId)?.name||''}`]);
  const fields=`<label>任务目标<textarea id="wf-plan-goal" rows="4" maxlength="16000" required ${existing?'readonly':''}>${esc(flow?.goal||goal)}</textarea></label>`;
  const planning=existing?'':`<label id="wf-plan-planner-field">生成角色<select id="wf-plan-planner">${options(hostOptions,moderators[0]?.id)}</select></label>`;
  const preview=`<section id="wf-plan-preview" hidden><label>工作流名称<input id="wf-plan-title" maxlength="100" ${editing?'readonly':''}></label><label>自动选人的主持人<select id="wf-plan-moderator">${options([['','按评分选人'],...hostOptions],flow?.moderatorRoleId||'')}</select></label><p class="hint">自动选人的步骤开始时，会读取当时的评分。生成的步骤按列表顺序运行。</p><div id="wf-plan-nodes"></div></section>`;
  let readNodes, requestId, root, feedback, target, submit, goalInput, plannerField;
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
      const value={type:'generated',projectId:activeProject.id,goal:goalInput.value,title:$('wf-plan-title').value,nodes:readNodes(),moderatorRoleId:$('wf-plan-moderator').value};
      if (editing) await invokeWorkflow('generated-update',existing.id,value);
      else {
        const result=await invokeWorkflow('create',value);
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
  root=$('wf-plan-form');feedback=$('wf-plan-error');target=$('dialog');submit=$('dialog-form').querySelector('[type=submit]');goalInput=$('wf-plan-goal');plannerField=$('wf-plan-planner-field');
  function showPreview(plan,moderatorId) {
    feedback.hidden=true;goalInput.readOnly=true;
    if (plannerField) plannerField.hidden=true;
    $('wf-plan-preview').hidden=false;
    $('wf-plan-title').value=plan.title;
    $('wf-plan-title').required=true;
    $('wf-plan-moderator').value=moderators.some(r=>r.id===moderatorId)?moderatorId:'';
    const currentRoles=eligible.map(item=>role(item.id)).filter(Boolean);
    readNodes=window.deskWorkflowUI.editPlan($('wf-plan-nodes'),plan.nodes,currentRoles,window.deskWorkflowRatings.catalog(state.roles),editing?flow.nodeIndex:0);
    submit.textContent=editing?'保存设置':'创建并排队';
  }
  if (existing) showPreview(flow,flow.moderatorRoleId);
  target.addEventListener('close',()=>{
    if (requestId) invokeWorkflow('plan-cancel',activeProject.id,requestId).catch(()=>{});
  },{once:true});
}

const workflowMessages = new Map([
  ['Enter a goal and acceptance criteria (up to 16,000 characters each).', '请填写任务目标和验收标准，每项最多 16,000 字符。'],
  ['Choose distinct candidates in priority order for each stage.', '请分别为执行和验收阶段选择角色并排好顺序。同一阶段不能重复选择同一个角色。'],
  ['Choose 1 to 20 rounds.', '最多轮数须为 1 到 20 之间的整数。'],
  ['Choose a Codex or Claude role to moderate the workflow.', '请选择可以在当前项目运行的 Codex 或 Claude 角色担任主持人。'],
  ['The moderator could not select a candidate. Check the moderator output before continuing.', '主持人未能选出候选角色。请查看主持人任务输出或调整选人方式后继续。'],
  ['The moderator returned an invalid workflow candidate.', '主持人返回的角色不在当前阶段的候选范围内，或返回格式有误。'],
  ['The workflow moderator timed out. Check its output before continuing.', '主持人选人超过 90 秒。请查看主持人任务输出后再继续。'],
  ['The workflow step timed out. Inspect the workspace and task output before retrying.', '当前角色运行超过 30 分钟。请检查工作区和任务输出后再重试。'],
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
  ['No rated role could be selected. Add ratings, select a moderator, or specify roles for this step.', '当前步骤没有可用的评分或主持人推荐。请补评分、选主持人，或为这一步指定名单。'],
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
]);

async function invokeWorkflow(command, ...args) {
  const channel = `workflow-${command}`;
  const restartMessage = '当前后台尚未加载工作流功能。请从「文件 → 退出」完全退出 Relay Desk，再重新打开。';
  if (typeof api[channel] !== 'function') throw new Error(restartMessage);
  try {
    return await api[channel](...args);
  } catch (error) {
    const message = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    if (message === `No handler registered for 'desk:${channel}'`) throw new Error(restartMessage);
    throw new Error(workflowMessages.get(message) || message);
  }
}

function renderGeneratedWorkflow(panel,c) {
  const flow=c.workflow, busy=Boolean(state.running[c.id]);
  const key=JSON.stringify([c.id,flow,busy]);
  if (panel._key===key) return;
  panel._key=key;
  const selectionLabels={ordered:'指定名单',moderator:'主持人选择',ratings:'按评分选择',ratings_fallback:'主持人不可用，按评分选择',backup:'按备用顺序选择'};
  const node=flow.nodes[flow.nodeIndex];
  panel.innerHTML=`<strong>${esc(workflowStatuses[flow.status]||flow.status)} · 步骤 ${flow.nodeIndex+1} / ${flow.nodes.length} · ${esc(node?.title)}</strong>${flow.reason?`<p>${esc(workflowMessages.get(flow.reason)||flow.reason)}</p>`:''}<details><summary>查看工作流步骤</summary>${flow.nodes.map((step,index)=>`<p>${index+1}. ${esc(step.title)} · ${esc(step.domain)} × ${esc(step.duty)} · ${step.mode==='ordered'?'指定名单':'自动选人'}</p>`).join('')}</details><details ${flow.status==='unavailable'?'open':''}><summary>角色运行记录（${flow.attempts.length}）</summary>${flow.attempts.map(attempt=>`<p>步骤 ${attempt.nodeIndex+1} · ${esc(attempt.roleName||role(attempt.roleId)?.name||attempt.roleId)} · ${esc(selectionLabels[attempt.via])}${attempt.score!=null?`（${attempt.score} 分）`:''} · ${esc(workflowStatuses[attempt.status]||attempt.status)}${attempt.selectionReason?' · '+esc(attempt.selectionReason):''}${attempt.reason?' · '+esc(workflowMessages.get(attempt.reason)||attempt.reason):''}</p>`).join('')}</details>`;
  if (busy) return;
  const button=(label,click)=>{const element=document.createElement('button');element.type='button';element.textContent=label;element.onclick=click;panel.append(element);};
  if (flow.status==='complete') {
    button('再次运行',()=>openGeneratedWorkflow(project(),{existing:c,rerun:true}));
    return;
  }
  if (!['paused','unavailable','needs_check'].includes(flow.status)) return;
  const guidance=document.createElement('textarea');guidance.rows=2;guidance.maxLength=16000;guidance.placeholder='为当前步骤补充说明（可选）';guidance.setAttribute('aria-label','补充说明');panel.append(guidance);
  button('调整选人方式',()=>openGeneratedWorkflow(project(),{existing:c}));
  button('重试当前步骤',()=>action(()=>invokeWorkflow('resume',c.id,'retry',guidance.value)));
}

function renderWorkflowStatus(c){
  const flow=c.workflow;
  if(!flow)return;
  $('composer').hidden=true;
  $('chat-settings').hidden=true;
  let panel=$('workflow-status');
  if(!panel){panel=document.createElement('section');panel.id='workflow-status';panel.className='setting-card';$('chat-banner').after(panel);}
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
  const targets=state.chats.filter(c=>c.id!==source.id&&!c.disbandedAt).sort((a,b)=>Number(b.projectId===source.projectId)-Number(a.projectId===source.projectId)||b.updatedAt-a.updatedAt);
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
    const ids=targets.find(c=>c.id===targetId)?.roleIds||[];
    const checked=(targetId===proposal?.targetChatId?proposal.recipientIds:ids.length===1?ids:[]).filter(id=>ids.includes(id));
    $('handoff-roles').innerHTML=ids.map(id=>`<label><input type="checkbox" value="${esc(id)}" ${checked.includes(id)?'checked':''}>${esc(role(id)?.name)}</label>`).join('');
    setOrder(checked);
  };
  $('handoff-roles').onchange=syncOrder;
  $('handoff-chat').onchange=refresh;refresh();
}
function addChatActions(source) {
  $('dialog-body').insertAdjacentHTML('afterbegin','<div class="tool-actions"><button type="button" id="chat-branch">新建会话分支</button><button type="button" id="chat-handoff">转交任务</button></div>');
  $('chat-branch').disabled=!source.roleIds.some(id=>role(id));
  $('chat-handoff').disabled=!state.chats.some(c=>c.id!==source.id&&!c.disbandedAt);
  $('chat-branch').onclick=()=>{$('dialog').close();openBranch(source);};
  $('chat-handoff').onclick=()=>{$('dialog').close();openHandoff(source);};
}
function openChat(c, preferredRole) {
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
  const targetProjectId = projectId;
  let picker,orderPicker;
  let defaultReplies = new Set(c?.defaultReplyRoleIds || []);
  dialog(`<h2>${c ? '对话设置' : '新建对话'}</h2><label>对话名称<input id="c-name" value="${esc(c?.name || '')}" placeholder="可留空，使用角色名或项目讨论组"></label><div class="role-picker-heading"><h3>选择参与角色</h3><span class="hint">选一位单聊，选多位群聊</span></div><div id="chat-role-picker"></div>${c ? '<button type="button" id="chat-delete" class="quiet">删除对话并存入归档</button>' : ''}`, async () => {
    const selected = orderPicker.selected();
    const defaults = selected.filter(id => defaultReplies.has(id));
    const value = { id: c?.id, projectId: targetProjectId, name: $('c-name').value, roleIds: selected, defaultReplyRoleIds: defaults,moderatorRoleId:$('c-moderator').value,moderatorCompression:$('c-moderator-compression').checked };
    if (c) { await api['chat-save'](value); } else { const result = await api['chat-add'](value); chatId = result.id; }
    renderSidebar(); activateChat();
  }, c ? '保存' : '创建对话');
  $('dialog').classList.add('role-selection-dialog');
  if(c)addChatActions(c);
  if(c)$('dialog-body').insertAdjacentHTML('afterbegin','<p class="hint">保存后下次运行生效；交互连接需重新建立。</p>');
  if(c?.roleIds.length>1){
    $('dialog-body').insertAdjacentHTML('beforeend','<button type="button" id="chat-disband" class="quiet">解散群聊</button>');
    $('chat-disband').onclick=()=>action(async()=>{
      if(!confirm('解散这个群聊？聊天记录会保留，群聊将不能继续发送消息。'))return;
      clearTimeout(draftTimer);
      await api.draft(c.id,$('input').value);
      await api['chat-disband'](c.id);$('dialog').close();state=await api.snapshot();renderList();activateChat();
    });
    $('dialog-body').insertAdjacentHTML('beforeend','<section class="setting-card"><h3>讨论工具</h3><p class="hint">总结共识、分歧和下一步，消耗模型额度。</p><button type="button" id="chat-summary" class="quiet">总结讨论</button></section>');
    $('chat-summary').disabled=Boolean(state.inputBusy?.[c.id]||state.running[c.id]||c.inputQueue?.length);
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
  let moderatorConfigured=false;
  const refreshModerator=ids=>{refreshDefaults(ids);const selected=moderatorConfigured?$('c-moderator').value:c?.moderatorRoleId||'';moderatorConfigured=true;const eligible=ids.filter(id=>role(id)?.engine!==geminiWebEngine);$('c-moderator').innerHTML=options([['','不指定（各角色共同判断）'],...eligible.map(id=>[id,role(id)?.name||id])],eligible.includes(selected)?selected:'');$('chat-moderator-settings').hidden=ids.length<2||!eligible.length;$('c-moderator-compression').disabled=!$('c-moderator').value;};
  $('c-moderator').onchange=()=>{$('c-moderator-compression').disabled=!$('c-moderator').value;};
  picker = window.createRolePicker($('chat-role-picker'), { roles: state.roles, selected: c?.roleIds || (preferredRole ? [preferredRole] : []), projectRoleIds: project().roleIds, locationName: id => locationOf(id)?.name, onChange: ids => { $('dialog-form').querySelector('button[type=submit]').disabled = ids.length === 0;const order=orderPicker.selected().filter(id=>ids.includes(id));for(const id of ids)if(!order.includes(id))order.push(id);orderPicker.set(order);$('chat-speaking-settings').hidden=ids.length<2;refreshModerator(order); } });
  if (c) $('chat-delete').onclick = () => action(async () => { if (!confirm('从新界面删除此对话？本机归档仍会保留。')) return; await api['chat-delete'](c.id); $('dialog').close(); chatId = chats()[0]?.id; activateChat(); });
}
function editRole(r) {
  roleModelPicker?.destroy();
  roleId = r?.id; renderList();
  const value = r || { name: '', avatar: 0, avatarId: 'preset-gpt', avatarUrl: '../assets/model-avatars/gpt.jpg', description: '', persona: '', examples: '', engine: 'codex', provider: 'native', locationId: 'local', model: '', effort: 'medium', executable: '', permission: 'workspace-write' };
  $('editor-view').innerHTML = `<form class="editor" id="role-form"><header><h1>${r ? '编辑角色' : '新建角色'}</h1>${r ? '<button type="button" id="role-usage-open">查看额度</button>' : ''}${r ? `<button type="button" id="role-delete" class="quiet" title="删除角色">${icon('trash')}</button>` : ''}</header><div class="role-identity"><div class="avatar-picker" id="avatar-picker">${avatar(value, 'large')}<button type="button" title="选择或上传头像" aria-label="选择或上传头像">${icon('camera')}</button></div><label>昵称<input id="r-name" value="${esc(value.name)}" placeholder="给角色起个名字" required></label></div><label class="field"><span>角色设定</span><small class="hint">描述角色背景、职责和性格</small><textarea id="r-persona" placeholder="你希望 TA 是谁？擅长什么？有哪些做事原则？">${esc(value.persona)}</textarea></label><label class="field examples"><span>发言风格示例</span><small class="hint">填写示例对话供角色模仿</small><textarea id="r-examples" placeholder="我：这个方案靠谱吗？&#10;角色：我先检查边界条件，再把需要验证的地方单独列出来。">${esc(value.examples)}</textarea></label><details id="role-connection"><summary>连接配置 <small>${esc(engineLabel(value.engine))} · ${esc(locationOf(value.locationId)?.name || '本机')} · ${esc(value.provider === 'native' ? '原生账号' : value.provider)}</small></summary><div class="form-grid"><label>智能体<select id="r-engine">${options(engineChoices,value.engine)}</select></label><label>运行位置<select id="r-location">${options(state.locations.filter(l => l.type === 'local' || l.os === 'linux').map(l => [l.id,l.name]),value.locationId)}</select></label><label>网络代理<select id="r-proxy">${options([['inherit','跟随所在位置'],['direct','不使用代理（直连）'],['proxy','使用位置代理']],value.proxyMode || 'inherit')}</select><small class="hint" id="r-proxy-hint"></small></label><label>服务来源<select id="r-provider">${options([['native','原生账号 / 已登录的 Agent'],['openai','OpenAI API'],['gemini','Gemini API'],['deepseek','DeepSeek API'],['moonshot','Kimi / Moonshot API']],value.provider)}</select></label><label>角色默认模型<div id="role-model-picker"></div><small class="hint">对话未指定模型时使用此值。</small></label><label>推理强度<select id="r-effort">${options([['','默认'],['low','低'],['medium','中'],['high','高'],['xhigh','很高']],value.effort)}</select></label><label>Agent 运行权限<select id="r-permission">${options([['workspace-write','允许修改工作目录'],['read-only','只读'],['danger-full-access','完全权限（无沙箱、不弹审批）']],value.permission)}</select><small id="permission-hint" class="hint"></small></label><label class="wide">API 密钥<input id="r-key" type="password" autocomplete="new-password" placeholder="${value.hasKey ? '已加密保存；留空保持不变' : '仅 API Provider 需要'}"></label><label class="wide">API 地址（可选）<input id="r-url" value="${esc(value.baseUrl || '')}" placeholder="留空使用 Provider 官方地址"></label><label class="wide">Agent 可执行文件（可选）<div style="display:flex;gap:8px"><input id="r-executable" style="flex:1" value="${esc(value.executable)}" placeholder="留空自动检测原生可执行文件"><button type="button" id="exe-pick">选择</button></div></label><label class="wide">列表简介<input id="r-description" value="${esc(value.description)}" placeholder="简短描述这个角色"></label></div><div class="checks"><label><input id="r-location-tools" type="checkbox" ${value.allowLocationTools !== false ? 'checked' : ''}>允许使用项目位置工具（SSH / Windows-MCP）</label></div><p class="hint">位置工具使用 SSH 用户或桌面服务权限，独立于 Agent 沙箱。</p><div style="display:flex;gap:8px;margin-top:13px"><button type="button" id="role-login">${icon('login')}登录原生账号</button></div></details><div class="form-actions"><span class="hint">更新将在下次发言时生效</span><button class="primary" type="submit">保存角色</button></div></form><aside class="role-preview"><header><h2>回复预览</h2><span class="pill">仅示例</span></header><div class="preview-question">帮我看看这段代码可能有什么问题。</div><div class="preview-reply"><div id="preview-avatar">${avatar(value)}</div><div><b id="preview-name">${esc(value.name || '新角色')}</b><p id="preview-text">${esc(value.examples || '填写示例后可在此预览。')}</p></div></div><button type="button" id="role-try">${icon('send')}开始单聊试用</button><p class="hint">试用会创建对话并消耗模型额度。</p></aside>`;
  const personaSection=document.createElement('details');personaSection.id='role-persona';
  personaSection.innerHTML='<summary>人设与发言风格 <small>可选设置</small></summary><div class="role-persona-content"><div class="role-persona-fields"></div></div>';
  const personaFields=personaSection.querySelector('.role-persona-fields');
  personaFields.append($('r-persona').closest('label'),$('r-examples').closest('label'),$('r-description').closest('label'));
  personaSection.querySelector('.role-persona-content').append($('editor-view').querySelector('.role-preview'));
  $('role-form').insertBefore(personaSection,$('role-form').querySelector('.form-actions'));
  const ratingsSection=document.createElement('details');
  ratingsSection.id='role-workflow-ratings';
  $('role-form').insertBefore(ratingsSection,$('role-form').querySelector('.form-actions'));
  const readRatings=window.deskWorkflowUI.editRatings(ratingsSection,value.workflowRatings||[],window.deskWorkflowRatings.catalog(state.roles));
  $('role-try').type='button';
  $('r-provider').closest('label').insertAdjacentHTML('afterend', `<label id="r-login-source-field">Codex 登录来源<select id="r-login-source">${options([['isolated','独立登录（此角色专用）'],['desktop','复用桌面版 Codex 登录']],value.codexLoginSource || 'isolated')}</select><small class="hint" id="r-login-source-hint"></small></label>`);
  $('r-login-source-field').insertAdjacentHTML('afterend','<div id="r-desktop-tools-field" class="wide"><div class="desktop-tool-inheritance"><strong id="r-desktop-tools-status"></strong><button type="button" id="r-desktop-tools-toggle" aria-describedby="r-desktop-tools-status"></button></div><input type="checkbox" id="r-desktop-tools" '+(value.codexDesktopTools===false?'':'checked')+' hidden><small class="hint">继承桌面版已启用的 MCP 和插件，适用于发言和主持人。关闭后仅使用本工具提供的工具。</small></div>');
  const loginSource = () => $('r-login-source').disabled ? 'isolated' : $('r-login-source').value;
  const refreshLoginSource = () => {
    const enabled = $('r-engine').value === 'codex' && $('r-provider').value === 'native' && $('r-location').value === 'local';
    $('r-login-source-field').hidden = !enabled; $('r-login-source').disabled = !enabled;
    const shared = enabled && loginSource() === 'desktop';
    $('r-desktop-tools-field').hidden=!shared;$('r-desktop-tools').disabled=!shared;
    $('r-desktop-tools-status').textContent=$('r-desktop-tools').checked?'已继承桌面版 MCP 和插件':'已关闭桌面工具继承';$('r-desktop-tools-toggle').textContent=$('r-desktop-tools').checked?'关闭继承':'开启继承';$('r-desktop-tools-toggle').disabled=!shared;
    $('r-login-source-hint').textContent = shared ? '共用桌面版账号；切换或退出登录会影响共用角色。' : '此角色单独登录账号。';
    $('role-login').innerHTML = icon('login') + (shared ? '检查桌面版登录' : $('r-engine').value===geminiWebEngine?'在浏览器打开 Gemini':$('r-engine').value==='workbuddy'?'打开 WorkBuddy 登录':vendorKinds[$('r-engine').value]?'登录 '+vendorKinds[$('r-engine').value]+' 账号':'登录原生账号');
  };
  for (const id of ['r-engine','r-provider','r-location','r-login-source']) $(id).addEventListener('change',refreshLoginSource); refreshLoginSource();
  $('r-desktop-tools-toggle').onclick=()=>{$('r-desktop-tools').checked=!$('r-desktop-tools').checked;refreshLoginSource();};
  $('role-connection').querySelector('summary').insertAdjacentHTML('afterend','<section class="agent-runtime-card" id="agent-runtime-card" hidden><strong id="agent-runtime-title"></strong><p class="hint" id="agent-runtime-help"></p><p class="hint" id="agent-runtime-status"></p><div class="agent-runtime-actions"><button type="button" id="agent-runtime-detect">检测引擎</button><button type="button" id="agent-runtime-install" hidden>安装 / 更新官方 CLI（本工具独立目录）</button><button type="button" id="agent-runtime-account" hidden>改用官方 CLI 账号（无需 API Key）</button><button type="button" id="agent-runtime-guide">官方安装 / 登录说明</button></div></section>');
  let runtimeRequest=0;const runtimeCard=$('agent-runtime-card');
  runtimeCard.insertAdjacentHTML('afterend','<p id="gemini-web-role-hint" class="hint" hidden>使用默认浏览器登录。通过复制和粘贴转接文字，点击对话头像可绑定网页链接。</p>');
  const detectRuntime=async()=>{const engine=$('r-engine').value;if(!vendorKinds[engine])return;const request=++runtimeRequest;$('agent-runtime-status').textContent='正在检测本机引擎…';const info=await api['agent-info']({engine,executable:$('r-executable').value});if(!runtimeCard.isConnected||request!==runtimeRequest||$('r-engine').value!==engine)return;$('agent-runtime-status').textContent=info.installed?(info.source==='desktop-engine'?'已找到桌面引擎，兼容性待验证':'已找到官方引擎，可登录账号'):'未检测到引擎，请安装官方 CLI 或选择运行时文件。'+(info.error?' '+info.error:'');};
  function refreshAgentKind(){
    const engine=$('r-engine').value,vendor=Boolean(vendorKinds[engine]);runtimeCard.hidden=!vendor;$('agent-runtime-install').hidden=!['kimi','codebuddy','antigravity'].includes(engine);$('agent-runtime-account').hidden=engine!=='workbuddy';$('r-provider').disabled=engine!=='codex';if(engine!=='codex')$('r-provider').value='native';
    const web = engine === geminiWebEngine;
    for(const option of $('r-location').options)option.disabled=(vendor||web)&&option.value!=='local';if((vendor||web)&&$('r-location').value!=='local')$('r-location').value='local';
    for (const id of ['r-location','r-proxy','r-provider','role-model-picker','r-effort','r-permission','r-key','r-url','r-executable','r-location-tools']) $(id).closest('label').hidden=web;
    for (const id of ['r-proxy-hint','permission-hint']) $(id).hidden=web;
    $('r-location-tools').closest('.checks').nextElementSibling.hidden=web;
    $('gemini-web-role-hint').hidden=!web;
    $('r-effort').disabled=!supportsEffort(engine);if(!supportsEffort(engine))$('r-effort').value='';
    $('r-key').disabled=$('r-provider').value==='native';$('r-url').disabled=$('r-provider').value==='native';
    if(vendor){$('agent-runtime-title').textContent=vendorKinds[engine]+' · 官方账号优先';$('agent-runtime-help').textContent=engine==='antigravity'?'使用 Google 账号登录；模型以列表为准，额度可用 /usage 查看。':engine==='workbuddy'?'桌面引擎登录尚未兼容，请改用官方 CLI，以 WorkBuddy 同站点、同账号登录。':engine==='kimi'?'使用 Kimi Code 账号登录，首次需浏览器授权。':engine==='cursor'?'使用 Cursor 账号登录，可能需单独完成浏览器授权。':'使用 WorkBuddy 同站点、同账号登录 CLI；各角色共用登录，额度按站点和套餐计算。';if($('role-connection').open)action(detectRuntime);}
    refreshLoginSource();
  }
  $('r-engine').addEventListener('change',refreshAgentKind);$('r-provider').addEventListener('change',refreshAgentKind);refreshAgentKind();
  $('agent-runtime-account').onclick=()=>{ $('r-executable').value='';$('r-url').value='';$('r-effort').value='';$('r-model').value='';$('r-engine').value='codebuddy';$('r-engine').dispatchEvent(new Event('change'));toast('已切换到官方 CLI。保存后用 WorkBuddy 同站点、同账号登录。'); };
  $('agent-runtime-install').onclick=()=>action(async()=>{const engine=$('r-engine').value,button=$('agent-runtime-install');button.disabled=true;button.textContent='正在安装官方 CLI…';try{const result=await api['agent-install'](engine);if(runtimeCard.isConnected&&$('r-engine').value===engine){if(!$('r-executable').value)$('r-executable').value=result.executable;await detectRuntime();roleModelPicker?.reset();toast('官方 CLI '+result.version+' 已安装，请登录账号');}}finally{if(button.isConnected){button.disabled=false;button.textContent='安装 / 更新官方 CLI（本工具独立目录）';}}});
  $('agent-runtime-detect').onclick=()=>action(detectRuntime);$('agent-runtime-guide').onclick=()=>action(()=>api['agent-guide']($('r-engine').value));
  $('role-connection').addEventListener('toggle',()=>{if($('role-connection')?.open&&runtimeCard.isConnected)action(detectRuntime);});
  let editorModels=[];
  const editorOffering=()=>modelOffering(editorModels,$('r-model').value.trim());
  const syncEditorEfforts=(selected,promote=false)=>renderEfforts($('r-effort'),editorOffering(),selected,{promote});
  const catalogDraft=()=>({ id:r?.id, engine:$('r-engine').value, provider:$('r-provider').value, locationId:$('r-location').value, baseUrl:$('r-url').value, executable:$('r-executable').value, apiKey:$('r-key').value, proxyMode:$('r-proxy').value, codexLoginSource:loginSource() });
  roleModelPicker = window.createModelPicker($('role-model-picker'), { value:value.model, load:force=>api.models(catalogDraft(),{force}), onCatalog:models=>{
    editorModels=models;
    syncEditorEfforts($('r-effort').value);
    if(models.length&&r)api.models(r.id,{cacheOnly:true}).then(result=>{
      if(result.models?.length)receiveRoleCatalog(r.id,result.models);
    }).catch(()=>{});
  } });
  $('r-model').addEventListener('change',()=>syncEditorEfforts($('r-effort').value,true));
  syncEditorEfforts(supportsEffort(value.engine)?value.effort||'':'');
  const picker = roleModelPicker;
  $('role-connection').addEventListener('toggle', () => { if ($('role-connection')?.open && picker === roleModelPicker && $('r-engine').value!==geminiWebEngine) picker.update(); });
  for (const id of ['r-engine','r-provider','r-location','r-key','r-url','r-executable','r-proxy','r-login-source']) $(id).addEventListener('change', () => { picker.reset(); if ($('role-connection').open && $('r-engine').value!==geminiWebEngine) picker.update(); });
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
  const save = async () => { assertEffort(editorOffering(),$('r-effort').value); const next = await api['role-save']({ id: r?.id, name: $('r-name').value, avatar: selectedAvatar, avatarId: selectedAvatarId, persona: $('r-persona').value, examples: $('r-examples').value, engine: $('r-engine').value, provider: $('r-provider').value, locationId: $('r-location').value, model: $('r-model').value, effort: $('r-effort').value, apiKey: $('r-key').value, baseUrl: $('r-url').value, executable: $('r-executable').value, description: $('r-description').value, permission: $('r-permission').value, proxyMode: $('r-proxy').value, codexLoginSource:loginSource(), codexDesktopTools:$('r-desktop-tools').checked, allowLocationTools: $('r-location-tools').checked, workflowRatings:readRatings() }); roleId = next.id; roleCatalogs.delete(next.id); return next; };
  $('role-connection').open=true;
  $('role-form').onsubmit = e => { e.preventDefault(); action(async () => { const next = await save();toast('角色已保存，下次发言生效'); editRole({...role(next.id),...next}); }); };
  $('exe-pick').onclick = () => action(async () => { const files = await api.pick('file'); if (files[0]) $('r-executable').value = files[0]; });
  $('role-login').onclick = () => action(async () => { if($('r-engine').value===geminiWebEngine)return api['gemini-web-open']();const next = await save(); await loginRole(next.id); });

  $('role-try').onclick = () => action(async () => { const next = await save(); if (!project()) { toast('请先创建项目'); return; } const p = project(); if (!p.roleIds.includes(next.id)) await api['project-save']({ ...p, roleIds: [...p.roleIds, next.id] }); showPage('projects'); openChat(null,next.id); });
  if ($('role-delete')) {
    $('role-delete').append(' 删除角色');
    $('role-delete').onclick = () => action(async () => { if (confirm('删除这个角色？聊天记录会保留。')) { await api['role-delete'](r.id); state=await api.snapshot();editRole(state.roles[0]); } });
  }
}
function editLocation(l) {
  locationId = l?.id; renderList(); const local = l?.id === 'local'; const managed = l?.managed;
  $('editor-view').innerHTML = `<form class="editor simple-form" id="location-form"><header><h1>${local ? '本机' : l ? '编辑位置' : '添加位置'}</h1>${l && !local && !managed ? `<button type="button" id="location-delete" class="quiet">${icon('trash')}</button>` : ''}</header><label class="field"><span>位置名称</span><input id="l-name" value="${esc(l?.name || '')}" ${local ? 'disabled' : 'required'} placeholder="例如：开发服务器"></label><div class="setting-card"><h3>1. 连接方式</h3><div class="form-grid"><label>连接方式<select disabled><option>${local ? '本地（内置）' : 'SSH'}</option></select></label><label>操作系统<select id="l-os" ${local || managed ? 'disabled' : ''}>${options([['linux','Linux'],['windows','Windows']],l?.os || 'linux')}</select></label>${!local ? `<label>主机地址<input id="l-host" value="${esc(l?.host || '')}" required ${managed ? 'disabled' : ''}></label><label>端口<input id="l-port" type="number" value="${l?.port || 22}" min="1" max="65535" required ${managed ? 'disabled' : ''}></label><label>SSH 用户<input id="l-user" value="${esc(l?.username || '')}" required ${managed ? 'disabled' : ''}></label><label>私钥口令（可选）<input id="l-passphrase" type="password" autocomplete="new-password" placeholder="留空保持不变"></label><label class="wide">私钥路径（留空使用 SSH Agent）<input id="l-key" value="${esc(l?.keyPath || '')}" ${managed ? 'disabled' : ''}></label>` : ''}</div>${managed ? '<p style="margin-top:15px">地址和密钥在原界面修改。共享 MCP／隧道时，请保持提供服务的界面运行。</p>' : ''}</div><div class="setting-card"><h3>2. Agent 操控方式</h3><p>SSH 用于命令、文件和终端；Windows-MCP 用于桌面操作。</p><label class="field"><span>操控方式</span><select id="l-control" ${local ? 'disabled' : ''}>${options(local ? [['ssh','本地命令 / 终端']] : [['ssh','SSH 命令与文件'],['windows-mcp','Windows-MCP 桌面操作']],l?.control || 'ssh')}</select></label>${!local ? `<label class="field"><span>Windows-MCP 地址（选择 MCP 时必填）</span><input id="l-mcp" value="${esc(l?.mcpUrl || '')}" placeholder="http://127.0.0.1:8111/mcp"></label><label class="field"><span>MCP 访问令牌</span><input id="l-token" type="password" autocomplete="new-password" placeholder="留空保持已保存值"></label>` : ''}<p>MCP 地址须能从 Agent 所在机器访问。</p></div><div class="setting-card"><h3>3. 模型服务代理</h3><p>角色默认使用此代理，可单独选择直连。</p><label class="field"><span>默认代理方式</span><select id="l-proxy-mode">${options([['system',local ? '跟随 Windows 系统代理' : '继承服务器代理环境变量'],['direct','不使用代理（直连）'],['custom','自定义 HTTP / HTTPS 代理']],l?.proxy?.mode || 'system')}</select></label><label class="field" id="l-proxy-address"><span>代理地址</span><input id="l-proxy-url" value="${esc(l?.proxy?.url || '')}" placeholder="http://127.0.0.1:7890"></label><p>${local ? '127.0.0.1 指当前电脑。' : '127.0.0.1 指服务器自身。'}支持 HTTP／HTTPS，无账号密码认证。</p></div><div id="location-test-result" class="hint"></div><div class="form-actions"><button type="button" id="location-test">${icon('refresh')}测试连接</button><button type="submit" class="primary">保存位置</button></div></form>`;
  const proxyValue = () => ({ mode: $('l-proxy-mode').value, url: $('l-proxy-url').value });
  $('l-proxy-mode').onchange = () => { $('l-proxy-address').hidden = $('l-proxy-mode').value !== 'custom'; }; $('l-proxy-mode').onchange();
  const save = async () => local ? api['location-proxy-save'](l.id, proxyValue()) : api['location-save']({ id: l?.id, name: $('l-name').value, host: $('l-host').value, port: Number($('l-port').value), username: $('l-user').value, keyPath: $('l-key').value, passphrase: $('l-passphrase').value, os: $('l-os').value, control: $('l-control').value, mcpUrl: $('l-mcp').value, mcpToken: $('l-token').value, proxy: proxyValue() });
  $('location-form').onsubmit = e => { e.preventDefault(); action(async () => { const next = await save(); toast('位置已保存'); editLocation(locationOf(next.id)); }); };
  $('location-test').onclick = () => action(async () => { $('location-test-result').textContent = '正在连接…'; const next = await save(); const result = await api['location-test'](next.id); $('location-test-result').textContent = result; });
  if ($('location-delete')) $('location-delete').onclick = () => action(async () => { if (confirm('删除这个位置？')) { await api['location-delete'](l.id); editLocation(state.locations[0]); } });
}
function renderSettings() {
  $('editor-view').innerHTML = `<form class="editor simple-form" id="settings-form"><header><h1>通用设置</h1></header><div class="setting-card"><h3>运行与唤醒</h3><div class="checks"><label><input type="checkbox" id="s-awake" ${state.settings.keepAwake ? 'checked' : ''}>保持电脑唤醒（前台和后台）</label></div><p>防止自动休眠和屏保；手动锁屏仍由 Windows 管理。</p><label class="field"><span>同时运行的讨论上限</span><input id="s-limit" type="number" min="1" max="8" value="${state.settings.maxJobs}"></label><p>群聊中的角色依次发言。</p></div><div class="setting-card"><h3>外观</h3><label class="field"><span>界面主题</span><select id="s-theme">${options([['system','跟随系统'],['light','浅色'],['dark','深色（夜间模式）']], state.settings.theme)}</select></label><p>切换后立即生效。</p></div><div class="setting-card"><h3>本机 Codex CLI</h3><p>管理本工具使用的 Codex CLI；更新前请暂停相关任务。</p><div style="display:flex;gap:9px"><button type="button" id="cli-check">检查更新</button><button type="button" id="cli-update">升级托管 CLI</button></div><p id="cli-result" style="margin-top:10px"></p></div><div id="claude-updater"></div><div class="form-actions"><span class="hint">设置保存后即时生效</span><button class="primary" type="submit">保存设置</button></div></form>`;
  $('settings-form').onsubmit = e => { e.preventDefault(); action(async () => { await api.settings({ keepAwake: $('s-awake').checked, maxJobs: Number($('s-limit').value), theme: $('s-theme').value }); toast('设置已保存'); }); };
  $('s-theme').onchange = () => action(() => api.settings({ ...state.settings, theme: $('s-theme').value }));
  claudeUpdateView = window.createClaudeUpdateView($('claude-updater'), { request: operation => api['claude-cli'](operation), error: problem => toast(problem.message) });
  claudeUpdateView.render(state.claudeUpdate);
  for (const name of ['check','update']) $('cli-' + name).onclick = () => action(async () => { $('cli-result').textContent = name === 'check' ? '正在检查…' : '正在升级托管 CLI…'; const result = await api['cli-' + name](); $('cli-result').textContent = result.message || JSON.stringify(result); });
}
function renderToolDirectory() { const select = $('tool-directory'); const previous = select.value; select.innerHTML = options((project()?.directories || []).map((d,i) => [i, (locationOf(d.locationId)?.name || d.locationId) + ' · ' + d.path]), previous || 0); }
async function openTools(mode) { if (!project()) return; toolMode = mode; $('tools-panel').hidden = false; $('tools-rail').hidden = true; $('terminal-tools').hidden = mode !== 'terminal'; $('file-tools').hidden = mode !== 'files'; $('activity-tools').hidden = mode !== 'activity'; $('tool-directory').hidden = mode === 'activity'; $('tools-title').textContent = ({ terminal:'项目终端', files:'项目文件', activity:'对话任务输出' })[mode]; renderToolDirectory(); if (mode === 'files') await loadFiles(); else if (mode === 'activity') {agentTerminals=await api['agent-terminals']();renderActivity();} else { await refreshTerminals(); if (!terminals.some(t => t.projectId === projectId)) toast('点击加号打开此项目的共享终端'); fitTerminal(); } }
function renderActivity() {
  const c = chat(); const ids = c?.roleIds || [];
  if (!ids.includes(activityRoleId)) { activityRoleId = state.running[c?.id]?.roleId || ids[0]; activityRunId = undefined; }
  $('activity-role').innerHTML = options(ids.map(id => [id,role(id)?.name || id]),activityRoleId);
  const interactive=activityMode==='interactive';
  $('activity-mode').value=activityMode;$('activity-host').hidden=interactive;$('agent-terminal-host').hidden=!interactive;$('activity-run').hidden=interactive;
  $('agent-terminal-start').hidden=!interactive;$('agent-terminal-end').hidden=!interactive;
  if($('agent-terminal-active-log'))$('agent-terminal-active-log').hidden=true;
  if(interactive){renderAgentTerminal();return;}
  $('activity-hint').textContent='选中文字后 Ctrl+C 或右键复制；点击路径链接打开文件。可切换到交互终端操作 Claude / Codex。';
  const runs = (c?.messages || []).filter(m => m.kind === 'assistant' && m.roleId === activityRoleId);
  if (activityFollow || !runs.some(m => m.id === activityRunId)) activityRunId = runs.at(-1)?.id;
  $('activity-run').innerHTML = options(runs.slice().reverse().map(m => [m.id, new Date(m.at).toLocaleTimeString('zh-CN') + ' · ' + ({ running:'运行中', complete:'完成', failed:'失败', cancelled:'暂停', interrupted:'中断' }[m.status] || m.status)]),activityRunId);
  if (!activityView) {
    const element = document.createElement('div'); element.className = 'terminal-container'; $('activity-host').append(element);
    const term = new Terminal({ fontSize:14, fontFamily:'Cascadia Mono, Consolas, monospace', theme:{ background:'#18202a', foreground:'#e0e8ed' }, disableStdin:true, convertEol:true, scrollback:8000, cursorBlink:false });
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(element);
    window.relayTerminalUI.installCopy(term,element,{copy:text=>api.copy(text),readOnly:true,error:e=>toast(e.message)});
    window.relayTerminalUI.installLinks(term,{openPath:value=>api.open(value,chat()?.projectId),openLink:value=>api.open(value,chat()?.projectId),error:e=>toast(e.message)});
    activityView = { term,fit,source:'',output:'' };
  }
  const message = runs.find(m => m.id === activityRunId);
  const output = message ? (message.terminal || [message.thinking ? '[Reasoning summary]\r\n' + message.thinking : '',message.text || '',message.note || ''].filter(Boolean).join('\r\n\r\n') || '[Waiting for CLI output]') : '[No task output in this chat yet]';
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
  const blocked=chat()?.disbandedAt?'群聊已解散，聊天记录只读。':!supported?'此角色暂不支持交互终端。请使用任务日志或项目终端。':pending||current?.state==='opening'?'正在建立交互连接，请稍候。':active?'此角色的交互终端已连接。':job?'本对话正在由 '+jobName+(job.stopping?' 停止任务':' 执行'+(job.phase==='compact'?'历史压缩':job.phase==='review'?'讨论判断':'任务'))+'，暂不能另开交互终端。请等待结束，或在聊天区暂停任务后连接。':'';
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
    window.relayTerminalUI.installLinks(term,{openPath:value=>api.open(value,current.projectId),openLink:value=>api.open(value,current.projectId),error:e=>toast(e.message)});
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
  window.relayTerminalUI.installLinks(term,{openPath:value=>api.open(value,info.projectId),openLink:value=>api.open(value,info.projectId),error:e=>toast(e.message)});
  if (info.output) term.write(info.output); const view = { element, term, fit, sequence: info.sequence || 0 }; terminalViews.set(info.id,view); return view;
}
function fitTerminal() { requestAnimationFrame(() => { if (!$('tools-panel').hidden) try { if (toolMode === 'terminal') terminalViews.get(terminalId)?.fit.fit(); else if (toolMode === 'activity') {if(activityMode==='interactive')agentTerminalViews.get(selectedAgentTerminal()?.id)?.fit.fit();else activityView?.fit.fit();} } catch {} }); }
async function loadFiles(operation = 'list') {
  if (!project()) return;
  const result = await api.files(projectId,Number($('tool-directory').value),fileParts,operation); filePath = result.path; $('file-path').textContent = result.path;
  $('file-list').hidden = operation !== 'list'; $('file-preview').hidden = operation === 'list'; $('file-back').hidden = operation === 'list'; $('file-open').hidden = operation === 'list';
  if (operation === 'list') {
    $('file-list').innerHTML = result.entries.sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map((e,i) => `<button class="file-row" data-file="${i}">${icon(e.directory ? 'folder' : 'file')}<span>${esc(e.name)}</span></button>`).join('');
    const sorted = result.entries; document.querySelectorAll('[data-file]').forEach(b => { b.onclick = () => action(async () => { const entry = sorted[Number(b.dataset.file)]; fileParts.push(entry.name); try { await loadFiles(entry.directory ? 'list' : 'read'); } catch (e) { fileParts.pop(); throw e; } }); });
    if (result.truncated) toast('目录文件较多，仅显示前 600 项');
  } else $('file-preview').textContent = result.binary ? '二进制文件暂不支持文本预览。' : result.text + (result.truncated ? '\n\n[预览已截断]' : '');
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
    const meta=document.createElement('small');const size=file.sizeBytes<1024?file.sizeBytes+' B':file.sizeBytes<1048576?(file.sizeBytes/1024).toFixed(1)+' KiB':(file.sizeBytes/1048576).toFixed(1)+' MiB';meta.textContent=(file.width?file.width+'×'+file.height+' · ':'')+size+' · 本机路径';details.append(name,meta);open.append(image,details);open.onclick=()=>action(()=>api.open(file.path,targetProjectId));
    const copy=document.createElement('button');copy.type='button';copy.className='attachment-copy';copy.innerHTML=icon('copy');copy.title='复制文件路径';copy.setAttribute('aria-label','复制 '+file.name+' 的路径');copy.onclick=()=>action(async()=>{await api.copy(file.path);toast('已复制文件路径');});card.append(open,copy);
    if(remove){const button=document.createElement('button');button.type='button';button.className='attachment-remove';button.innerHTML=icon('x');button.title='移除附件';button.setAttribute('aria-label','移除 '+file.name);button.onclick=()=>action(()=>remove(file.id));card.append(button);}
    container.append(card);
  }
}
function renderAttachments(){
  const c=chat(),files=c?.draftAttachments||[],pending=attachmentTasks.get(c?.id)||0;
  attachmentCards($('attachments'),files,{projectId:c?.projectId,remove:async id=>{try{const next=await api['attachment-remove'](c.id,id);const current=state.chats.find(item=>item.id===c.id);if(current)current.draftAttachments=next;if(chatId===c.id)renderAttachments();}catch(e){toast(attachmentError(e));}}});
  $('attachments').hidden=!files.length&&!pending;
  if(files.length||pending){const hint=document.createElement('small');hint.className='attachment-hint';hint.textContent=pending?'正在添加附件…':'仅发送文件路径，不上传原文件 · 最多 8 个，单个 16 MiB';$('attachments').append(hint);}
  $('send').disabled=Boolean(pending||sendingChats.has(c?.id));
  $('interrupt-send').disabled=$('send').disabled;
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
$('empty-create').onclick = () => filter==='workflow'?openWorkflow():openChat(); $('chat-settings').onclick = () => openChat(chat());
$('dialog-cancel').onclick = $('dialog-close').onclick = () => $('dialog').close();
$('dialog').addEventListener('close', () => { usageCenter?.destroy();usageCenter=undefined;chatModelPicker?.destroy(); chatModelPicker = undefined;markReadAtBottom(); });
$('dialog-form').onsubmit = e => { e.preventDefault(); action(async () => { if (await dialogSubmit() !== false) $('dialog').close(); }); };
$('send').onclick = () => send(); $('pause').onclick = () => action(() => api.pause(chatId));
$('interrupt-send').onclick=()=>send(false,'interrupt');
$('queue-resume').onclick=()=>action(()=>api['queue-resume'](chatId));
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
$('tool-activity').onclick = () => { activityFollow = true; action(() => openTools('activity')); };
$('activity-role').onchange = e => { activityRoleId = e.target.value; activityRunId = undefined; activityFollow = true; renderActivity(); };
$('activity-mode').onchange=e=>{activityMode=e.target.value;renderActivity();};
$('agent-terminal-start').onclick=()=>action(async()=>{const id=chatId,rid=activityRoleId,key=id+':'+rid;terminalConnectPending.add(key);renderActivity();let problem;try{await api['agent-terminal-open'](id,rid);}catch(error){problem=error;}try{agentTerminals=await api['agent-terminals']();}catch(error){problem||=error;}finally{terminalConnectPending.delete(key);if(toolMode==='activity')renderActivity();}if(problem)throw problem;if(chatId===id&&activityRoleId===rid)agentTerminalViews.get(selectedAgentTerminal()?.id)?.term.focus();});
$('agent-terminal-end').onclick=()=>action(async()=>{const t=selectedAgentTerminal();if(t&&confirm('结束此交互终端？正在执行的任务会停止，聊天记录保留。'))await api['agent-terminal-close'](t.id);});
$('activity-run').onchange = e => { activityRunId = e.target.value; activityFollow = activityRunId === chat()?.messages.filter(m => m.kind === 'assistant' && m.roleId === activityRoleId).at(-1)?.id; renderActivity(); };
let activitySelection='';$('activity-copy').onpointerdown=()=>{const view=activityMode==='interactive'?agentTerminalViews.get(selectedAgentTerminal()?.id):activityView;activitySelection=view?.term.getSelection()||'';};
$('activity-copy').onclick = () => action(async () => {const view=activityMode==='interactive'?agentTerminalViews.get(selectedAgentTerminal()?.id):activityView;await api.copy(activitySelection || view?.term.getSelection() || (view?window.relayTerminalUI.text(view.term):'') || '');activitySelection=''; toast('已复制任务输出'); });
$('tools-close').onclick = () => { $('tools-panel').hidden = true; $('tools-rail').hidden = false; document.body.classList.remove('tools-wide'); $('tools-wide').textContent = '展开'; };
$('tools-wide').onclick = () => { document.body.classList.toggle('tools-wide'); $('tools-wide').textContent = document.body.classList.contains('tools-wide') ? '还原' : '展开'; fitTerminal(); };
$('tool-directory').onchange = () => { fileParts = []; if (toolMode === 'files') action(loadFiles); };
$('terminal-new').onclick = () => action(async () => { terminalId = await api['terminal-open'](projectId,Number($('tool-directory').value)); await refreshTerminals(); });
$('terminal-list').onchange = e => { terminalId = e.target.value; refreshTerminalTabs(); terminalViews.get(terminalId)?.term.focus(); };
$('terminal-copy').onclick = () => action(() => api.copy(terminalViews.get(terminalId)?.term.getSelection() || ''));
$('terminal-end').onclick = () => action(() => api['terminal-close'](terminalId));
$('file-up').onclick = () => action(async () => { fileParts.pop(); await loadFiles(); }); $('file-refresh').onclick = () => action(() => loadFiles($('file-preview').hidden ? 'list' : 'read'));
$('file-back').onclick = () => action(async () => { fileParts.pop(); await loadFiles(); }); $('file-open').onclick = () => action(async () => { const d = project().directories[Number($('tool-directory').value)]; if (d.locationId !== 'local') { await api.copy(filePath); toast('已复制远端路径'); } else { const result = await api.open(filePath,projectId); if (result) toast(result); } });
api.on('terminal', event => { if (event.type === 'data') { const view = terminalViews.get(event.id); if (view && event.sequence > view.sequence) { view.term.write(event.data); view.sequence = event.sequence; } } else if (event.type === 'closed') { const view = terminalViews.get(event.id); view?.term.dispose(); view?.element.remove(); terminalViews.delete(event.id); refreshTerminals(); } else refreshTerminals(); });
window.addEventListener('resize',fitTerminal); new ResizeObserver(fitTerminal).observe($('terminal-host')); new ResizeObserver(fitTerminal).observe($('activity-host'));
new ResizeObserver(fitTerminal).observe($('agent-terminal-host'));
api.on('agent-terminal',event=>{
  if(event.type==='data'){const t=agentTerminals.find(t=>t.id===event.id);if(t&&event.sequence>(t.sequence||0)){t.output=((t.output||'')+event.data).slice(-200000);t.sequence=event.sequence;}const view=agentTerminalViews.get(event.id);if(view&&event.sequence>view.sequence){view.term.write(event.data);view.sequence=event.sequence;}}
  else{const index=agentTerminals.findIndex(t=>t.id===event.info.id);if(index<0)agentTerminals.push({...event.info,output:'',sequence:0});else Object.assign(agentTerminals[index],event.info);if(toolMode==='activity'&&activityMode==='interactive')renderActivity();}
});
bindWorkbenchFooter();
api.on('state', value => { state = value; window.applyDeskTheme(value.settings.theme); quotaPanel.render(value); if($('usage-center')&&$('dialog').open)usageCenter?.render(value); if (page === 'settings') claudeUpdateView?.render(value.claudeUpdate); if (!state.chats.some(c => c.id === chatId)) chatId = chats()[0]?.id; renderList(); if (page === 'projects') {renderMessages();renderAttachments();} renderWorkbenchFooter(); renderProjectNotifications(); });
api.on('message', event => { const c=state?.chats.find(x=>x.id===event.chatId); if(!c)return; const previous=c.messages.findIndex(m=>m.id===event.message.id); if(previous<0)c.messages.push(event.message);else c.messages[previous]=event.message; if(page==='projects'&&chatId===c.id)renderMessages();if(event.message.kind==='skill'&&event.message.status!=='running')renderList(); });
action(async () => { state = await api.snapshot(); window.applyDeskTheme(state.settings.theme); projectId = state.projects[0]?.id; chatId = chats()[0]?.id; renderSidebar(); activateChat(); quotaPanel.render(state); });
