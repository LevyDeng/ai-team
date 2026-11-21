const $ = (id) => document.getElementById(id);
const projectTools = window.relayProjectTools.create({ editDirectories: openProjectFolder, report: (error) => notice(errorMessage(error)) });
let workspace = { projects: [], sessions: [] };
let status = {};
let selectedProject = null;
let selectedSession = null;
let pendingSelection = '';
const terminals = new Map();
const activities = [];
const drafts = new Map();
const draftAttempts = new Map();
const outgoingBySession = new Map();
const deliveryLabels = { saved: '本机已备份 · 尚未发送', sending: '正在提交到远端终端', submitted: '已提交到远端终端', unconfirmed: '提交结果未确认', failed: '发送未完成 · 文字已保留', accepted: '远端已确认接收' };
const stagedBySession = new Map();
let unreadSessions = new Map();
let unreadRevisions = new Map();
const readRequests = new Set();
let readCheckTimer = null;
let historyVisible = false;
let composerExpanded = false;
let historyViewRevision = 0;
let historyRequest = 0;
let historyLoadingId = null;
let renderedHistory = { id: null, messages: [] };
let historyBottomTarget = null;
let historyScrollIntent = 0;
const historySearch = window.relayHistorySearch.create($('history-messages'));
let historySearchTimer = null;
let connecting = false;
let sending = false;
let stagingImage = false;
let settingsBusy = false;
let pendingCapacityTarget = null;
let capacitySendWaiter = null;
let capacityBusy = false;
let pendingProjectDelete = null;
let projectDeleteBusy = false;
let editingProjectFolder = null;
let directoryDrafts = [];
let draggedProject = null;
let usageRequestedFor = '';
let lastUsageRender = '';
let usageCollapsed = false;
try { usageCollapsed = localStorage.getItem('relayDesk.usageCollapsed') === 'true'; } catch {}
const usageTimeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
let servicesCollapsed = false;
try { servicesCollapsed = localStorage.getItem('relayDesk.servicesCollapsed') === 'true'; } catch {}
const modelDrafts = new Map();
let applyingModel = '';
const effortLabels = { none: '不使用', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' };
const translations = new Map([
  ['Configure between 1 and 12 project directories.', '请配置 1 到 12 个项目目录。'],
  ['Enter a path for every project directory.', '请填写每个项目目录的路径。'],
  ['Remote directories must start with / or ~/.', '服务器目录须以 / 或 ~/ 开头。'],
  ['Project directories must be unique.', '项目目录不能重复。'],
  ['Select a configured project directory.', '请选择一个已配置的项目目录。'],
  ['Close a project terminal before opening another.', '终端数量已达上限，请先关闭一个终端。'],
  ['MCP reconnect requires a connected Claude conversation.', '请先连接一个 Claude 会话。'],
  ['Wait for the current conversation operation to finish.', '请等待当前会话操作完成。'],
  ['Restore Windows MCP and the SSH tunnel before reconnecting Claude MCP.', 'Windows MCP 服务或隧道尚未恢复，请先检查顶部连接状态。'],
  ['Relay Desk is closing.', 'Relay Desk 正在退出，请稍候。'],
  ['Unable to safely release idle desktop sessions.', '暂时无法安全释放旧会话，未发送消息，请稍后重试。'],
  ['Invalid local project folder.', '本地项目目录无效。'],
  ['Choose an absolute local drive folder.', '请选择本机磁盘上的绝对路径，例如 D:\\example_project。'],
  ['Local project folder does not exist.', '本地项目目录不存在或不是文件夹。'],
  ['Set a local project folder first.', '请先设置本地项目目录。'],
  ['Invalid local project path.', '本地文件路径无效。'],
  ['This path does not exist on this computer.', '该路径在本机不存在，请确认本地目录及文件是否已同步。'],
  ['Unable to open the local project path.', '无法打开该本地路径，请检查默认打开程序。'],
  ['Choose a project first.', '请先选择一个项目。'], ['Connect to the server first.', '请先连接服务器。'],
  ['SSH is disconnected.', 'SSH 连接已断开。'],
  ['Unable to confirm remote message receipt.', '暂时无法确认远端是否收到消息；文字已保留，请核对终端后再决定是否重发。'],
  ['Unable to read outgoing message backups. Sending is paused to protect existing text.', '无法读取本机发送备份，已暂停发送以保护原有文字。'],
  ['A message is already being submitted to this conversation.', '这个对话正在发送消息，请稍候。'],
  ['Attachment references expired. Add them again.', '附件引用已失效，请重新添加；文字备份保留。'],
  ['An attached file changed or is too large. Add it again.', '附件已变化或过大，请重新添加；文字备份保留。'],
  ['Attachments exceed the 32 MiB batch limit.', '附件总大小超过 32 MiB，请减少附件。'],
  ['Open this session first.', '请先打开这个对话。'],
  ['This session is already open in another window.', '这个对话已在另一个窗口中打开。'],
  ['This session is open in another window.', '这个对话已在另一个窗口中打开。'],
  ['Enter a session name.', '请输入对话名称。'], ['Invalid session ID.', '对话编号无效。'],
  ['Invalid project path.', '项目路径无效。'], ['Invalid shell argument.', '命令参数无效。'],
  ['Invalid clipboard text.', '复制内容为空或过长。'],
  ['The clipboard does not contain a readable image.', '剪贴板中没有可读取的图片，请先复制图片或截图。'],
  ['Clipboard image source exceeds 32 MiB. Copy a smaller region.', '剪贴板原始图片超过 32 MiB，请截取较小的区域后再粘贴。'],
  ['The clipboard image API is unavailable in this runtime.', '当前运行环境不支持读取剪贴板图片，请更新 Relay Desk 运行环境。'],
  ['The window was closed before the image could be attached.', '窗口已关闭，图片未添加。'],
  ['The session limit must be between 1 and 8.', '同时活跃会话上限必须为 1 到 8。'],
  ['Enter an SSH address in user@host format.', '请输入 user@host 格式的 SSH 地址。'],
  ['SSH port must be between 1 and 65535.', 'SSH 端口必须为 1 到 65535。'],
  ['Choose a valid SSH private key file.', '请选择有效的 SSH 私钥文件。'],
  ['Wait for the current connection change to finish.', '连接配置正在应用，请稍后重试。'],
  ['Unable to read active conversations.', '暂时无法读取活跃会话，请刷新重试。'],
  ['Unable to read managed desktop sessions or resource settings.', '暂时无法读取远端活跃会话或资源配置，请刷新重试。'],
  ['Project not found.', '项目不存在或已被删除。'],
  ['This project is being removed.', '该项目正在删除，请稍后操作。'],
  ['Wait for the current project or connection change to finish.', '项目或连接配置正在变更，请稍后重试。'],
  ['This conversation is still starting. Refresh the active list shortly.', '该会话还在启动，请稍后刷新列表再结束它。'],
  ['Clipboard image exceeds the local decoding limit. Copy a smaller region.', '剪贴板图片过大，请重新截取较小的区域。'],
  ['Unable to compress this image below 2 MiB. Copy a smaller region.', '图片无法压缩到 2 MiB 以内，请截取较小的区域。'],
  ['The local image cache is full. Remove pending images or try again after old images expire.', '本机图片缓存已满，请移除待发送的图片，或等待旧缓存过期。'],
  ['Remote clipboard cache is full (128 MiB). Old images expire after seven days.', '服务器图片缓存已达 128 MiB 上限，已停止上传。旧图片会在七天后清理。'],
  ['Clipboard image changed or exceeds 2 MiB. Paste it again.', '图片已变化或超过 2 MiB，请重新粘贴。'],
  ['Clipboard image changed. Paste it again.', '图片已变化，请重新粘贴。'],
  ['Clipboard image upload timed out. The draft is retained.', '图片上传超时，输入内容和附件已保留，请重试。'],
  ['Clipboard image upload failed. The draft is retained.', '图片上传失败，输入内容和附件已保留，请重试。'],
  ['Clipboard image upload could not be confirmed.', '未能确认图片上传结果，输入内容和附件已保留。'],
  ['Invalid assistant provider.', '助手类型无效。'],
  ['Invalid desktop control setting.', '桌面控制设置无效。'],
  ['Wait for the current service startup to finish.', '请等待当前服务启动完成。'],
  ['Wait for the desktop control mode change to finish.', '请等待桌面控制模式切换完成。'],
  ['The MCP service belongs to another launcher. Close that launcher and reconnect from Relay Desk to change control mode.', 'MCP 服务由其他启动器管理。请关闭原启动器，再通过 Relay Desk 连接后切换。'],
  ['The tunnel belongs to another launcher. Close that launcher and reconnect from Relay Desk to change control mode.', '反向隧道由其他启动器管理。请关闭原启动器，再通过 Relay Desk 连接后切换。'],
  ['The existing MCP control mode differs from your selection. Close its launcher and reconnect from Relay Desk.', '现有 MCP 的控制模式与所选设置不同。请关闭原启动器后重新连接。'],
  ['MCP did not apply the selected desktop control mode.', 'MCP 未能应用所选控制方式，请查看运行日志。'],
  ['Desktop input no longer waits for user inactivity. Physical and AI input can overlap.', '强制接管已开启：AI 不再等待用户空闲，双方鼠标键盘输入可能互相干扰。'],
  ['Cooperative desktop input protection restored.', '已恢复协作控制和用户输入保护。'],
  ['Invalid model settings.', '模型设置无效，请重新选择。'],
  ['This model is not in the current CLI catalog. Reconnect to refresh the list.', '当前 CLI 列表中没有这个模型，请重新连接以刷新列表。'],
  ['This model does not support the selected reasoning effort.', '这个模型不支持所选的推理强度，请重新选择。'],
  ['Session settings are changing. Wait for reconnection.', '正在应用模型设置，请等待重新连接。'],
  ['Please shorten this message to 60,000 characters.', '消息长度不能超过 60,000 个字符，请缩短后重试。'],
  ['Enter a name and an absolute or ~/ remote project path.', '请输入项目名称，以及以 / 或 ~/ 开头的服务器路径。'],
  ['Project names cannot contain parentheses.', '项目名称不能包含英文括号 () 或中文括号（）。'],
  ['Start the connection first, then reopen this conversation.', '请先连接服务器，再重新连接此对话。'],
  ['The local MCP service is still starting.', 'Windows MCP 服务仍在启动，请稍候。'],
  ['MCP startup timed out. See the service log.', 'MCP 启动超时，请检查服务日志。'],
  ['Windows MCP needs an unlocked interactive desktop. Unlock Windows and launch Relay Desk from your desktop.', 'Windows MCP 需要访问已解锁的桌面。请解锁 Windows，然后从桌面启动 Relay Desk。'],
  ['Remote launchers and MCP settings synchronized. Secret contents are hidden.', '服务器启动配置已同步，密钥内容已隐藏。'],
  ['Using the existing local MCP service. Its original launcher remains in control.', '已复用现有的 Windows MCP 服务；原启动器仍负责管理它。'],
  ['Using the existing reverse tunnel. Keep its original launcher open.', '已复用现有的 SSH 反向隧道，请保持原启动窗口打开。'],
  ['SSH disconnected. Remote sessions can be reattached after reconnecting.', 'SSH 已断开。重新连接后可以恢复远程对话。'],
  ['Disconnected. Services owned by an older launcher were left running. Remote sessions remain resumable.', '已断开连接。旧启动器管理的服务继续运行，远程对话可以恢复。'],
  ['No usable SSH host key found in known_hosts.', '在 SSH 主机记录中没有找到可用的主机密钥。'],
  ['Unsupported public key format.', '不支持此公钥格式。'],
  ['SSH host is not trusted yet. Run setup-ssh.cmd first.', 'SSH 服务器尚未加入可信主机列表。请先运行 setup-ssh.cmd。'],
  ['SSH_TARGET must have the form user@host.', 'SSH_TARGET 格式应为 user@host。'],
  ['SSH_PORT must be between 1 and 65535.', 'SSH_PORT 需设置为 1 到 65535 之间的端口。'],
  ['Invalid SSH_PORT.', 'SSH_PORT 设置无效。'],
  ['Invalid .env syntax. Use KEY=value.', '.env 格式错误，请使用 KEY=value。'],
  ['A project path must start with / or ~/.', '项目路径必须以 / 或 ~/ 开头。'],
  ['The remote home directory could not be determined.', '无法确认服务器的用户主目录。'],
  ['Choose an absolute folder path or a path beginning with ~/.', '请选择绝对路径，或以 ~/ 开头的文件夹路径。'],
  ['Failed to open the remote project folder.', '无法打开服务器上的项目文件夹。'],
  ['Could not create the remote project folder.', '无法创建服务器上的项目文件夹。'],
  ['Remote project path is not accessible.', '无法访问服务器项目目录。'],
  ['The local MCP service is unavailable.', 'Windows MCP 服务当前不可用。'],
  ['The SSH private key could not be loaded.', '无法读取 SSH 私钥。'],
  ['The SSH connection timed out.', 'SSH 连接超时。'],
  ['SSH authentication failed.', 'SSH 身份验证失败，请检查密钥和 SSH 配置。'],
  ['SSH connection failed.', 'SSH 连接失败。'],
  ['Port forwarding failed.', 'SSH 端口转发失败。'],
  ['The SSH server rejected reverse port forwarding.', '服务器拒绝建立 SSH 反向端口转发。'],
  ['The MCP server did not respond in time.', 'MCP 服务未在规定时间内响应。'],
  ['The remote MCP service is not reachable.', '无法连接服务器上的 MCP 服务。'],
  ['The remote container did not start.', '服务器上的助手容器未能启动。'],
  ['The remote session ended.', '远程对话已结束。'],
  ['MCP authentication failed.', 'MCP 密钥验证失败，请核对两端 .env 文件。'],
  ['The SSH key passphrase is incorrect.', 'SSH 密钥口令不正确。'],
]);
function translate(value) {
  let text = String(value);
  for (const [english, chinese] of translations) text = text.replaceAll(english, chinese);
  text = text.replace(/Remote MCP health check failed \((.*?)\)\. Check the tunnel and both \.env secrets\./, '远程 MCP 检查失败（$1）。请检查反向隧道以及两端 .env 中的密钥。');
  text = text.replace(/MCP health check returned HTTP (\d+)\./, 'MCP 检查返回 HTTP $1。请检查端口和密钥。');
  text = text.replace(/Reverse tunnel ready on server loopback port (\d+)\./, '服务器本机反向隧道已就绪，端口 $1。');
  text = text.replace(/SSH: (.*)/, 'SSH 连接：$1');
  return text;
}

function errorMessage(error) {
  return translate(String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''));
}
function notice(message) { $('notice').textContent = translate(message); $('notice').hidden = !message; }
function action(callback) { return async (...args) => { try { await callback(...args); } catch (error) { notice(errorMessage(error)); } }; }
function scheduleReadCheck() {
  clearTimeout(readCheckTimer);
  readCheckTimer = setTimeout(markVisibleSessionRead, 180);
}
function markVisibleSessionRead() {
  const id = selectedSession;
  const revision = unreadRevisions.get(id);
  if (!id || !unreadSessions.has(id) || !revision || !document.hasFocus() || document.visibilityState !== 'visible' || composerExpanded || document.querySelector('dialog[open]')) return;
  let completion = null;
  if (historyVisible) {
    const history = $('history-messages');
    if ($('history-panel').hidden || !history.clientHeight || renderedHistory.id !== id || !renderedHistory.messages.length || historyLoadingId === id) return;
    if (history.scrollHeight - history.scrollTop - history.clientHeight > 4) return;
    completion = renderedHistory.completion || '';
  } else {
    const entry = terminals.get(id);
    if (!entry || $('terminal-host').hidden || !entry.element.clientHeight || entry.pendingWrites || !entry.launchOutput || entry.opening) return;
    const buffer = entry.terminal.buffer.active;
    if (buffer.viewportY < buffer.baseY) return;
  }
  const key = `${id}:${revision}`;
  if (readRequests.has(key)) return;
  readRequests.add(key);
  window.relay.readSession(id, revision, completion).catch((error) => notice(errorMessage(error))).finally(() => readRequests.delete(key));
}
function saveDraft(id, text) {
  if (!id) return;
  if (drafts.get(id) !== text) saveDraftAttempt(id, null);
  drafts.set(id, text);
  try { localStorage.setItem(`relayDesk.draft.${id}`, text); }
  catch { notice('草稿自动保存暂不可用。点击发送后仍会先保存本机发送备份。'); }
}
function saveDraftAttempt(id, attemptId) {
  if (attemptId) draftAttempts.set(id, attemptId); else draftAttempts.delete(id);
  try {
    if (attemptId) localStorage.setItem(`relayDesk.draftAttempt.${id}`, attemptId);
    else localStorage.removeItem(`relayDesk.draftAttempt.${id}`);
  } catch {}
}
function restoreMessage(record) {
  if (selectedSession !== record.sessionId) throw new Error('请先选择该消息所属的对话。');
  const current = $('prompt').value;
  const text = !current || current === record.text ? record.text : current + '\n\n' + record.text;
  saveDraft(record.sessionId, text); $('prompt').value = text;
  if (text === record.text && record.id && !['submitted', 'accepted'].includes(record.status)) saveDraftAttempt(record.sessionId, record.id);
  else if (['submitted', 'accepted'].includes(record.status)) saveDraftAttempt(record.sessionId, null);
  $('send-history-dialog').close(); $('prompt').focus();
  notice(record.attachments?.length ? '文字已恢复，附件请核对或重新添加。不会自动发送。' : '文字已恢复到输入框，不会自动发送。');
}
function renderSendRecovery() {
  const record = outgoingBySession.get(selectedSession)?.at(-1);
  const pending = sending && record && !['submitted', 'accepted'].includes(record.status);
  $('send-recovery').hidden = !pending;
  $('send-recovery-state').textContent = pending ? `${deliveryLabels[record.status] || '文字已备份'}。可在“发送记录”中复制或恢复。` : '';
  $('send-history').disabled = !selectedSession || sending;
}
async function refreshOutgoing(id, refresh = false) {
  const records = await window.relay.messageRecords(id, refresh);
  outgoingBySession.set(id, records);
  const latest = records.at(-1);
  if (!drafts.has(id) && latest && latest.status === 'saved' && latest.text) {
    saveDraft(id, latest.text);
    saveDraftAttempt(id, latest.id);
    if (selectedSession === id) $('prompt').value = latest.text;
  }
  if (selectedSession === id) renderSendRecovery();
  return records;
}
function usageProvider() {
  return workspace.sessions.find((session) => session.id === selectedSession)?.provider || $('new-provider').value;
}
function renderUsageVisibility() {
  $('usage-panel').classList.toggle('collapsed', usageCollapsed);
  $('usage-details').hidden = usageCollapsed;
  $('usage-toggle').setAttribute('aria-expanded', String(!usageCollapsed));
  $('usage-toggle').title = usageCollapsed ? '展开额度与资源' : '收起额度与资源';
  $('usage-chevron').textContent = usageCollapsed ? '▸' : '▾';
}
function formatUsageTime(milliseconds) {
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? usageTimeFormat.format(date) : '';
}
function renderUsage() {
  renderUsageVisibility();
  const provider = usageProvider();
  const name = provider === 'codex' ? 'Codex' : 'Claude';
  const entry = status.usage?.[provider] || { state: 'pending', windows: [], reason: 'not_loaded' };
  const online = status.ssh === 'ready' && status.tunnel === 'ready';
  if (!online) usageRequestedFor = '';
  else if (usageRequestedFor !== provider) {
    usageRequestedFor = provider;
    window.relay.refreshUsage(provider).then(renderStatus).catch((error) => notice(errorMessage(error)));
  }
  const key = JSON.stringify([provider, online, entry, status.monitor?.resources, status.monitor?.error, Math.floor(Date.now() / 30000)]);
  if (key === lastUsageRender) return;
  lastUsageRender = key;
  $('usage-provider').textContent = `${name} · 额度与资源`;
  $('usage-refresh').disabled = !online || Boolean(entry.loading);
  $('usage-refresh').textContent = entry.loading ? '…' : '↻';
  const container = $('usage-windows'); container.replaceChildren();
  for (const item of entry.windows || []) {
    const remaining = Math.max(0, Math.min(100, 100 - item.usedPercent));
    const expired = Number.isFinite(item.resetsAt) && item.resetsAt * 1000 <= Date.now();
    const row = document.createElement('div'); row.className = 'usage-window' + (expired ? ' expired' : remaining <= 10 ? ' low' : remaining <= 25 ? ' warning' : '');
    const heading = document.createElement('div'); heading.className = 'usage-window-heading';
    const label = document.createElement('span');
    const minutes = item.windowMinutes;
    const period = !Number.isFinite(minutes) ? '额度窗口' : minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
    label.textContent = item.label ? item.label + (provider === 'codex' ? ` · ${period}` : '') : period;
    label.title = label.textContent;
    const remainingText = remaining > 0 && remaining < 0.1 ? '<0.1' : remaining.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
    const value = document.createElement('strong'); value.textContent = expired ? '待更新' : `剩余 ${remainingText}%`;
    value.title = expired ? '等待 CLI 提供重置后的新用量' : `已使用 ${item.usedPercent}%；剩余 ${remainingText}%。计算方式：100% − 已使用。`;
    heading.append(label, value);
    const bar = document.createElement('progress'); bar.max = 100; bar.value = item.usedPercent; bar.setAttribute('aria-label', expired ? `${label.textContent} 待更新` : `${label.textContent} 已使用 ${item.usedPercent}%，${value.textContent}`);
    bar.title = `${value.title} 浅色表示已用，深色表示剩余。`;
    const resetTime = item.resetsAt ? formatUsageTime(item.resetsAt * 1000) : '';
    const reset = document.createElement('small'); reset.textContent = expired ? '已到重置时间，等待 CLI 更新' : resetTime ? `${resetTime} 重置` : '重置时间暂不可用';
    reset.title = '北京时间；重置到期后不会自行假定额度已恢复';
    row.append(heading, bar, reset); container.append(row);
  }
  if (!container.childElementCount) {
    const empty = document.createElement('p'); empty.className = 'usage-empty';
    const reasons = { waiting_for_claude: '等待 Claude 下一次回复报告额度', custom_statusline: '已有自定义状态栏，暂未接入额度', server_busy: '服务器繁忙，稍后再读取', catalog_busy: '等待模型列表同步完成', not_loaded: '等待首次同步', query_timeout: '读取超时，请稍后刷新', query_failed: '暂时无法读取，请稍后刷新' };
    empty.textContent = !online ? '连接后读取剩余额度' : entry.loading ? '正在读取远端账号额度…' : entry.state === 'not_signed_in' ? `${name} 尚未登录` : entry.state === 'unsupported' ? '当前账号未提供额度信息' : reasons[entry.reason] || '额度暂不可用';
    container.append(empty);
  }
  const reported = Number.isFinite(entry.updatedAt) ? formatUsageTime(entry.updatedAt) : '';
  $('usage-state').textContent = `${!online ? entry.windows?.length ? '离线缓存 · 账号共享' : '账号共享 · 等待连接' : entry.state === 'error' && entry.windows?.length ? '刷新失败 · 上次数据' : '账号共享'}${reported ? ` · ${reported}` : ''}`;
  $('usage-state').title = `${provider === 'claude' ? '来自远端 Claude CLI 额度查询，失败时回退到已有报告；最多每五分钟查询一次，不会发送推理请求或触发额度重置。' : '来自远端 Codex 官方账号额度接口。'} 所有项目和对话共用账号额度。时间均为北京时间。`;
  renderServerResources();
}
function renderServerResources() {
  const container = $('server-resources'); container.replaceChildren();
  const metrics = status.monitor?.resources;
  const online = status.ssh === 'ready' && !status.monitor?.error && status.monitor?.receivedAt && Date.now() - status.monitor.receivedAt < 20000;
  if (!metrics) { const text = document.createElement('small'); text.textContent = '连接后读取服务器 CPU / 内存'; container.append(text); return; }
  const heading = document.createElement('div'); heading.className = 'server-resource-heading';
  heading.textContent = online ? '服务器资源' : '服务器资源 · 上次数据'; heading.title = 'CPU / 内存约每 4 秒刷新一次。'; container.append(heading);
  const addMetric = (name, value, percent, detail, title) => {
    const row = document.createElement('div'); row.className = 'server-resource-row'; row.title = title;
    const line = document.createElement('div'); line.className = 'usage-window-heading';
    const label = document.createElement('span'); label.textContent = name;
    const number = document.createElement('strong'); number.textContent = value; line.append(label, number);
    const bar = document.createElement('progress'); bar.max = 100; bar.value = Math.max(0, Math.min(100, percent)); bar.setAttribute('aria-label', `${name} 已使用 ${value}`);
    const caption = document.createElement('small'); caption.textContent = detail;
    row.append(line, bar, caption); container.append(row);
  };
  const gib = (bytes) => (bytes / 1073741824).toFixed(2);
  addMetric('CPU', `${metrics.cpuPercent}%`, metrics.cpuPercent, `${metrics.cpuCores} 核 · 1 分钟负载 ${metrics.load1.toFixed(2)}`, '系统全部 CPU 的采样平均占用率；不代表单个任务是否正在运行。');
  addMetric('内存已用', `${metrics.memoryUsedPercent}%`, metrics.memoryUsedPercent, `可用 ${gib(metrics.memoryAvailable)} / 总计 ${gib(metrics.memoryTotal)} GiB`, `可用内存按 MemAvailable 计算，包含可回收缓存。缓存约 ${gib(metrics.memoryCache)} GiB；进度条浅色表示已用。Docker 的内存上限不等于实际占用。`);
  const extra = document.createElement('small'); extra.className = 'server-resource-extra';
  extra.textContent = `Swap 已用 ${(metrics.swapUsed / 1048576).toFixed(1)} MiB · 服务器会话进程 ${metrics.activeSessions}/${metrics.maxSessions}`;
  extra.title = '这是服务器会话进程数量。退出 App 和下次首次连接时，会清理已完成且无人连接的旧进程，保留运行中或状态不明的任务及历史记录。刚完成的任务有约一分钟保护期。'; container.append(extra);
}

function renderSessionIndicators() {
  const monitor = status.monitor;
  const fresh = status.ssh === 'ready' && !monitor?.error && monitor?.receivedAt && Date.now() - monitor.receivedAt < 20000;
  const connectedIds = new Set(status.ssh !== 'ready' ? [] : Array.isArray(status.sessionConnections)
    ? status.sessionConnections.map((entry) => entry.id) : [...terminals].filter(([, entry]) => entry.connected).map(([id]) => id));
  for (const button of $('projects').querySelectorAll('[data-project-id]')) {
    const project = workspace.projects.find((entry) => entry.id === button.dataset.projectId);
    if (!project) continue;
    const count = workspace.sessions.filter((entry) => entry.projectId === project.id && connectedIds.has(entry.id)).length;
    const label = `${project.name} (${count})`;
    const name = button.querySelector('.project-name');
    if (name.textContent !== label) name.textContent = label;
    button.title = `${project.name} · 已连接 ${count} 个会话（统计本应用的所有窗口）`;
  }
  const titles = { running: '任务运行中', waiting: '等待你确认或回答', completed: '本轮任务已完成', failed: '本轮任务失败', interrupted: '任务已中断', stopped: '会话已停止', unknown: '暂时无法确认任务状态' };
  for (const button of $('sessions').querySelectorAll('[data-session-id]')) {
    const task = monitor?.sessions?.[button.dataset.sessionId];
    const phase = fresh && task?.state && Object.hasOwn(titles, task.state) ? task.state : 'unknown';
    const connected = connectedIds.has(button.dataset.sessionId);
    const connection = button.querySelector('.session-connection-state');
    const connectionTitle = `${connected ? '已连接' : '未连接'} · ${titles[phase]}（连接状态统计本应用的所有窗口）`;
    connection.className = `session-connection-state ${connected ? 'connected' : 'disconnected'}`;
    connection.title = connectionTitle; connection.setAttribute('aria-label', connectionTitle);
    button.classList.toggle('session-connected', connected);
    const indicator = button.querySelector('.session-task-state');
    indicator.className = `session-task-state ${phase}`;
    indicator.textContent = phase === 'waiting' || phase === 'failed' ? '!' : '';
    indicator.hidden = !['running', 'waiting', 'failed'].includes(phase);
    indicator.title = `${titles[phase]}${!fresh ? '（未取得最新远端状态）' : task?.source === 'submitted' ? '（已发送，等待远端确认）' : ''}`;
    indicator.setAttribute('aria-label', indicator.title);
    if (task && fresh) {
      const entry = terminals.get(button.dataset.sessionId);
      if (entry && ['running', 'waiting', 'completed', 'failed', 'interrupted', 'stopped'].includes(phase)) entry.taskRunning = ['running', 'waiting'].includes(phase);
    }
  }
}
function renderKeepAwake(value = {}) {
  $('keep-awake').checked = Boolean(value.enabled);
  $('keep-awake').disabled = !value.available;
  $('keep-awake-state').textContent = !value.available ? '当前环境不可用' : value.error ? '暂不可用，请查看运行日志' : !value.enabled ? '已关闭' : value.locked ? '已锁屏 · 暂停' : value.suspended ? '已休眠 · 暂停' : value.active ? '前台和后台均生效' : value.starting ? '正在准备…' : '已开启';
}
function renderForceControl(value) {
  const control = value.control || { requested: false, applied: null };
  const external = (value.mcp === 'ready' && !value.mcpOwned) || (value.tunnel === 'ready' && !value.tunnelOwned);
  $('force-control').checked = Boolean(control.changing ? control.requested : control.applied ?? control.requested);
  $('force-control').disabled = Boolean(control.changing || value.mcp === 'starting' || value.ssh === 'connecting' || external);
  const label = $('force-control').closest('label');
  label.classList.toggle('force-control-active', control.applied === true);
  label.title = external ? '当前复用了其他启动器的服务或隧道。请关闭原启动器，再由 Relay Desk 连接，才能切换控制方式。' : control.error ? `切换失败：${errorMessage(control.error)}` : control.changing ? '正在重启本机 MCP 以切换控制方式；远端对话保留。' : control.applied === true ? '已开启：AI 不等待你停止操作，双方输入可能互相干扰。原 MCP 接管快捷键不再生效；可关闭本选项恢复协作模式。' : value.mcp === 'ready' ? '已关闭：保留用户优先和空闲等待保护。开启会短暂重启本机 MCP，不结束远端对话。' : '选择将在 MCP 启动时应用。开启后 AI 与你的鼠标键盘操作可能互相干扰。';
  $('force-control').setAttribute('aria-label', control.changing ? '正在切换桌面控制方式' : '允许强制接管');
}
function renderWorkspace() {
  if (!workspace.projects.some((project) => project.id === selectedProject)) selectedProject = workspace.projects[0]?.id;
  const project = workspace.projects.find((entry) => entry.id === selectedProject);
  projectTools.setProject(project);
  $('project-label').textContent = project?.name || '请选择项目';
  $('project-path').textContent = project?.path || '';
  const projectScroll = $('projects').scrollTop;
  const reorderFocus = document.activeElement?.dataset.reorderProject;
  $('projects').replaceChildren();
  for (const entry of workspace.projects) {
    const row = document.createElement('div'); row.className = 'project-row';
    const button = document.createElement('button');
    button.className = 'project-item' + (entry.id === selectedProject ? ' active' : '');
    button.dataset.projectId = entry.id;
    const name = document.createElement('span'); name.className = 'project-name'; name.textContent = `${entry.name} (0)`; button.append(name);
    const small = document.createElement('small'); small.textContent = entry.path; button.append(small);
    button.onclick = () => { selectedProject = entry.id; showSession(null); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'project-delete'; remove.textContent = '×'; remove.title = '删除项目'; remove.setAttribute('aria-label', `删除项目 ${entry.name}`);
    remove.onclick = action(() => openProjectDelete(entry.id));
    const settings = document.createElement('button'); settings.type = 'button'; settings.className = 'project-settings'; settings.textContent = '⚙'; settings.title = '配置项目目录'; settings.setAttribute('aria-label', `配置项目 ${entry.name} 的目录`);
    settings.onclick = () => openProjectFolder(entry.id);
    const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'project-grip'; grip.textContent = '⋮'; grip.draggable = true;
    grip.dataset.reorderProject = entry.id;
    grip.title = '拖动调整项目顺序，也可按 Alt+↑ / Alt+↓'; grip.setAttribute('aria-label', `调整项目 ${entry.name} 的顺序`);
    grip.onkeydown = action(async (event) => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const before = event.key === 'ArrowUp';
      const target = workspace.projects[workspace.projects.indexOf(entry) + (before ? -1 : 1)];
      if (target) await window.relay.moveProject(entry.id, target.id, before);
    });
    grip.ondragstart = (event) => {
      draggedProject = entry.id; event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-relay-project', entry.id);
    };
    const clearDrop = () => row.classList.remove('move-before', 'move-after');
    const beforeRow = (event) => event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
    row.ondragover = (event) => {
      if (!draggedProject || draggedProject === entry.id) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      row.classList.toggle('move-before', beforeRow(event)); row.classList.toggle('move-after', !beforeRow(event));
    };
    row.ondragleave = (event) => { if (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget)) clearDrop(); };
    grip.ondragend = () => { draggedProject = null; for (const item of $('projects').children) item.classList.remove('move-before', 'move-after'); };
    row.ondrop = action(async (event) => {
      const source = draggedProject;
      if (!source || source === entry.id) return;
      event.preventDefault(); draggedProject = null; clearDrop();
      await window.relay.moveProject(source, entry.id, beforeRow(event));
    });
    row.append(button, grip, settings, remove); $('projects').append(row);
    if (reorderFocus === entry.id) grip.focus({ preventScroll: true });
  }
  $('projects').scrollTop = projectScroll;
  $('sessions').replaceChildren();
  const sessions = workspace.sessions.filter((session) => session.projectId === selectedProject);
  for (const entry of sessions) {
    const button = document.createElement('button');
    button.className = 'session-item' + (entry.id === selectedSession ? ' active' : '');
    button.dataset.sessionId = entry.id;
    const badge = document.createElement('span');
    badge.className = 'provider-badge' + (entry.provider === 'codex' ? ' codex' : '');
    badge.textContent = entry.provider === 'codex' ? 'Codex' : 'Claude';
    const sessionName = document.createElement('span'); sessionName.className = 'session-name'; sessionName.textContent = entry.name;
    const taskState = document.createElement('span'); taskState.className = 'session-task-state unknown'; taskState.textContent = '?';
    const connectionState = document.createElement('span'); connectionState.className = 'session-connection-state disconnected';
    button.append(badge, sessionName, taskState, connectionState);
    if (unreadSessions.has(entry.id)) { const unread = document.createElement('span'); unread.className = 'session-unread'; unread.textContent = String(unreadSessions.get(entry.id)); unread.title = '任务已完成'; button.append(unread); }
    button.title = new Date(entry.createdAt).toLocaleString();
    button.onclick = action(() => activateSession(entry.id));
    $('sessions').append(button);
  }
  if (!sessions.length) {
    const empty = document.createElement('p'); empty.className = 'list-empty'; empty.textContent = '对话会显示在这里。'; $('sessions').append(empty);
  }
  const active = workspace.sessions.find((session) => session.id === selectedSession);
  if (active) $('session-title').textContent = `${active.provider === 'codex' ? 'Codex' : 'Claude'} · ${active.name}`;
  renderModels();
  renderSessionIndicators();
  $('new-session').disabled = Boolean(status.settingsChanging) || !workspace.projects.some((entry) => entry.id === selectedProject);
}
function modelScope() {
  const session = workspace.sessions.find((entry) => entry.id === selectedSession);
  const provider = session?.provider || $('new-provider').value;
  const saved = session || workspace.assistantDefaults?.[provider] || {};
  return { session, provider, key: session ? `session:${session.id}` : `new:${provider}`, saved: { model: saved.model || '', effort: saved.effort || '' } };
}
function renderServicesVisibility() {
  $('services-panel').hidden = servicesCollapsed;
  $('services-toggle').setAttribute('aria-expanded', String(!servicesCollapsed));
  $('services-toggle-label').textContent = servicesCollapsed ? '展开状态' : '收起状态';
  const states = ['mcp', 'ssh', 'tunnel'].map((key) => status[key]);
  const state = states.includes('error') ? 'error' : states.some((value) => value === 'starting' || value === 'connecting') ? 'connecting' : states.every((value) => value === 'ready') ? 'ready' : 'off';
  $('services-summary-dot').className = 'status-dot ' + state;
  $('services-toggle').title = ['mcp', 'ssh', 'tunnel'].map((key) => ({ mcp: 'Windows MCP', ssh: 'SSH', tunnel: '反向隧道' })[key] + '：' + $(key + '-status').textContent).join('\n');
  requestAnimationFrame(fitCurrent);
}
function renderModels() {
  const scope = modelScope();
  const slot = $(scope.session ? 'composer-model-slot' : 'empty-model-slot');
  if ($('model-settings').parentElement !== slot) slot.append($('model-settings'));
  const catalog = status.catalog?.[scope.provider] || { models: [] };
  const draft = modelDrafts.get(scope.key) || scope.saved;
  const models = catalog.models || [];
  const model = models.find((entry) => entry.id === draft.model);
  const picker = $('model-select');
  const effortPicker = $('effort-select');
  picker.replaceChildren(new Option('沿用 CLI 设置', ''));
  for (const entry of models) {
    const label = entry.id === 'default' ? `推荐默认（${entry.resolvedModel}）` : entry.label;
    const option = new Option(label, entry.id);
    option.title = entry.description;
    picker.append(option);
  }
  if (draft.model && !model) picker.append(new Option(`${draft.model}（已保存，当前列表未包含）`, draft.model));
  picker.value = draft.model;
  picker.title = model?.description || '每个对话单独保存模型设置';
  effortPicker.replaceChildren(new Option('推理：沿用设置', ''));
  for (const effort of model?.efforts || []) {
    effortPicker.append(new Option(`${effortLabels[effort] || effort}${effort === model.defaultEffort ? '（默认）' : ''}`, effort));
  }
  if (draft.effort && !model?.efforts.includes(draft.effort)) effortPicker.append(new Option(`${draft.effort}（当前不支持）`, draft.effort));
  effortPicker.value = draft.effort;
  picker.disabled = Boolean(applyingModel) || sending || status.settingsChanging || !models.length;
  effortPicker.disabled = Boolean(applyingModel) || sending || status.settingsChanging || !model?.efforts.length;
  effortPicker.title = !draft.model ? '选择具体模型后可调整推理强度' : !model?.efforts.length ? '这个模型未提供推理强度选项' : '只显示所选模型支持的推理强度';
  const changed = draft.model !== scope.saved.model || draft.effort !== scope.saved.effort;
  $('model-scope').textContent = `${scope.provider === 'codex' ? 'Codex' : 'Claude'} · ${scope.session ? '本对话模型' : '新对话模型'}`;
  $('apply-model').hidden = Boolean(scope.session) || !changed;
  $('apply-model').disabled = !changed || sending || status.tunnel !== 'ready' || Boolean(draft.model && !model) || Boolean(draft.effort && !model?.efforts.includes(draft.effort));
  $('model-pending').hidden = !scope.session || !changed || Boolean(applyingModel);
  let text = status.catalog?.loading ? '正在刷新模型列表…' : models.length ? `共 ${models.length} 个模型${catalog.cached ? ' · 缓存' : ''}` : '连接后获取模型列表';
  if (catalog.error) text = models.length ? '刷新失败，已保留缓存列表' : '模型列表获取失败，请查看运行日志';
  $('model-list-state').textContent = text;
  $('model-list-state').title = catalog.updatedAt ? `最近更新：${new Date(catalog.updatedAt).toLocaleString()}` : '';
  picker.title = [model?.label || '沿用 CLI 设置', model?.description, text, $('model-list-state').title].filter(Boolean).join('\n');
}
async function applyModelChange(change, terminal, { open = true } = {}) {
  if (applyingModel) throw new Error('Session settings are changing. Wait for reconnection.');
  applyingModel = change.sessionId;
  renderModels(); updateSessionState();
  try {
    const session = await window.relay.setSessionSettings(change.sessionId, change.settings);
    const saved = workspace.sessions.find((entry) => entry.id === session.id);
    if (saved) Object.assign(saved, session);
    modelDrafts.delete(`session:${session.id}`);
    terminal.connected = false;
    terminal.opening = false;
    if (open) await openTerminalSession(session.id, terminal);
  } finally { applyingModel = ''; renderModels(); updateSessionState(); }
}
function renderStatus(value) {
  const wasReady = status.ssh === 'ready' && status.tunnel === 'ready';
  const wasChangingSettings = Boolean(status.settingsChanging);
  status = value;
  projectTools.setStatus(value);
  const labels = { unknown: '未检查', error: '不可用', off: '已停止', starting: '启动中', connecting: '连接中', ready: '就绪' };
  for (const key of ['mcp', 'ssh', 'tunnel']) {
    $(key + '-dot').className = 'status-dot ' + (status[key] || 'off');
    let label = labels[status[key]] || '已停止';
    if (status[key] === 'ready' && key !== 'ssh') label = status[key + 'Owned'] ? '就绪 · 由本界面管理' : '就绪 · 复用现有服务';
    if (key === 'ssh' && status[key] === 'off') label = '未连接';
    if (key === 'ssh' && status[key] === 'ready') label = '已连接';
    $(key + '-status').textContent = label;
  }
  const cfg = value.connection || {};
  $('local-port').textContent = cfg.localPort ? `127.0.0.1:${cfg.localPort}` : '未配置';
  $('remote-port').textContent = cfg.remotePort ? `127.0.0.1:${cfg.remotePort}` : '仅本机可访问';
  $('ssh-target').textContent = cfg.host ? `${cfg.host}:${cfg.sshPort}` : '未配置';
  const ready = value.ssh === 'ready' && value.tunnel === 'ready';
  if (wasReady && !ready && capacitySendWaiter) closeCapacityRequest(false);
  $('connect').disabled = connecting || ready || Boolean(value.settingsChanging);
  $('connect').textContent = connecting ? '正在连接…' : ready ? '已连接' : '连接并启动';
  $('disconnect').disabled = Boolean(value.settingsChanging) || (!ready && value.mcp !== 'starting' && value.mcp !== 'ready' && value.ssh !== 'connecting');
  $('empty-connect').disabled = connecting;
  $('new-session').disabled = Boolean(value.settingsChanging) || !workspace.projects.some((entry) => entry.id === selectedProject);
  $('footer-state').textContent = ready ? `已连接（${cfg.username}）· 远程助手就绪` : connecting ? '正在启动工作区…' : '准备就绪';
  if (cfg.error) notice(cfg.error);
  if (!ready) for (const terminal of terminals.values()) terminal.connected = false;
  renderServicesVisibility();
  renderForceControl(value);
  renderModels();
  updateSessionState();
  renderSessionIndicators();
  if (ready && !value.settingsChanging && (!wasReady || wasChangingSettings) && selectedSession) {
    const id = selectedSession;
    action(async () => {
      const entry = terminals.get(id);
      await loadHistory(id, { restore: !entry?.connected });
    })();
  }
}
function updateSessionState() {
  const terminal = terminals.get(selectedSession);
  const session = workspace.sessions.find((entry) => entry.id === selectedSession);
  const provider = session?.provider === 'codex' ? 'Codex' : 'Claude';
  $('session-state').textContent = terminal?.opening ? '正在恢复远程终端…' : terminal?.capacityBlocked ? '等待释放会话名额' : terminal?.connected ? `已连接到远程 ${provider}` : '未连接';
  const sessionConnection = $('end-session');
  sessionConnection.textContent = terminal?.ending ? '正在结束…' : terminal?.opening ? '正在连接…' : terminal?.connected ? '结束连接' : '建立连接';
  sessionConnection.className = `session-connection ${terminal?.connected ? 'disconnect-session' : 'connect-session'}`;
  sessionConnection.disabled = !session || Boolean(terminal?.opening || terminal?.ending || sending || connecting || status.settingsChanging || status.control?.changing || applyingModel);
  sessionConnection.title = terminal?.connected ? '结束此远端会话并停止任务，保留历史记录' : '手动建立当前会话的连接；选择项目或对话不会自动连接';
  $('terminal-controls-label').textContent = `${provider} 确认操作`;
  $('prompt').placeholder = `输入要 ${provider} 完成的任务，可拖入本机文件或 Ctrl+V 粘贴图片...`;
  $('prompt').setAttribute('aria-label', `发送给远程 ${provider} 的消息`);
  const canCompose = Boolean(session && terminal?.connected && status.tunnel === 'ready' && status.mcp === 'ready' && !status.settingsChanging && !status.control?.changing && !terminal.opening && !terminal.ending && !terminal.mcpRepairing);
  const canSend = Boolean(session && terminal && !connecting && !status.settingsChanging && !status.control?.changing && !terminal.opening && !terminal.ending);
  $('send').disabled = !canSend || sending || stagingImage || applyingModel === selectedSession || Boolean(terminal?.mcpRepairing);
  $('mcp-reconnect').hidden = session?.provider !== 'claude';
  $('mcp-reconnect').disabled = !canCompose || sending || Boolean(terminal?.mcpRepairing);
  $('mcp-reconnect').textContent = terminal?.mcpRepairing ? '正在重连 MCP…' : terminal?.mcpReconnectRequested ? '等待重连 MCP…' : '重连 MCP';
  for (const button of document.querySelectorAll('[data-key]')) button.disabled = !canCompose;
  $('stop-task').disabled = !canCompose;
  $('send').textContent = capacitySendWaiter ? '等待空位…' : applyingModel ? '正在切换…' : stagingImage ? '处理图片…' : sending ? '发送中…' : '发送消息';
  $('prompt').disabled = !session || sending || applyingModel === selectedSession;
  $('pick-files').disabled = !selectedSession || sending || stagingImage;
  $('paste-image').disabled = !selectedSession || sending || stagingImage;
  for (const button of $('staged-files').querySelectorAll('button')) button.disabled = sending || stagingImage;
  renderSendRecovery();
  renderUsage();
}
async function connect(passphrase = '') {
  if (connecting) return;
  notice(''); connecting = true; renderStatus(status);
  try { renderStatus(await window.relay.connect(passphrase)); }
  catch (error) {
    notice(errorMessage(error));
    if (/passphrase|encrypted|decrypt|private key/i.test(errorMessage(error))) $('connection-dialog').showModal();
  } finally { connecting = false; renderStatus(status); }
}
function addActivity(text) { activities.push(translate(text)); if (activities.length > 120) activities.shift(); $('activity-content').textContent = activities.join('\n'); $('activity-content').scrollTop = $('activity-content').scrollHeight; }
function showSession(id) {
  if (selectedSession && selectedSession !== id) saveDraft(selectedSession, $('prompt').value);
  if (selectedSession !== id) closeHistorySearch();
  if (selectedSession !== id && composerExpanded) setComposerExpanded(false, false);
  pendingSelection = '';
  selectedSession = id;
  try { if (id) localStorage.setItem('relayDesk.selectedSession', id); } catch {}
  historyViewRevision++;
  $('prompt').value = drafts.get(id) || '';
  renderSendRecovery();
  renderStagedFiles();
  const visible = Boolean(id);
  $('empty-state').hidden = visible;
  for (const name of ['session-header', 'composer-area']) $(name).hidden = !visible;
  $('terminal-host').hidden = !visible || historyVisible;
  $('terminal-controls').hidden = !visible || historyVisible;
  $('history-panel').hidden = !visible || !historyVisible;
  $('history-toggle').textContent = historyVisible ? '返回终端' : '查看历史';
  for (const [key, entry] of terminals) entry.element.hidden = key !== id;
  renderWorkspace();
  if (visible) requestAnimationFrame(() => { fitCurrent(); updateSessionState(); scheduleReadCheck(); });
}
function setHistoryVisible(visible, automatic = false) {
  if (!visible) closeHistorySearch();
  if (!automatic) historyViewRevision++;
  historyVisible = visible;
  const entry = terminals.get(selectedSession);
  if (entry) { entry.historyVisible = visible; entry.automaticHistory = visible && automatic; }
  $('history-panel').hidden = !visible || !selectedSession;
  $('terminal-host').hidden = visible || !selectedSession;
  $('terminal-controls').hidden = visible || !selectedSession;
  $('history-toggle').textContent = visible ? '返回终端' : '查看历史';
  if (visible) scrollHistoryToEnd(selectedSession);
  else requestAnimationFrame(() => { fitCurrent(); scheduleReadCheck(); });
}
function scrollHistoryToEnd(id) {
  const intent = historyScrollIntent;
  requestAnimationFrame(() => {
    if (selectedSession !== id || renderedHistory.id !== id || !historyVisible || historyScrollIntent !== intent || historySearchActive()) return;
    const container = $('history-messages');
    container.scrollTop = container.scrollHeight;
    scheduleReadCheck();
  });
}
function historySearchActive() { return !$('history-search').hidden && Boolean($('history-search-input').value.trim()); }
function renderHistorySearchCount(result) {
  const hasQuery = Boolean($('history-search-input').value.trim());
  $('history-search-count').textContent = !hasQuery ? '' : result.count ? `${result.index + 1} / ${result.count}${result.clipped ? '+' : ''}` : historyLoadingId === selectedSession ? '正在读取…' : '无匹配';
  $('history-search-previous').disabled = !result.count;
  $('history-search-next').disabled = !result.count;
  const count = renderedHistory.id === selectedSession ? renderedHistory.messages.length : 0;
  $('history-search-scope').textContent = `仅搜索当前已加载的 ${count} 条消息（最多最近 100 条）；包含双方发言、代码和表格`;
}
function refreshHistorySearch(navigate = false) {
  if ($('history-search').hidden) return;
  clearTimeout(historySearchTimer); historySearchTimer = null;
  if (renderedHistory.id !== selectedSession) {
    historySearch.reset(); renderHistorySearchCount({ index: -1, count: 0 }); return;
  }
  const result = historySearch.refresh($('history-search-input').value);
  renderHistorySearchCount(result);
  if (navigate && result.count) {
    historyBottomTarget = null; historyScrollIntent++;
    historySearch.reveal(); scheduleReadCheck();
  }
}
function openHistorySearch() {
  if (!selectedSession || document.querySelector('dialog[open]')) return;
  if (composerExpanded) setComposerExpanded(false, false);
  setHistoryVisible(true);
  historyBottomTarget = null; historyScrollIntent++;
  $('history-search').hidden = false;
  $('history-search-toggle').setAttribute('aria-expanded', 'true');
  refreshHistorySearch(true);
  $('history-search-input').focus(); $('history-search-input').select();
  if (!historyLoadingId) action(() => loadHistory(selectedSession, { background: true }))();
}
function closeHistorySearch() {
  clearTimeout(historySearchTimer); historySearchTimer = null;
  historySearch.reset();
  $('history-search').hidden = true;
  $('history-search-input').value = '';
  $('history-search-toggle').setAttribute('aria-expanded', 'false');
}
function moveHistorySearch(delta) {
  if (historySearchTimer) refreshHistorySearch();
  historyBottomTarget = null; historyScrollIntent++;
  renderHistorySearchCount(historySearch.move(delta));
  scheduleReadCheck();
}
function setComposerExpanded(expanded, focus = true) {
  const prompt = $('prompt');
  const sessionId = selectedSession;
  const start = prompt.selectionStart;
  const end = prompt.selectionEnd;
  const direction = prompt.selectionDirection;
  const scrollTop = prompt.scrollTop;
  composerExpanded = Boolean(expanded && selectedSession);
  $('composer-area').classList.toggle('expanded', composerExpanded);
  $('composer-expand').setAttribute('aria-expanded', String(composerExpanded));
  $('composer-expand').textContent = composerExpanded ? '收起输入' : '展开输入';
  $('composer-expand').title = composerExpanded ? '收起输入框，也可在输入框中按 Esc' : '展开输入框，编辑长消息';
  for (const id of ['session-header', 'history-panel', 'terminal-host', 'terminal-controls']) $(id).inert = composerExpanded;
  requestAnimationFrame(() => {
    fitCurrent();
    scheduleReadCheck();
    if (!focus || selectedSession !== sessionId || prompt.disabled) return;
    prompt.focus({ preventScroll: true });
    prompt.setSelectionRange(start, end, direction);
    prompt.scrollTop = scrollTop;
  });
}
function createHistoryMessage(message) {
  const article = document.createElement('article'); article.className = 'history-message ' + message.role;
  const head = document.createElement('div'); head.className = 'history-message-head';
  const label = document.createElement('span'); label.textContent = message.role === 'user' ? '我' : '助手';
  if (message.localId) { article.classList.add('local-message'); label.textContent = `我 · ${deliveryLabels[message.deliveryState] || '本机文字备份'}`; }
  const actions = document.createElement('div'); actions.className = 'history-message-actions';
  const copy = document.createElement('button'); copy.className = 'quiet'; copy.textContent = '复制全文'; copy.title = '复制整条消息的 Markdown 原文';
  copy.onclick = action(async () => { await window.relay.copyText(message.text); notice('已复制整条消息原文。'); });
  if (message.localId && message.recoverableText) {
    const restore = document.createElement('button'); restore.className = 'quiet'; restore.textContent = '恢复文字';
    restore.onclick = () => restoreMessage({ id: message.localId, sessionId: selectedSession, text: message.text, attachments: message.attachments }); actions.append(restore);
  }
  const body = document.createElement('div'); body.className = 'history-message-body';
  const projectId = workspace.sessions.find((entry) => entry.id === selectedSession)?.projectId;
  const handlers = {
    copy: (text) => window.relay.copyText(text),
    openLink: (url) => window.relay.openLink(url),
    openPath: (value) => {
      const project = workspace.projects.find((entry) => entry.id === projectId);
      if (!project?.localPath && !/^[a-z]:[\\/]/i.test(value)) { openProjectFolder(projectId); notice('请设置本地项目目录，保存后再点击路径。'); return; }
      return window.relay.openProjectPath(projectId, value);
    },
    error: (error) => notice(errorMessage(error)),
  };
  const renderMarkdown = () => {
    if (window.relayMarkdown) window.relayMarkdown.render(body, message.text, handlers);
    else body.textContent = message.text;
  };
  const raw = document.createElement('button'); raw.className = 'quiet'; raw.textContent = '原文'; raw.title = '切换 Markdown 原文与排版'; raw.setAttribute('aria-pressed', 'false');
  let rawVisible = false;
  raw.onclick = () => {
    rawVisible = !rawVisible;
    raw.textContent = rawVisible ? '排版' : '原文';
    raw.setAttribute('aria-pressed', String(rawVisible));
    if (rawVisible) { body.classList.remove('markdown-body'); body.textContent = message.text; }
    else renderMarkdown();
    refreshHistorySearch();
  };
  renderMarkdown();
  actions.append(raw, copy); head.append(label, actions); article.append(head, body);
  return article;
}
function renderHistory(result) {
    const messages = result.messages || [];
    const openAtBottom = historyBottomTarget === selectedSession;
    const states = { cached: '本地缓存', fresh: '已同步', offline: '离线缓存', error: '同步失败 · 显示缓存', missing: '服务器暂未找到记录 · 显示缓存' };
    $('history-state').textContent = `${states[result.syncState] || '已读取'} · ${messages.length} 条消息`;
    $('history-state').title = result.syncError ? errorMessage(result.syncError) : result.updatedAt ? `最近同步：${new Date(result.updatedAt).toLocaleString()}` : '';
    const previous = renderedHistory.messages;
    const messageKey = (message) => [message.role, message.text, message.localId || '', message.deliveryState || ''].join('\0');
    if (renderedHistory.id === selectedSession && previous.length === messages.length && messages.every((message, index) => messageKey(message) === messageKey(previous[index]))) {
      renderedHistory.completion = result.completion || '';
      if (openAtBottom) { historyBottomTarget = null; scrollHistoryToEnd(selectedSession); }
      return;
    }
    const container = $('history-messages');
    const atBottom = !historySearchActive() && (openAtBottom || renderedHistory.id !== selectedSession || !container.childElementCount || container.scrollHeight - container.scrollTop - container.clientHeight < 40);
    const previousTop = container.scrollTop;
    const reusable = new Map();
    if (renderedHistory.id === selectedSession) {
      const children = Array.from(container.children);
      for (let index = 0; index < previous.length; index++) {
        const node = children[index];
        if (!node?.classList.contains('history-message')) continue;
        const key = messageKey(previous[index]);
        if (!reusable.has(key)) reusable.set(key, []);
        reusable.get(key).push(node);
      }
    }
    const nodes = messages.map((message) => reusable.get(messageKey(message))?.shift() || createHistoryMessage(message));
    // Retain unchanged Markdown nodes, copied-state controls, and raw-view choices on incremental sync.
    for (let index = 0; index < nodes.length; index++) {
      if (container.children[index] !== nodes[index]) container.insertBefore(nodes[index], container.children[index] || null);
    }
    while (container.children.length > nodes.length) container.lastElementChild.remove();
    if (!nodes.length) { const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = '暂无历史消息。连接服务器后可以刷新。'; container.replaceChildren(empty); }
    renderedHistory = { id: selectedSession, messages, completion: result.completion || '' };
    refreshHistorySearch();
    container.scrollTop = atBottom ? container.scrollHeight : previousTop;
    if (openAtBottom) { historyBottomTarget = null; scrollHistoryToEnd(selectedSession); }
}
async function loadHistory(id, { restore = false, background = false } = {}) {
  if (selectedSession !== id) return;
  const request = ++historyRequest;
  const viewRevision = historyViewRevision;
  historyLoadingId = id;
  const current = () => selectedSession === id && historyRequest === request;
  const display = (result) => {
    if (!current()) return;
    renderHistory(result);
    // Show cached messages while waiting for the persistent terminal to redraw.
    if (restore && !terminals.get(id)?.launchOutput && result.messages?.length && historyViewRevision === viewRevision && !historyVisible) setHistoryVisible(true, true);
  };
  if (!background) $('history-state').textContent = '正在读取…';
  try {
    if (!background) {
      const cached = await window.relay.sessionHistory(id, false);
      if (!current()) return;
      display(cached);
    }
    if (status.ssh !== 'ready') return;
    const result = await window.relay.sessionHistory(id, true);
    display(result);
    refreshOutgoing(id).catch((error) => { if (current()) notice(errorMessage(error)); });
  } catch (error) { if (current()) $('history-state').textContent = errorMessage(error); }
  finally { if (historyRequest === request) { historyLoadingId = null; if (!$('history-search').hidden) renderHistorySearchCount(historySearch.snapshot()); scheduleReadCheck(); } }
}
function renderStagedFiles() {
  const container = $('staged-files');
  const sessionId = selectedSession;
  const files = stagedBySession.get(selectedSession) || [];
  container.replaceChildren();
  container.hidden = files.length === 0;
  for (const file of files) {
    const chip = document.createElement('span'); chip.className = 'staged-file';
    const label = file.kind === 'clipboard-image' ? `剪贴板图片 · ${file.width}×${file.height} · ${file.format}` : file.name;
    const name = document.createElement('span'); name.className = 'staged-file-name'; name.textContent = label; name.title = label;
    const size = document.createElement('span'); size.className = 'staged-file-size'; size.textContent = `${(file.sizeBytes / 1048576).toFixed(1)} MiB`;
    if (file.kind === 'clipboard-image' && /^data:image\/(png|jpeg);base64,/.test(file.thumbnail || '')) {
      const thumbnail = document.createElement('img'); thumbnail.src = file.thumbnail; thumbnail.alt = '待发送的剪贴板图片'; thumbnail.className = 'staged-image-preview';
      chip.append(thumbnail);
      chip.title = '点击发送后上传压缩图片，远端缓存最多 128 MiB，保留七天。';
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${label}`); remove.disabled = sending || stagingImage;
    remove.onclick = action(async () => {
      if (sending || stagingImage) return;
      await window.relay.discardLocalFiles([file.id]);
      stagedBySession.set(sessionId, (stagedBySession.get(sessionId) || []).filter((item) => item.id !== file.id));
      if (selectedSession === sessionId) renderStagedFiles();
    });
    chip.append(name, size, remove); container.append(chip);
  }
}
function addStagedFiles(sessionId, entries) {
  if (!entries?.length) return;
  const current = stagedBySession.get(sessionId) || [];
  stagedBySession.set(sessionId, [...current, ...entries]);
  if (selectedSession === sessionId) renderStagedFiles();
  notice(`已添加 ${entries.length} 个本机文件，仅发送路径。`);
}
async function copyTerminalSelection(id, captured = '') {
  const text = captured || terminals.get(id)?.terminal.getSelection() || '';
  if (!text) { notice('请先在对话中用鼠标选中文字；若鼠标由终端接管，请按住 Shift 拖选。'); return; }
  await window.relay.copyText(text);
  notice('已复制所选文字。');
}
function makeTerminal(id) {
  if (terminals.has(id)) return terminals.get(id);
  const element = document.createElement('div'); element.className = 'terminal-pane'; $('terminal-host').append(element);
  const terminal = new Terminal({ fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 14, lineHeight: 1.25, cursorBlink: true, scrollback: 6000, scrollSensitivity: 2.5, allowProposedApi: false, theme: { background: '#13171c', foreground: '#dfe6eb', cursor: '#95d5bf', selectionBackground: '#496b6070', black: '#1c232b', brightBlack: '#7c8998', red: '#e59d8f', green: '#9ccfaf', cyan: '#8ac9c8', yellow: '#dfc38e', blue: '#93b8e1', magenta: '#c5add6', white: '#e5edf2' } });
  const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(element);
  window.relayTerminalUI.installLinks(terminal,{openPath:value=>{const session=workspace.sessions.find(s=>s.id===id);if(!session)throw new Error('Session not found.');return window.relay.openProjectPath(session.projectId,value);},openLink:value=>window.relay.openLink(value),error:error=>notice(errorMessage(error))});
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== 'c' || !terminal.hasSelection()) return true;
    event.preventDefault();
    event.stopPropagation();
    copyTerminalSelection(id).catch((error) => notice(errorMessage(error)));
    return false;
  });
  element.addEventListener('contextmenu', (event) => {
    if (!terminal.hasSelection()) return;
    event.preventDefault();
    copyTerminalSelection(id).catch((error) => notice(errorMessage(error)));
  });
  const entry = { id, element, terminal, fit, connected: false, opening: false, endedDuringOpen: false, launchEpoch: 0, launchOutput: false, pendingWrites: 0, lastOutputAt: 0, promptReady: false, taskRunning: false };
  terminal.onData((data) => {
    entry.lastUserInputAt = Date.now();
    if (entry.connected && !entry.mcpRepairing) window.relay.input(id, data).catch((error) => notice(errorMessage(error)));
  });
  terminal.onResize(({ cols, rows }) => { if (entry.connected) window.relay.resize(id, cols, rows).catch(() => {}); });
  terminal.onScroll(() => { if (selectedSession === id) scheduleReadCheck(); });
  terminals.set(id, entry);
  return entry;
}
function fitCurrent() {
  const entry = terminals.get(selectedSession);
  if (!entry || entry.element.hidden || $('terminal-host').hidden) return;
  try { entry.fit.fit(); } catch {}
}
async function activateSession(id, { connectSession = false } = {}) {
  notice('');
  const session = workspace.sessions.find((entry) => entry.id === id);
  if (!session) return;
  selectedProject = session.projectId;
  const entry = makeTerminal(id);
  historyBottomTarget = id;
  historyVisible = entry.connected ? entry.historyVisible ?? false : true;
  showSession(id);
  refreshOutgoing(id).catch((error) => notice(errorMessage(error)));
  loadHistory(id, { restore: !entry.connected });
  if (!connectSession) return;
  if (entry.connected || entry.opening || entry.ending) return;
  entry.connectionRequested = true;
  if (status.tunnel !== 'ready' || status.ssh !== 'ready') {
    await connect();
    if (status.tunnel !== 'ready' || status.ssh !== 'ready') { entry.connectionRequested = false; return; }
  }
  if (selectedSession === id) setHistoryVisible(false);
  await openTerminalSession(id, entry);
}
async function openTerminalSession(id, entry) {
  if (entry.opening) throw new Error('This conversation is still connecting.');
  entry.opening = true;
  entry.capacityBlocked = false;
  entry.endedDuringOpen = false;
  entry.launchEpoch++;
  entry.launchOutput = false;
  entry.pendingWrites = 0;
  entry.promptReady = false;
  entry.mcpFailureTail = ''; entry.mcpReconnectRequested = null;
  updateSessionState();
  try {
    if (selectedSession === id) fitCurrent();
    entry.terminal.write('\r\n正在连接远程对话…\r\n');
    const opened = await window.relay.openSession(id, { cols: entry.terminal.cols, rows: entry.terminal.rows });
    if (opened?.releasedCount) notice(`已释放 ${opened.releasedCount} 个已完成且未连接的旧进程，历史记录保留。`);
    if (opened?.opened === false) {
      entry.connected = false; entry.capacityBlocked = true;
      if (selectedSession === id) showCapacityDialog(id, opened.capacity);
      return false;
    }
    if (!entry.endedDuringOpen) { entry.connected = true; if (selectedSession === id && !sending) entry.terminal.focus(); }
    updateSessionState();
    return !entry.endedDuringOpen;
  } finally { entry.opening = false; if (!entry.capacityBlocked) entry.connectionRequested = false; updateSessionState(); }
}
async function waitForInputPrompt(entry) {
  entry.promptReady = false;
  const epoch = entry.launchEpoch;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (!entry.connected || entry.launchEpoch !== epoch || status.tunnel !== 'ready') throw new Error('远程连接已断开，消息和附件已保留，请重新连接后发送。');
    if (entry.launchOutput && !entry.pendingWrites && Date.now() - entry.lastOutputAt >= 150) {
      const buffer = entry.terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).trimStart() || '';
      // Read the parsed terminal cursor row, not old scrollback or ANSI fragments.
      if (/^[❯›>](?:\s|$)/u.test(line) && !/^[❯›>]\s*\d+[.)]/u.test(line)) {
        entry.promptReady = true;
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('远端输入框尚未就绪，消息和附件已保留。请先在终端完成启动确认，再重新发送。');
}
function canReconnectMcp(entry, automatic) {
  if (!entry.connected || entry.opening || entry.ending || entry.mcpRepairing || !entry.launchOutput || entry.pendingWrites || sending || applyingModel || composerExpanded || document.querySelector('dialog[open]')) return false;
  if (status.mcp !== 'ready' || status.tunnel !== 'ready' || status.settingsChanging || status.control?.changing || entry.taskRunning) return false;
  if (Date.now() - Math.max(entry.lastOutputAt || 0, entry.lastUserInputAt || 0) < 1500) return false;
  const buffer = entry.terminal.buffer.active;
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || '';
  if (!window.relayMcpRecovery.emptyPrompt(line)) return false;
  const task = status.monitor?.sessions?.[entry.id];
  const fresh = status.monitor?.receivedAt && !status.monitor.error && Date.now() - status.monitor.receivedAt < 20000;
  if (fresh && ['running', 'waiting'].includes(task?.state)) return false;
  return !automatic || Boolean(fresh && task?.confirmed && ['completed', 'failed', 'interrupted', 'stopped'].includes(task.state));
}
async function attemptMcpReconnect(id, entry) {
  const requested = entry.mcpReconnectRequested;
  if (!requested || !canReconnectMcp(entry, requested.automatic)) return;
  const now = Date.now();
  entry.mcpAttempts = (entry.mcpAttempts || []).filter((at) => now - at < 600000);
  if (requested.automatic && entry.mcpAttempts.length >= 3) {
    entry.mcpReconnectRequested = null;
    if (selectedSession === id) notice('MCP 自动重连已尝试 3 次，暂时停止；可检查终端或点击“重连 MCP”。');
    updateSessionState(); return;
  }
  if (requested.automatic && now - (entry.lastMcpAttempt || 0) < 45000) return;
  entry.mcpReconnectRequested = null;
  entry.lastMcpAttempt = now; entry.mcpAttempts.push(now);
  entry.mcpRepairing = true; entry.mcpRepairFailure = false;
  const epoch = entry.launchEpoch, beforeOutput = entry.lastOutputAt;
  updateSessionState();
  try {
    await window.relay.reconnectMcp(id);
    if (selectedSession === id) notice('已通过 Claude 原生命令发起 Windows-MCP 重连。');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && entry.connected && entry.launchEpoch === epoch) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (entry.pendingWrites || entry.lastOutputAt <= beforeOutput || Date.now() - entry.lastOutputAt < 1000) continue;
      const buffer = entry.terminal.buffer.active;
      if (window.relayMcpRecovery.emptyPrompt(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || '')) break;
    }
  } catch (error) {
    if (requested.automatic && entry.connected && entry.launchEpoch === epoch) entry.mcpReconnectRequested = { automatic: true };
    if (selectedSession === id) notice(errorMessage(error));
  } finally {
    entry.mcpRepairing = false;
    if (entry.mcpRepairFailure && entry.connected && entry.launchEpoch === epoch) entry.mcpReconnectRequested = { automatic: true };
    updateSessionState();
  }
}
async function connectForSend(id, entry) {
  while (!entry.connected) {
    if (entry.opening || entry.ending || !workspace.sessions.some((session) => session.id === id)) return false;
    entry.connectionRequested = true;
    if (await openTerminalSession(id, entry)) return true;
    if (!entry.capacityBlocked || pendingCapacityTarget !== id || !$('capacity-dialog').open) return false;
    const resume = await new Promise((resolve) => { capacitySendWaiter = { id, resolve }; updateSessionState(); });
    if (!resume || status.ssh !== 'ready' || status.tunnel !== 'ready') return false;
  }
  return true;
}
async function send() {
  if (terminals.get(selectedSession)?.mcpRepairing) { notice('正在重连 MCP，输入内容已保留，请稍后发送。'); return; }
  const sessionId = selectedSession;
  const entry = terminals.get(sessionId);
  const text = $('prompt').value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const files = stagedBySession.get(sessionId) || [];
  if (!entry || entry.opening || entry.ending || connecting || status.settingsChanging || status.control?.changing || (!text.trim() && !files.length) || sending || stagingImage) return;
  if (text.length > 60000) throw new Error('Please shorten this message to 60,000 characters.');
  const session = workspace.sessions.find((item) => item.id === sessionId);
  const settings = modelDrafts.get(`session:${sessionId}`) || { model: session?.model || '', effort: session?.effort || '' };
  const changed = settings.model !== (session?.model || '') || settings.effort !== (session?.effort || '');
  if (changed && entry.taskRunning) {
    notice('当前任务仍在运行。请等待任务结束或先停止任务，再发送新的模型设置；输入内容已保留。');
    return;
  }
  sending = true;
  saveDraft(sessionId, text);
  if (selectedSession === sessionId) setHistoryVisible(false);
  renderModels(); updateSessionState();
  try {
    const outgoing = await window.relay.prepareMessage(sessionId, text, files.map((file) => file.id), draftAttempts.get(sessionId) || null);
    saveDraftAttempt(sessionId, outgoing.id);
    outgoingBySession.set(sessionId, [...(outgoingBySession.get(sessionId) || []).filter((item) => item.id !== outgoing.id), outgoing]); renderSendRecovery();
    if (status.ssh !== 'ready' || status.tunnel !== 'ready' || status.mcp !== 'ready') await connect();
    if (status.ssh !== 'ready' || status.tunnel !== 'ready' || status.mcp !== 'ready') { notice('未能建立连接，消息和附件已保留，请重试。'); return; }
    if (changed) await applyModelChange({ sessionId, settings: { ...settings } }, entry, { open: false });
    if (!await connectForSend(sessionId, entry)) { notice('本次发送已取消或连接未完成，消息和附件已保留。'); return; }
    await waitForInputPrompt(entry);
    const delivery = await window.relay.sendMessage(sessionId, text, files.map((file) => file.id), outgoing.id);
    if (!delivery?.submitted && !delivery?.accepted) {
      notice('消息未能提交，输入文字和附件已保留；可在“发送记录”中恢复文字。');
      return;
    }
    entry.taskRunning = true;
    const unchanged = drafts.get(sessionId) === text;
    if (unchanged) { saveDraft(sessionId, ''); saveDraftAttempt(sessionId, null); }
    const sentIds = new Set(files.map((file) => file.id));
    stagedBySession.set(sessionId, (stagedBySession.get(sessionId) || []).filter((file) => !sentIds.has(file.id)));
    if (selectedSession === sessionId) { if (unchanged) { $('prompt').value = ''; setComposerExpanded(false); } renderStagedFiles(); }
    entry.terminal.scrollToBottom();
    notice(delivery.alreadyAccepted ? '已确认上一次消息实际已被远端接收，本次没有重复发送。' : delivery.alreadySubmitted ? '这条消息之前已提交，本次没有重复发送。文字备份保留在“发送记录”。' : '');
  } finally {
    try { await refreshOutgoing(sessionId); } catch (error) { notice(errorMessage(error)); }
    sending = false; renderModels(); updateSessionState();
    if (selectedSession === sessionId) loadHistory(sessionId, { background: true });
  }
}
$('connect').onclick = () => connect();
$('force-control').onchange = action(async () => {
  const enabled = $('force-control').checked;
  $('force-control').disabled = true;
  try { renderStatus(await window.relay.forceControl(enabled)); }
  catch (error) { renderStatus((await window.relay.snapshot()).status); throw error; }
});
$('keep-awake').onchange = action(async () => {
  const enabled = $('keep-awake').checked;
  $('keep-awake').disabled = true;
  try { renderKeepAwake(await window.relay.keepAwake(enabled)); }
  catch (error) { renderKeepAwake((await window.relay.snapshot()).keepAwake); throw error; }
});
$('services-toggle').onclick = () => {
  servicesCollapsed = !servicesCollapsed;
  try { localStorage.setItem('relayDesk.servicesCollapsed', String(servicesCollapsed)); } catch {}
  renderServicesVisibility();
};
window.addEventListener('storage', (event) => {
  if (event.key === 'relayDesk.usageCollapsed') { usageCollapsed = event.newValue === 'true'; renderUsageVisibility(); }
  if (event.key !== 'relayDesk.servicesCollapsed') return;
  servicesCollapsed = event.newValue === 'true';
  renderServicesVisibility();
});
$('empty-connect').onclick = () => connect();
$('disconnect').onclick = action(() => window.relay.disconnect());
$('configuration').onclick = action(async () => {
  const settings = await window.relay.connectionSettings();
  $('settings-target').value = settings.target;
  $('settings-ssh-port').value = settings.sshPort;
  $('settings-key').value = settings.keyPath;
  $('settings-max-sessions').value = settings.maxSessions;
  $('settings-passphrase').value = '';
  $('settings-mcp-summary').textContent = `MCP 首选端口：本机 ${settings.localPort}，服务器 ${settings.remotePort}；冲突时自动选择可用端口。MCP 密钥已配置，保持隐藏并沿用。`;
  $('settings-error').hidden = true;
  $('settings-dialog').showModal();
});
$('settings-pick-key').onclick = action(async () => { const key = await window.relay.pickSshKey(); if (key) $('settings-key').value = key; });
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  if (settingsBusy) return;
  settingsBusy = true; $('settings-error').hidden = true;
  for (const control of $('settings-form').querySelectorAll('input, button')) control.disabled = true;
  $('settings-save').textContent = '正在应用…';
  try {
    const result = await window.relay.saveConnectionSettings({ target: $('settings-target').value.trim(), sshPort: Number($('settings-ssh-port').value),
      keyPath: $('settings-key').value, maxSessions: Number($('settings-max-sessions').value), passphrase: $('settings-passphrase').value });
    renderStatus(result.status);
    if (!result.applied) throw new Error(`配置已保存，但未能应用到连接：${errorMessage(result.error)}`);
    $('settings-dialog').close(); notice(`配置已应用：活跃会话上限 ${result.settings.maxSessions}。`);
  } catch (error) { $('settings-error').textContent = errorMessage(error); $('settings-error').hidden = false; }
  finally {
    $('settings-passphrase').value = ''; settingsBusy = false;
    for (const control of $('settings-form').querySelectorAll('input, button')) control.disabled = false;
    $('settings-save').textContent = '保存并应用';
  }
};
$('settings-dialog').addEventListener('cancel', (event) => { if (settingsBusy) event.preventDefault(); });
$('settings-dialog').addEventListener('close', () => { $('settings-passphrase').value = ''; });

function renderCapacity(capacity) {
  const target = workspace.sessions.find((session) => session.id === pendingCapacityTarget);
  const connected = new Set((status.sessionConnections || []).map((entry) => entry.id));
  const connectedCount = capacity.active.filter((session) => connected.has(session.id)).length;
  $('capacity-summary').textContent = capacity.reason === 'memory'
    ? `服务器可用内存约 ${capacity.availableMiB} MiB，启动新会话需要至少 ${capacity.requiredMiB} MiB。可结束下列会话，为“${target?.name || '目标对话'}”腾出内存。`
    : `服务器保留着 ${capacity.active.length} 个会话进程，上限 ${capacity.maxSessions}；其中 ${connectedCount} 个已在本 App 连接。已完成且无人连接的旧进程会自动清理；运行中、状态不明或刚完成的任务会保留。若仍无空位，可选择结束一个会话，再连接“${target?.name || '目标对话'}”；重连已有进程不新增名额。`;
  if (sending) $('capacity-summary').textContent += ' 消息和附件已保留；腾出位置后继续本次发送，取消则不发送。';
  const list = $('capacity-list'); list.replaceChildren();
  for (const session of capacity.active) {
    const row = document.createElement('div'); row.className = 'capacity-row';
    const info = document.createElement('div'); info.className = 'capacity-row-info';
    const name = document.createElement('strong'); name.textContent = `${session.provider === 'codex' ? 'Codex' : 'Claude'} · ${session.name}`;
    const detail = document.createElement('small');
    const connectionLabel = session.starting ? '启动中' : connected.has(session.id) ? session.otherWindow ? '已在本 App 其他窗口连接' : '本窗口已连接' : '未在本 App 连接 · 服务器保留';
    const task = status.monitor?.sessions?.[session.id];
    const fresh = !status.monitor?.error && status.monitor?.receivedAt && Date.now() - status.monitor.receivedAt < 20000;
    const taskLabels = { running: '任务运行中', waiting: '等待确认或回答', completed: '最近任务已完成', failed: '最近任务失败', interrupted: '最近任务中断', stopped: '最近任务已结束' };
    const taskLabel = fresh && task?.confirmed && taskLabels[task.state] || '任务状态待确认';
    detail.textContent = `${session.projectName} · ${connectionLabel} · ${taskLabel}`;
    info.append(name, detail);
    const end = document.createElement('button'); end.type = 'button'; end.className = 'capacity-end'; end.textContent = '结束并腾出位置'; end.disabled = capacityBusy || session.starting;
    end.dataset.starting = String(session.starting);
    end.onclick = async () => {
      if (capacityBusy || !pendingCapacityTarget) return;
      const targetId = pendingCapacityTarget;
      capacityBusy = true; $('capacity-error').hidden = true; end.textContent = '正在结束…';
      for (const button of $('capacity-dialog').querySelectorAll('button')) button.disabled = true;
      try {
        await window.relay.releaseSession(session.id, session.provider);
        const updated = await window.relay.activeSessions(targetId);
        if (!updated.available) { renderCapacity(updated); return; }
        await resumeCapacityTarget(targetId);
      } catch (error) { $('capacity-error').textContent = errorMessage(error); $('capacity-error').hidden = false; }
      finally {
        capacityBusy = false;
        for (const button of $('capacity-dialog').querySelectorAll('button')) button.disabled = button.dataset.starting === 'true';
        end.textContent = '结束并腾出位置';
        if ($('capacity-dialog').open) refreshCapacityList().catch((error) => { $('capacity-error').textContent = errorMessage(error); $('capacity-error').hidden = false; });
      }
    };
    row.append(info, end); list.append(row);
  }
  if (!capacity.active.length) { const empty = document.createElement('p'); empty.textContent = '当前没有可结束的活跃会话，请检查服务器内存或刷新重试。'; list.append(empty); }
}
function showCapacityDialog(id, capacity) {
  pendingCapacityTarget = id;
  const entry = terminals.get(id); if (entry) entry.capacityBlocked = true;
  $('capacity-error').hidden = true;
  renderCapacity(capacity);
  $('capacity-cancel').textContent = sending ? '取消发送' : '暂不连接';
  if (!$('capacity-dialog').open) { $('capacity-dialog').showModal(); $('capacity-cancel').focus(); }
  updateSessionState();
}
async function refreshCapacityList() {
  const id = pendingCapacityTarget;
  if (!id) return;
  const capacity = await window.relay.activeSessions(id);
  if (pendingCapacityTarget === id && $('capacity-dialog').open) {
    if (capacity.available && !capacityBusy) await resumeCapacityTarget(id);
    else renderCapacity(capacity);
  }
}
$('capacity-refresh').onclick = action(refreshCapacityList);
$('capacity-dialog').addEventListener('cancel', (event) => { if (capacityBusy) event.preventDefault(); });
function closeCapacityRequest(resume = false) {
  const id = pendingCapacityTarget;
  pendingCapacityTarget = null;
  const entry = terminals.get(id); if (entry) entry.connectionRequested = false;
  if (capacitySendWaiter?.id === id) {
    const waiter = capacitySendWaiter; capacitySendWaiter = null; waiter.resolve(resume);
  }
  if ($('capacity-dialog').open) $('capacity-dialog').close();
}
async function resumeCapacityTarget(id) {
  if (pendingCapacityTarget !== id) return;
  const waitingToSend = capacitySendWaiter?.id === id;
  closeCapacityRequest(true);
  if (!waitingToSend) await activateSession(id, { connectSession: true });
}
$('capacity-dialog').addEventListener('close', () => { if (!$('capacity-dialog').open && pendingCapacityTarget) closeCapacityRequest(false); });
window.relay.on('capacity', ({ id, capacity: suppliedCapacity }) => {
  if (selectedSession !== id) return;
  (suppliedCapacity ? Promise.resolve(suppliedCapacity) : window.relay.activeSessions(id)).then(async (capacity) => {
    if (selectedSession !== id) return;
    const entry = terminals.get(id);
    if (!entry?.connectionRequested) return;
    if (capacity.available && entry && !entry.opening) {
      if (capacitySendWaiter?.id === id) await resumeCapacityTarget(id);
      else await activateSession(id, { connectSession: true });
    }
    else showCapacityDialog(id, capacity);
  }).catch((error) => notice(errorMessage(error)));
});
$('new-window').onclick = action(() => window.relay.newWindow());
$('add-project').onclick = () => $('project-dialog').showModal();
function openProjectFolder(id) {
  const project = workspace.projects.find((entry) => entry.id === id);
  if (!project) return;
  editingProjectFolder = id;
  $('project-folder-name').textContent = project.name;
  directoryDrafts = window.relayProjectTools.locationsFor(project).map((entry) => ({ ...entry }));
  renderDirectoryDrafts();
  $('project-folder-error').hidden = true;
  $('project-folder-dialog').showModal();
}
function renderDirectoryDrafts() {
  const list = $('project-directory-list'); list.replaceChildren();
  function button(text, title, callback) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'quiet'; item.textContent = text;
    item.title = title; item.setAttribute('aria-label', title); item.onclick = callback;
    return item;
  }
  for (const [index, entry] of directoryDrafts.entries()) {
    const row = document.createElement('div'); row.className = 'project-directory-row';
    const label = document.createElement('small'); label.textContent = `${entry.kind === 'local' ? 'Windows' : '服务器'}${index === 0 ? ' · 默认' : ''}`;
    const input = document.createElement('input'); input.required = true; input.value = entry.path; input.placeholder = entry.kind === 'local' ? 'D:\\example_project' : '~/projects/my-project';
    input.setAttribute('aria-label', `第 ${index + 1} 个目录`); input.oninput = () => { entry.path = input.value; };
    const move = (delta) => {
      const destination = index + delta;
      [directoryDrafts[index], directoryDrafts[destination]] = [directoryDrafts[destination], directoryDrafts[index]];
      renderDirectoryDrafts(); list.children[destination]?.querySelector('input')?.focus();
    };
    const up = button('↑', '上移目录', () => move(-1)); up.disabled = index === 0;
    const down = button('↓', '下移目录', () => move(1)); down.disabled = index === directoryDrafts.length - 1;
    const remove = button('×', '移除此目录', () => { directoryDrafts.splice(index, 1); renderDirectoryDrafts(); }); remove.disabled = directoryDrafts.length <= 1;
    row.append(label, input);
    if (entry.kind === 'local') row.append(button('选择…', '选择 Windows 文件夹', action(async () => {
      const folder = await window.relay.pickProjectFolder();
      if (folder) { entry.path = folder; input.value = folder; }
    })));
    row.append(up, down, remove); list.append(row);
  }
  for (const kind of ['local', 'remote']) $('project-directory-add-' + kind).disabled = directoryDrafts.length >= 12;
}
for (const kind of ['local', 'remote']) $('project-directory-add-' + kind).onclick = () => {
  directoryDrafts.push({ kind, path: '' }); renderDirectoryDrafts(); $('project-directory-list').lastElementChild.querySelector('input').focus();
};
$('new-project-folder-pick').onclick = action(async () => {
  const folder = await window.relay.pickProjectFolder();
  if (folder) $('new-project-local-path').value = folder;
});
$('project-folder-form').onsubmit = async (event) => {
  event.preventDefault();
  $('project-folder-save').disabled = true;
  try {
    await window.relay.saveProjectFolder(editingProjectFolder, directoryDrafts);
    $('project-folder-dialog').close();
    notice('项目目录已保存，第一项用于新建终端和打开文件浏览器。');
  } catch (error) { $('project-folder-error').textContent = errorMessage(error); $('project-folder-error').hidden = false; }
  finally { $('project-folder-save').disabled = false; }
};
async function openProjectDelete(id) {
  const preview = await window.relay.previewProjectDelete(id);
  pendingProjectDelete = preview;
  $('project-delete-summary').textContent = `删除“${preview.project.name}”及其 ${preview.conversationCount} 个本机对话条目？`;
  $('project-delete-stop-row').hidden = !preview.active.length;
  $('project-delete-stop').checked = preview.active.length > 0;
  $('project-delete-stop-label').textContent = `同时结束本项目的 ${preview.active.length} 个活跃会话（会中断当前任务）`;
  $('project-delete-remote-note').textContent = !preview.remoteKnown ? '未能确认远端状态。仅移除本机列表，远端可能运行的会话不会被结束。' : preview.active.length ? `活跃会话：${preview.active.map((entry) => entry.name).join('、')}。取消勾选会保留它们，它们仍会占用会话名额。` : '当前没有检测到本项目的活跃会话。';
  $('project-delete-error').hidden = true;
  updateProjectDeleteButton();
  $('project-delete-dialog').showModal();
  $('project-delete-dialog').querySelector('[data-close]').focus();
}
function updateProjectDeleteButton() {
  $('project-delete-confirm').textContent = $('project-delete-stop').checked ? '结束会话并删除项目' : '从列表删除项目';
}
$('project-delete-stop').onchange = updateProjectDeleteButton;
$('project-delete-form').onsubmit = async (event) => {
  event.preventDefault();
  if (!pendingProjectDelete || projectDeleteBusy) return;
  projectDeleteBusy = true; $('project-delete-error').hidden = true;
  for (const button of $('project-delete-dialog').querySelectorAll('button, input')) button.disabled = true;
  try {
    await window.relay.deleteProject(pendingProjectDelete.project.id, $('project-delete-stop').checked);
    $('project-delete-dialog').close();
    notice('项目已从列表删除，服务器文件和历史记录保留。');
  } catch (error) { $('project-delete-error').textContent = errorMessage(error); $('project-delete-error').hidden = false; }
  finally { projectDeleteBusy = false; for (const button of $('project-delete-dialog').querySelectorAll('button, input')) button.disabled = false; }
};
$('project-delete-dialog').addEventListener('cancel', (event) => { if (projectDeleteBusy) event.preventDefault(); });
$('project-delete-dialog').addEventListener('close', () => { pendingProjectDelete = null; });
$('new-project-name').addEventListener('input', () => {
  const input = $('new-project-name');
  input.setCustomValidity(/[()\uFF08\uFF09]/u.test(input.value) ? translate('Project names cannot contain parentheses.') : '');
});
$('project-form').onsubmit = action(async (event) => {
  event.preventDefault();
  const project = await window.relay.addProject({ name: $('new-project-name').value, path: $('new-project-path').value, localPath: $('new-project-local-path').value });
  selectedProject = project.id;
  $('project-dialog').close(); $('project-form').reset(); showSession(null);
});
$('new-session').onclick = action(async () => {
  const scope = modelScope();
  if (!scope.session && modelDrafts.has(scope.key)) {
    const saved = await window.relay.setAssistantDefaults(scope.provider, modelDrafts.get(scope.key));
    workspace.assistantDefaults ||= {};
    workspace.assistantDefaults[scope.provider] = saved;
    modelDrafts.delete(scope.key);
  }
  const session = await window.relay.addSession(selectedProject, $('new-provider').value);
  await activateSession(session.id);
});
$('new-provider').onchange = () => { renderModels(); renderUsage(); };
$('usage-refresh').onclick = action(async () => { renderStatus(await window.relay.refreshUsage(usageProvider())); });
$('usage-toggle').onclick = () => {
  usageCollapsed = !usageCollapsed;
  try { localStorage.setItem('relayDesk.usageCollapsed', String(usageCollapsed)); } catch {}
  renderUsageVisibility();
};
$('model-select').onchange = () => {
  const scope = modelScope();
  const draft = { ...(modelDrafts.get(scope.key) || scope.saved), model: $('model-select').value };
  const model = status.catalog?.[scope.provider]?.models.find((entry) => entry.id === draft.model);
  if (!model?.efforts.includes(draft.effort)) draft.effort = '';
  modelDrafts.set(scope.key, draft); renderModels();
};
$('effort-select').onchange = () => {
  const scope = modelScope();
  modelDrafts.set(scope.key, { ...(modelDrafts.get(scope.key) || scope.saved), effort: $('effort-select').value });
  renderModels();
};
$('apply-model').onclick = action(async () => {
  const scope = modelScope();
  if (scope.session) return;
  const settings = { ...(modelDrafts.get(scope.key) || scope.saved) };
  const saved = await window.relay.setAssistantDefaults(scope.provider, settings);
  workspace.assistantDefaults ||= {};
  workspace.assistantDefaults[scope.provider] = saved;
  modelDrafts.delete(scope.key); renderModels();
  notice('已保存，之后新建的该助手对话将使用这些设置。');
});
$('rename-session').onclick = () => { $('rename-value').value = workspace.sessions.find((entry) => entry.id === selectedSession)?.name || ''; $('rename-dialog').showModal(); };
$('history-toggle').onclick = () => setHistoryVisible(!historyVisible);
$('history-search-toggle').onclick = () => { if ($('history-search').hidden) openHistorySearch(); else closeHistorySearch(); };
$('history-search-close').onclick = () => { closeHistorySearch(); $('history-messages').focus({ preventScroll: true }); };
$('history-search-input').addEventListener('input', (event) => {
  clearTimeout(historySearchTimer);
  if (!event.isComposing) historySearchTimer = setTimeout(() => refreshHistorySearch(true), 120);
});
$('history-search-input').addEventListener('compositionstart', () => { clearTimeout(historySearchTimer); historySearchTimer = null; });
$('history-search-input').addEventListener('compositionend', () => { clearTimeout(historySearchTimer); historySearchTimer = setTimeout(() => refreshHistorySearch(true), 120); });
$('history-search-input').addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') { event.preventDefault(); moveHistorySearch(event.shiftKey ? -1 : 1); }
});
$('history-search-previous').onclick = () => moveHistorySearch(-1);
$('history-search-next').onclick = () => moveHistorySearch(1);
document.addEventListener('keydown', (event) => {
  if (event.isComposing || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && selectedSession) {
    event.preventDefault(); event.stopImmediatePropagation(); openHistorySearch();
  } else if (event.key === 'Escape' && !$('history-search').hidden) {
    event.preventDefault(); event.stopImmediatePropagation(); closeHistorySearch(); $('history-messages').focus({ preventScroll: true });
  }
}, true);
$('history-refresh').onclick = action(() => loadHistory(selectedSession));
$('rename-form').onsubmit = action(async (event) => { event.preventDefault(); await window.relay.renameSession(selectedSession, $('rename-value').value); $('rename-dialog').close(); });
$('connection-form').onsubmit = action(async (event) => { event.preventDefault(); const passphrase = $('passphrase').value; $('passphrase').value = ''; $('connection-dialog').close(); await connect(passphrase); });
for (const popup of document.querySelectorAll('dialog')) {
  const heading=popup.querySelector('h2');if(!heading)continue;
  const header=document.createElement('header');header.className='dialog-titlebar';heading.before(header);header.append(heading);
  const close=document.createElement('button');close.type='button';close.className='dialog-dismiss';close.title='关闭';close.setAttribute('aria-label','关闭');close.textContent='×';
  close.onclick=()=>{if(popup.dispatchEvent(new Event('cancel',{cancelable:true})))popup.close();};header.append(close);
}
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
$('send').onclick = action(send);
$('send-history').onclick = action(async () => {
  const id = selectedSession;
  if (!id) return;
  $('send-history-dialog').dataset.sessionId = id;
  renderOutgoingRecords(await refreshOutgoing(id));
  $('send-history-dialog').showModal();
});
function renderOutgoingRecords(records) {
  const list = $('send-history-list'); list.replaceChildren();
  if (!records.length) { const empty = document.createElement('p'); empty.textContent = '尚无本机发送备份。新消息会在发送前保存。'; list.append(empty); return; }
  for (const record of [...records].reverse()) {
    const article = document.createElement('article'); article.className = `outgoing-record${['submitted', 'accepted'].includes(record.status) ? '' : ' pending'}`;
    const heading = document.createElement('header'); heading.textContent = `${deliveryLabels[record.status] || '本机备份'} · ${new Date(record.createdAt).toLocaleString('zh-CN')}`;
    const text = document.createElement('pre'); text.textContent = record.text || '（仅附件消息）';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'quiet'; copy.textContent = '复制文字'; copy.disabled = !record.text;
    copy.onclick = action(async () => { await window.relay.copyText(record.text); notice('已复制本机备份文字。'); });
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'quiet'; restore.textContent = '恢复到输入框'; restore.disabled = !record.text;
    restore.onclick = action(() => restoreMessage(record));
    article.append(heading, text);
    if (record.attachments?.length) { const files = document.createElement('small'); files.textContent = '原附件：' + record.attachments.map((item) => item.name || '剪贴板图片').join('、'); article.append(files); }
    article.append(copy, restore); list.append(article);
  }
}
$('send-history-refresh').onclick = action(async () => {
  const id = $('send-history-dialog').dataset.sessionId;
  $('send-history-refresh').disabled = true;
  try { renderOutgoingRecords(await refreshOutgoing(id, true)); }
  finally { $('send-history-refresh').disabled = false; }
});
$('composer-expand').onclick = () => setComposerExpanded(!composerExpanded);
$('pick-files').onclick = action(async () => {
  const sessionId = selectedSession;
  if (sessionId) addStagedFiles(sessionId, await window.relay.pickLocalFiles(sessionId));
});
async function pasteClipboardImage() {
  if (sending || stagingImage) return;
  const sessionId = selectedSession;
  if (!sessionId) { notice('请先选择一个对话，再粘贴图片。'); return; }
  stagingImage = true; updateSessionState();
  try {
    const image = await window.relay.pasteClipboardImage(sessionId);
    const current = stagedBySession.get(sessionId) || [];
    stagedBySession.set(sessionId, [...current, image]);
    if (selectedSession === sessionId) renderStagedFiles();
    notice(`已添加图片（${image.width}×${image.height}，${image.format}，${(image.sizeBytes / 1048576).toFixed(2)} MiB）。点击发送后才上传压缩副本。`);
  } finally { stagingImage = false; updateSessionState(); }
}
$('paste-image').onclick = action(pasteClipboardImage);
$('prompt').addEventListener('paste', (event) => {
  const hasImage = Array.from(event.clipboardData?.items || []).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
  if (!hasImage) return;
  event.preventDefault();
  action(pasteClipboardImage)();
});
$('prompt').oninput = () => { if (selectedSession) saveDraft(selectedSession, $('prompt').value); };
$('prompt').onkeydown = action(async (event) => {
  if (event.key === 'Escape' && composerExpanded && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    setComposerExpanded(false);
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) await send();
});
let dragDepth = 0;
const hasDraggedFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files') || Array.from(event.dataTransfer?.items || []).some((item) => item.kind === 'file');
window.addEventListener('dragenter', (event) => { if (hasDraggedFiles(event)) { event.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; } }, true);
window.addEventListener('dragover', (event) => { if (hasDraggedFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }, true);
window.addEventListener('dragleave', (event) => { if (hasDraggedFiles(event)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; } }, true);
window.relay.onDroppedFiles(action(async (paths) => {
  dragDepth = 0; $('drop-overlay').hidden = true;
  if (sending || stagingImage) { notice('请等待当前操作完成后，再添加文件。'); return; }
  if (!selectedSession) { notice('请先新建或选择一个对话，然后拖入文件。'); return; }
  if (!paths.length) { notice('无法读取拖入文件的本机路径，请改用“添加本机文件”。'); return; }
  const sessionId = selectedSession;
  addStagedFiles(sessionId, await window.relay.stageDroppedFiles(sessionId, paths));
}));
$('stop-task').onclick = action(async () => {
  const id = selectedSession;
  await window.relay.input(id, '\x03');
  const entry = terminals.get(id);
  if (entry) entry.taskRunning = false;
});
$('mcp-reconnect').onclick = () => {
  const entry = terminals.get(selectedSession);
  if (!entry?.connected || workspace.sessions.find((session) => session.id === selectedSession)?.provider !== 'claude') return;
  entry.mcpReconnectRequested = { automatic: false };
  notice('已排队重连 Windows-MCP；待 Claude 空闲且终端输入框为空时执行。');
  attemptMcpReconnect(selectedSession, entry).catch((error) => notice(errorMessage(error)));
  updateSessionState();
};
$('copy-selection').onpointerdown = () => { pendingSelection = terminals.get(selectedSession)?.terminal.getSelection() || ''; };
$('copy-selection').onclick = action(() => { const captured = pendingSelection; pendingSelection = ''; return copyTerminalSelection(selectedSession, captured); });
$('end-session').onclick = action(async () => {
  const id = selectedSession;
  const entry = terminals.get(id);
  if (!entry || entry.opening || entry.ending || sending) return;
  if (!entry.connected) { await activateSession(id, { connectSession: true }); return; }
  entry.connectionRequested = false;
  entry.ending = true; updateSessionState();
  try {
    await window.relay.endSession(id);
    entry.connected = false; entry.promptReady = false; entry.taskRunning = false;
    if (selectedSession === id) { setHistoryVisible(true); await loadHistory(id); }
  } finally { entry.ending = false; updateSessionState(); }
});
for (const button of document.querySelectorAll('[data-key]')) button.onclick = action(() => window.relay.input(selectedSession, JSON.parse('"' + button.dataset.key + '"')));
$('log-toggle').onclick = () => { $('activity').hidden = !$('activity').hidden; fitCurrent(); };
$('close-activity').onclick = () => { $('activity').hidden = true; fitCurrent(); };
$('service-logs').onclick = action(() => window.relay.showLogs());
new ResizeObserver(() => fitCurrent()).observe($('terminal-host'));
window.relay.on('workspace', (value) => {
  workspace = value;
  const ids = new Set(value.sessions.map((session) => session.id));
  for (const [id, entry] of terminals) if (!ids.has(id)) {
    entry.launchEpoch++; entry.connected = false; entry.terminal.dispose(); entry.element.remove(); terminals.delete(id); drafts.delete(id); stagedBySession.delete(id);
  }
  if (selectedSession && !ids.has(selectedSession)) selectedSession = null;
  if (!value.projects.some((project) => project.id === selectedProject)) { selectedProject = value.projects[0]?.id || null; showSession(null); }
  else renderWorkspace();
});
window.relay.on('status', renderStatus);
window.relay.on('monitor', (value) => { status.monitor = value; renderSessionIndicators(); renderUsage(); });
window.relay.on('session-connections', (value) => { status.sessionConnections = value; renderSessionIndicators(); });
window.relay.on('keep-awake', renderKeepAwake);
window.relay.on('log', addActivity);
window.relay.on('data', ({ id, data }) => {
  const entry = terminals.get(id);
  if (!entry) return;
  if (workspace.sessions.find((session) => session.id === id)?.provider === 'claude') {
    entry.mcpFailureTail = ((entry.mcpFailureTail || '') + data).slice(-8000);
    if (window.relayMcpRecovery.windowsMcpFailed(entry.mcpFailureTail)) {
      entry.mcpFailureTail = '';
      if (entry.mcpRepairing) entry.mcpRepairFailure = true;
      else if (!entry.mcpReconnectRequested) {
        entry.mcpReconnectRequested = { automatic: true };
        if (selectedSession === id) notice('检测到 Windows-MCP 断线；待 Claude 空闲且终端输入为空后自动重连。');
        updateSessionState();
      }
    }
  }
  const epoch = entry.launchEpoch;
  entry.pendingWrites++;
  entry.terminal.write(data, () => {
    if (entry.launchEpoch !== epoch) return;
    entry.pendingWrites--;
    entry.launchOutput = true;
    entry.lastOutputAt = Date.now();
    if (selectedSession === id && entry.automaticHistory) setHistoryVisible(false, true);
    if (selectedSession === id) scheduleReadCheck();
  });
});
window.relay.on('ended', ({ id }) => { const entry = terminals.get(id); if (entry) { if (entry.opening) entry.endedDuringOpen = true; entry.connected = false; entry.promptReady = false; entry.taskRunning = false; entry.terminal.write('\r\n[连接已断开。点击“建立连接”以继续。]\r\n'); } updateSessionState(); });
window.relay.on('completed', ({ id }) => { const entry = terminals.get(id); if (entry) entry.taskRunning = false; if (selectedSession === id) loadHistory(id, { background: true, restore: entry?.historyVisible === undefined }); });
window.relay.on('unread', (value) => { unreadSessions = new Map(Object.entries(value.counts || {})); unreadRevisions = new Map(Object.entries(value.revisions || {})); renderWorkspace(); scheduleReadCheck(); });
$('history-messages').addEventListener('scroll', scheduleReadCheck, { passive: true });
const preserveHistoryReadingPosition = () => { historyBottomTarget = null; historyScrollIntent++; };
for (const event of ['wheel', 'touchmove', 'pointerdown']) $('history-messages').addEventListener(event, preserveHistoryReadingPosition, { passive: true });
$('history-messages').addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) preserveHistoryReadingPosition();
});
window.addEventListener('focus', scheduleReadCheck);
document.addEventListener('visibilitychange', scheduleReadCheck);

const historyPoll = setInterval(() => {
  if (selectedSession && status.ssh === 'ready' && !historyLoadingId) loadHistory(selectedSession, { background: true, restore: terminals.get(selectedSession)?.historyVisible === undefined });
}, 10000);
const mcpRecoveryPoll = setInterval(() => {
  for (const [id, entry] of terminals) {
    if (entry.connected && entry.mcpReconnectRequested) attemptMcpReconnect(id, entry).catch((error) => { if (selectedSession === id) notice(errorMessage(error)); });
  }
}, 2000);
window.addEventListener('beforeunload', () => { clearInterval(historyPoll); clearInterval(mcpRecoveryPoll); });
renderServicesVisibility();
renderUsageVisibility();
action(async () => {
  const initial = await window.relay.snapshot();
  workspace = initial.workspace;
  for (const session of workspace.sessions) {
    try {
      const saved = localStorage.getItem(`relayDesk.draft.${session.id}`); if (saved !== null) drafts.set(session.id, saved);
      const attempt = localStorage.getItem(`relayDesk.draftAttempt.${session.id}`); if (attempt) draftAttempts.set(session.id, attempt);
    } catch {}
  }
  unreadSessions = new Map(Object.entries(initial.unread || {}));
  unreadRevisions = new Map(Object.entries(initial.unreadRevisions || {}));
  selectedProject = workspace.projects[0]?.id;
  let previousSession = '';
  try { previousSession = localStorage.getItem('relayDesk.selectedSession') || ''; } catch {}
  const previous = workspace.sessions.find((session) => session.id === previousSession);
  if (previous) {
    selectedProject = previous.projectId;
    await activateSession(previous.id);
  }
  renderWorkspace(); renderStatus(initial.status); renderKeepAwake(initial.keepAwake);
  for (const text of initial.status.logs || []) addActivity(text);
})();
