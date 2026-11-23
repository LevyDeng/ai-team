const fs = require('node:fs');
const path = require('node:path');
const { contextBridge } = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const avatarDir = path.join(repoRoot, 'desktop/assets/model-avatars');

function avatarDataUrl(file) {
  const buf = fs.readFileSync(path.join(avatarDir, file));
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

const now = Date.now();
const roles = [
  {
    id: 'role-arch',
    name: '架构师 · Claude',
    description: '方案探索、架构拆解与代码评审',
    persona: '负责模块边界、并发一致性与关键改动审核。',
    examples: '先确认数据模型和失败回滚，再开始写代码。',
    engine: 'claude',
    provider: 'native',
    locationId: 'local',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    permission: 'acceptEdits',
    executable: '',
    allowLocationTools: true,
    proxyMode: 'inherit',
    avatar: 0,
    avatarId: 'preset-claude',
    avatarUrl: avatarDataUrl('claude.jpg'),
    hasKey: false,
    available: true,
    enabled: true,
  },
  {
    id: 'role-be',
    name: '后端 · Codex',
    description: '后端实际执行、接口与单元测试',
    persona: '专注服务端实现、事务处理与边界单元测试。',
    examples: '',
    engine: 'codex',
    provider: 'native',
    locationId: 'local',
    model: 'gpt-5.4-codex',
    effort: 'high',
    permission: 'workspace-write',
    codexLoginSource: 'desktop',
    codexDesktopTools: true,
    executable: '',
    allowLocationTools: true,
    proxyMode: 'inherit',
    avatar: 1,
    avatarId: 'preset-gpt-sol',
    avatarUrl: avatarDataUrl('gpt-sol.jpg'),
    hasKey: false,
    available: true,
    enabled: true,
  },
  {
    id: 'role-fe',
    name: '前端 · Gemini',
    description: '前端界面、交互动效与视觉细节',
    persona: '负责页面布局、状态管理与深浅色主题适配。',
    examples: '',
    engine: 'antigravity',
    provider: 'native',
    locationId: 'local',
    model: 'gemini-3.5-pro',
    effort: 'medium',
    permission: 'workspace-write',
    executable: '',
    allowLocationTools: true,
    proxyMode: 'inherit',
    avatar: 2,
    avatarId: 'preset-gemini-neon',
    avatarUrl: avatarDataUrl('gemini-neon.jpg'),
    hasKey: false,
    available: true,
    enabled: true,
  },
  {
    id: 'role-review',
    name: '审稿 · Cursor',
    description: '代码审核、边界用例与回归检查',
    persona: '重点检查异常分支、并发竞态与文档同步。',
    examples: '',
    engine: 'cursor',
    provider: 'native',
    locationId: 'local',
    model: 'cursor-default',
    effort: '',
    permission: 'read-only',
    executable: '',
    allowLocationTools: true,
    proxyMode: 'inherit',
    avatar: 0,
    avatarId: 'preset-kimi',
    avatarUrl: avatarDataUrl('kimi.jpg'),
    hasKey: false,
    available: true,
    enabled: true,
  },
  {
    id: 'role-remote',
    name: '远程 · Claude',
    description: '运行在远程 Linux 服务器，可反向操作本机',
    persona: '运行在远程服务器环境，通过加密通道协助本机开发。',
    examples: '',
    engine: 'claude',
    provider: 'native',
    locationId: 'loc-server',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permission: 'acceptEdits',
    executable: '',
    allowLocationTools: true,
    proxyMode: 'inherit',
    avatar: 1,
    avatarId: 'preset-deepseek',
    avatarUrl: avatarDataUrl('deepseek.jpg'),
    hasKey: false,
    available: true,
    enabled: true,
  },
];

const locations = [
  { id: 'local', name: '本机', type: 'local', os: 'windows', control: 'ssh', proxy: { mode: 'system', url: '' } },
  { id: 'loc-server', name: '远程 Linux 服务器', type: 'ssh', os: 'linux', control: 'ssh', host: 'dev-server.example.com', username: 'dev', port: 22, keyPath: '', proxy: { mode: 'inherit', url: '' } },
];

const projects = [
  {
    id: 'proj-shop',
    name: '订单服务重构',
    roleIds: roles.map(r => r.id),
    allowGuestMentions: true,
    directories: [
      { locationId: 'local', path: 'D:\\workspace\\order-service' },
      { locationId: 'loc-server', path: '/srv/order-service' },
    ],
  },
  {
    id: 'proj-docs',
    name: '组件库文档站',
    roleIds: ['role-arch', 'role-fe'],
    allowGuestMentions: true,
    directories: [{ locationId: 'local', path: 'D:\\workspace\\ui-docs' }],
  },
];

const groupChat = {
  id: 'chat-group',
  projectId: 'proj-shop',
  name: '支付回调与重试方案',
  roleIds: ['role-arch', 'role-be', 'role-fe', 'role-review'],
  defaultReplyRoleIds: ['role-arch', 'role-be'],
  flow: 'relay',
  rounds: 3,
  autoStop: true,
  moderatorRoleId: 'role-arch',
  compressHistory: true,
  roleSettings: {},
  draft: '',
  unread: false,
  updatedAt: now - 30_000,
  inputQueue: [
    {
      id: 'q-1',
      createdAt: now - 10_000,
      value: {
        text: '@前端 · Gemini 接口字段定下来后，顺便把订单详情页的支付状态轮询提示也更新一下',
        roleIds: ['role-fe'],
        files: [],
      },
    },
  ],
  queuePaused: false,
  messages: [
    {
      id: 'm-1',
      kind: 'user',
      text: '@架构师 · Claude @后端 · Codex @审稿 · Cursor 支付回调偶发重复通知，先一起定个幂等和重试方案，然后直接落代码。',
      status: 'accepted',
      at: now - 240_000,
    },
    {
      id: 'm-2',
      kind: 'assistant',
      roleId: 'role-arch',
      roleName: '架构师 · Claude',
      locationId: 'local',
      model: 'claude-sonnet-4-6',
      status: 'complete',
      at: now - 205_000,
      nativeSessionStatus: 'reused',
      text: '建议拆成两层防重：\n1. **回调记录表**增加 `(provider, notify_id)` 唯一约束，重复通知直接返回 `200 OK`；\n2. **状态机更新**使用条件写 `WHERE status = "pending"`，保证并发下只扣减一次库存。',
    },
    {
      id: 'm-3',
      kind: 'assistant',
      roleId: 'role-be',
      roleName: '后端 · Codex',
      locationId: 'local',
      model: 'gpt-5.4-codex',
      status: 'complete',
      at: now - 140_000,
      nativeSessionStatus: 'reused',
      text: '已按方案完成改动并通过 18 项单元测试：\n- 新增迁移 `migrations/014_payment_notify_unique.sql`\n- 更新 `src/payment/callback.ts`，接入唯一键冲突捕获与事务状态流转\n- 补充并发双回调压测用例，库存扣减与状态变更均严格幂等。',
    },
    {
      id: 'm-4',
      kind: 'assistant',
      roleId: 'role-review',
      roleName: '审稿 · Cursor',
      locationId: 'local',
      model: 'cursor-default',
      status: 'complete',
      at: now - 85_000,
      nativeSessionStatus: 'created',
      text: '复核了 `callback.ts` 的异常分支：唯一键冲突返回 200 没问题，建议对**验签失败**的请求保持返回 `400` 且不写入幂等表，防止恶意重放占满记录。',
    },
  ],
};

const workflowChat = {
  id: 'chat-workflow',
  projectId: 'proj-shop',
  name: '订单超时自动关闭功能',
  roleIds: ['role-arch', 'role-be', 'role-fe', 'role-review'],
  defaultReplyRoleIds: ['role-arch', 'role-be', 'role-review'],
  flow: 'relay',
  rounds: 1,
  autoStop: true,
  moderatorRoleId: 'role-arch',
  roleSettings: {},
  draft: '',
  unread: false,
  updatedAt: now - 120_000,
  workflow: {
    type: 'generated',
    goal: '实现未支付订单 15 分钟自动关闭、库存回补，并补齐前端倒计时提示与单元测试',
    criteria: '1. 状态流转具备并发幂等保护；2. 单元测试全部通过；3. 前端倒计时归零后自动刷新状态。',
    status: 'complete',
    nodeIndex: 2,
    reworkCount: 0,
    reworkLimit: 2,
    reason: '全部 3 个步骤已通过验收标准。',
    nodes: [
      { id: 'n1', title: '探索超时关闭状态机与索引方案', domain: '架构', duty: '方案', mode: 'auto' },
      { id: 'n2', title: '实现定时扫描任务与库存回补', domain: '后端', duty: '执行', mode: 'auto' },
      { id: 'n3', title: '边界用例验收与代码审核', domain: '代码', duty: '审核', mode: 'auto', reworkTo: 2 },
    ],
    attempts: [
      {
        id: 'a1',
        nodeIndex: 0,
        roleId: 'role-arch',
        roleName: '架构师 · Claude',
        via: 'priority',
        priority: { domain: '架构', duty: '方案', tier: 1, weight: 10 },
        status: 'complete',
        selectionReason: '匹配第 1 档最高优先级',
      },
      {
        id: 'a2',
        nodeIndex: 1,
        roleId: 'role-be',
        roleName: '后端 · Codex',
        via: 'priority',
        priority: { domain: '后端', duty: '执行', tier: 1, weight: 10 },
        status: 'complete',
        selectionReason: '匹配第 1 档最高优先级',
      },
      {
        id: 'a3',
        nodeIndex: 2,
        roleId: 'role-review',
        roleName: '审稿 · Cursor',
        via: 'priority',
        priority: { domain: '代码', duty: '审核', tier: 1, weight: 8 },
        status: 'complete',
        selectionReason: '匹配第 1 档审核角色，验收通过',
      },
    ],
  },
  messages: [
    {
      id: 'wm-1',
      kind: 'assistant',
      roleId: 'role-arch',
      roleName: '架构师 · Claude',
      locationId: 'local',
      model: 'claude-sonnet-4-6',
      status: 'complete',
      workflowAttemptId: 'a1',
      at: now - 360_000,
      text: '步骤 1 完成：确定 `orders(status, expire_at)` 联合索引方案，采用批量游标扫描 + 乐观锁回补库存，避免长事务锁表。',
    },
    {
      id: 'wm-2',
      kind: 'assistant',
      roleId: 'role-be',
      roleName: '后端 · Codex',
      locationId: 'local',
      model: 'gpt-5.4-codex',
      status: 'complete',
      workflowAttemptId: 'a2',
      at: now - 250_000,
      text: '步骤 2 完成：实现 `OrderExpireWorker` 定时关闭任务，新增 12 项边界测试（并发支付与超时临界点全部通过）。',
    },
    {
      id: 'wm-3',
      kind: 'assistant',
      roleId: 'role-review',
      roleName: '审稿 · Cursor',
      locationId: 'local',
      model: 'cursor-default',
      status: 'complete',
      workflowAttemptId: 'a3',
      at: now - 150_000,
      text: '步骤 3 审核通过：幂等保护、事务回滚与前端倒计时联动均符合标准。\n\nVERDICT: PASS',
    },
  ],
};

const directChat = {
  id: 'chat-direct',
  projectId: 'proj-shop',
  name: '后端 · Codex',
  roleIds: ['role-be'],
  defaultReplyRoleIds: ['role-be'],
  flow: 'relay',
  rounds: 1,
  autoStop: true,
  roleSettings: {},
  draft: '',
  unread: false,
  updatedAt: now - 3600_000,
  messages: [],
};

const workflowPriorities = [
  {
    id: 'pr-1',
    domain: '架构',
    duty: '探索方案',
    candidates: [
      { roleId: 'role-arch', tier: 1, weight: 10 },
      { roleId: 'role-be', tier: 2, weight: 6 },
    ],
  },
  {
    id: 'pr-2',
    domain: '后端',
    duty: '实际执行',
    candidates: [
      { roleId: 'role-be', tier: 1, weight: 10 },
      { roleId: 'role-arch', tier: 2, weight: 5 },
    ],
  },
  {
    id: 'pr-3',
    domain: '前端',
    duty: '实际执行',
    candidates: [
      { roleId: 'role-fe', tier: 1, weight: 10 },
      { roleId: 'role-arch', tier: 2, weight: 4 },
    ],
  },
  {
    id: 'pr-4',
    domain: '代码',
    duty: '审核',
    candidates: [
      { roleId: 'role-review', tier: 1, weight: 8 },
      { roleId: 'role-arch', tier: 1, weight: 6 },
      { roleId: 'role-be', tier: 2, weight: 4 },
    ],
  },
];

const accountUsage = [
  {
    key: 'claude-local',
    engine: 'claude',
    provider: 'native',
    locationId: 'local',
    roleIds: ['role-arch'],
    state: 'ready',
    refreshable: true,
    updatedAt: now - 120_000,
    windows: [
      { label: '5h', windowMinutes: 300, usedPercent: 28, resetsAt: Math.floor((now + 3.2 * 3600_000) / 1000) },
      { label: '7d', windowMinutes: 10080, usedPercent: 41, resetsAt: Math.floor((now + 4.5 * 86400_000) / 1000) },
    ],
    balances: [],
  },
  {
    key: 'codex-desktop',
    engine: 'codex',
    provider: 'native',
    locationId: 'local',
    roleIds: ['role-be'],
    state: 'ready',
    refreshable: true,
    updatedAt: now - 90_000,
    windows: [
      { label: '5h', windowMinutes: 300, usedPercent: 18, resetsAt: Math.floor((now + 4.1 * 3600_000) / 1000) },
      { label: '7d', windowMinutes: 10080, usedPercent: 32, resetsAt: Math.floor((now + 5.1 * 86400_000) / 1000) },
    ],
    balances: [],
  },
  {
    key: 'antigravity-local',
    engine: 'antigravity',
    provider: 'native',
    locationId: 'local',
    roleIds: ['role-fe'],
    state: 'unsupported',
    nativeConsole: true,
    guide: true,
    refreshable: false,
    updatedAt: now - 300_000,
    windows: [],
    balances: [],
  },
  {
    key: 'cursor-local',
    engine: 'cursor',
    provider: 'native',
    locationId: 'local',
    roleIds: ['role-review'],
    state: 'unsupported',
    guide: true,
    refreshable: false,
    updatedAt: null,
    windows: [],
    balances: [],
  },
];

const skills = [
  { id: 'image', name: '生图', command: 'image', kind: 'image', description: '按文字描述生成配图并保存在本机输出目录', enabled: true },
  { id: 'review', name: '代码复核', command: 'review', kind: 'prompt', description: '按安全、并发与回归清单审查当前改动', enabled: true },
  { id: 'handoff', name: '任务转交', command: 'handoff', kind: 'prompt', description: '整理上下文并生成交接草稿发往其他会话', enabled: true },
];

const state = {
  version: 1,
  projects,
  roles,
  locations,
  chats: [groupChat, workflowChat, directChat],
  workflowPriorities,
  settings: { keepAwake: true, maxJobs: 3, theme: 'light' },
  connectionStatus: { local: 'ready', 'loc-server': 'idle' },
  running: {},
  inputBusy: { 'chat-group': false, 'chat-workflow': false, 'chat-direct': false },
  forceStops: {},
  mcp: { ssh: 'idle', mcp: 'idle', tunnel: 'idle', mcpOwned: false, tunnelOwned: false, forceControl: false },
  claudeUsage: { enabled: false },
  claudeUpdate: {},
  accountUsage,
  skills,
  skillSources: [],
  appVersion: '0.1.0',
  phoneLink: { connected: false },
};

const sampleCode = `// src/payment/callback.ts — 支付回调幂等处理
export async function handlePaymentNotify(req: NotifyPayload, db: Database) {
  if (!verifySignature(req)) {
    return { status: 400, body: { error: 'INVALID_SIGNATURE' } };
  }

  return db.transaction(async (tx) => {
    const inserted = await tx.insertIgnore('payment_notifies', {
      provider: req.provider,
      notify_id: req.notifyId,
      order_id: req.orderId,
    });
    if (!inserted) {
      // 重复回调直接幂等返回 200，避免重复扣减库存
      return { status: 200, body: { ok: true, deduplicated: true } };
    }

    const updated = await tx.execute(
      'UPDATE orders SET status = ? WHERE id = ? AND status = ?',
      ['paid', req.orderId, 'pending'],
    );
    return { status: 200, body: { ok: true, updated: updated.affectedRows } };
  });
}
`;

const listeners = new Map();
function emit(name, payload) {
  for (const fn of listeners.get(name) || []) fn(payload);
}

const api = {
  snapshot: async () => structuredClone(state),
  settings: async (patch) => {
    Object.assign(state.settings, patch);
    emit('state', structuredClone(state));
    return structuredClone(state);
  },
  read: async () => structuredClone(state),
  draft: async () => ({}),
  models: async () => ({
    models: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'gpt-5.4-codex', label: 'GPT-5.4 Codex' },
      { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
    ],
    updatedAt: now,
    cached: true,
  }),
  'agent-info': async () => ({ installed: true, version: '2.1.0', loggedIn: true }),
  'avatar-list': async () => [],
  'agent-terminals': async () => [],
  terminals: async () => [],
  'message-images': async () => ({ items: [], files: [] }),
  'voice-model-status': async () => ({ model: null, loading: null, operation: null }),
  'phone-addresses': async () => [],
  'account-usage': async () => structuredClone(state),
  'usage-refresh': async () => structuredClone(state),
  'chat-messages': async (targetChatId) => {
    const found = state.chats.find(c => c.id === targetChatId);
    return {
      messages: structuredClone(found?.messages || []),
      older: false,
      newer: false,
    };
  },
  'chat-runs': async () => [],
  'project-search': async () => [],
  'chat-search': async () => [],
  'message-details': async () => ({}),
  files: async (_projectId, _dirIdx, parts = [], operation = 'list') => {
    const joined = ['D:\\workspace\\order-service', ...parts].join('\\');
    if (operation === 'read') {
      return { path: joined, text: sampleCode, binary: false, truncated: false };
    }
    const listMap = {
      '': [
        { name: 'migrations', directory: true },
        { name: 'src', directory: true },
        { name: 'tests', directory: true },
        { name: 'package.json', directory: false },
        { name: 'README.md', directory: false },
      ],
      'src': [
        { name: 'payment', directory: true },
        { name: 'order-expire.ts', directory: false },
        { name: 'server.ts', directory: false },
      ],
      'src/payment': [
        { name: 'callback.ts', directory: false },
        { name: 'signature.ts', directory: false },
      ],
    };
    return { path: joined, entries: listMap[parts.join('/')] || listMap[''] };
  },
  on: (name, cb) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return () => listeners.get(name)?.delete(cb);
  },
  onFiles: () => {},
};

const noop = async () => structuredClone(state);
const allMethods = [
  'snapshot', 'role-save', 'role-enabled', 'avatar-list', 'avatar-upload', 'role-delete', 'role-login',
  'project-select', 'project-order', 'project-search', 'chat-messages', 'chat-search', 'message-details', 'chat-runs',
  'agent-info', 'agent-guide', 'agent-install', 'location-save', 'location-proxy-save', 'location-test',
  'location-delete', 'project-save', 'project-move', 'project-delete', 'chat-add', 'chat-save',
  'chat-role-settings', 'chat-flow', 'chat-discussion', 'chat-order', 'chat-delete', 'draft',
  'attachment-stage', 'attachment-remove', 'attachment-restore', 'read', 'send', 'pause', 'settings',
  'pick', 'copy', 'clipboard-text', 'image', 'open', 'files', 'file-explorer', 'terminals',
  'terminal-open', 'terminal-input', 'terminal-resize', 'terminal-close', 'models', 'cli-check',
  'cli-update', 'usage-refresh', 'account-usage', 'usage-guide', 'claude-cli',
  'queue-resume', 'queue-pause', 'queue-remove', 'queue-move', 'queue-now', 'queue-restore', 'force-stop',
  'agent-terminals', 'agent-terminal-open', 'agent-terminal-input', 'agent-terminal-resize',
  'agent-terminal-close', 'agent-terminal-screen',
  'skill-get', 'skill-save', 'skill-delete', 'skill-cancel', 'skill-models', 'skill-sources-save',
  'skill-system-enabled', 'message-images',
  'quota-action', 'quota-screen', 'quota-resize', 'quota-stop',
  'gemini-web-open', 'gemini-web-link', 'gemini-web-open-turn', 'gemini-web-clipboard-reply', 'gemini-web-reply',
  'chat-session-reset', 'chat-disband',
  'workflow-create', 'workflow-resume', 'workflow-teams', 'workflow-plan', 'workflow-plan-cancel',
  'workflow-generated-update', 'workflow-priority-save', 'workflow-template-save',
  'chat-branch', 'chat-handoff',
  'chat-voice-settings', 'chat-voice-toggle', 'chat-voice-speak', 'chat-voice-cancel',
  'voice-live-start', 'voice-live-stop', 'voice-live-frame', 'voice-live-played',
  'voice-model-status', 'voice-model-warmup', 'voice-model-release',
  'phone-addresses', 'phone-open', 'phone-close',
  'workbench-restart', 'workbench-quit', 'workbench-support',
];

const exposed = {};
for (const name of allMethods) exposed[name] = api[name] || noop;
exposed.on = api.on;
exposed.onFiles = api.onFiles;

contextBridge.exposeInMainWorld('desk', exposed);
