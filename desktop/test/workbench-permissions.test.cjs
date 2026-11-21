const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../workbench/store.cjs');
const { Agents, argumentsFor } = require('../workbench/agents.cjs');
const { startBridge } = require('../workbench/api/bridge.cjs');

test('Codex permission choices persist independently and reject unsupported modes', () => {
  const directory = fs.mkdtempSync(path.resolve(__dirname, '../../.runtime/permission-store-'));
  try {
    const store = new Store(directory, directory);
    const first = store.state.roles[0]; const other = store.state.roles[2];
    store.saveRole({ ...first, permission: 'danger-full-access' });
    const loaded = new Store(directory, directory);
    assert.equal(loaded.get('roles', first.id).permission, 'danger-full-access');
    assert.equal(loaded.get('roles', other.id).permission, 'workspace-write');
    const args = argumentsFor(loaded.get('roles', first.id));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
    assert.equal(args[args.indexOf('-a') + 1], 'never');
    assert.throws(() => store.saveRole({ ...first, permission: 'unsupported' }), /permission/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Real isolated Codex enforces read-only, workspace write and full-access file operations', { timeout: 180000 }, async t => {
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) await t.test(mode, { timeout: 55000 }, async () => {
    const directory = fs.mkdtempSync(path.resolve(__dirname, '../../.runtime/permission-cli-'));
    const workspace = path.join(directory, 'project'); const outside = path.join(directory, 'outside');
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    const target = path.join(mode === 'danger-full-access' ? outside : workspace, 'permission-marker.txt');
    const store = new Store(directory, directory); const project = store.state.projects[0];
    project.directories = [{ locationId: 'local', path: workspace }];
    const role = store.saveRole({ ...store.state.roles[0], provider: 'gemini', model: 'fixture-model', permission: mode, allowLocationTools: false });
    const chat = store.createChat({ projectId: project.id, roleIds: [role.id] });
    store.message(chat.id, { kind: 'user', text: 'Run the isolated permission fixture.', status: 'accepted' });
    const agents = new Agents(store, { get: () => 'fixture-key' }, {}, () => {});
    const prepare = agents.prepareLocal.bind(agents);
    agents.prepareLocal = async (...args) => {
      const result = await prepare(...args);
      result.extra.push('-c', 'features.plugins=false', '-c', 'features.remote_plugin=false');
      return result;
    };
    let requests = 0, toolReturned = false, permissionContext = '';
    agents.createBridge = options => startBridge({ ...options, onRequest: request => {
      const text = JSON.stringify([request.instructions, request.input]);
      permissionContext = [...text.matchAll(/.{0,50}(?:sandbox_mode|sandbox mode|sandbox is|read-only|danger-full-access|workspace-write).{0,120}/gi)].map(item => item[0]).join('\n');
    }, upstreamFetch: async (_url, init) => {
      assert(++requests <= 4);
      const body = JSON.parse(init.body);
      const tool = (body.tools || []).find(item => /(?:^|__)exec_command$/.test(item.function.name));
      assert(tool, 'The native command tool must be available.');
      toolReturned = body.messages.some(item => item.role === 'tool' && item.tool_call_id === 'permission_fixture');
      const delta = toolReturned ? { content: 'PERMISSION_FIXTURE_DONE' } : { tool_calls: [{ index: 0, id: 'permission_fixture', type: 'function', function: { name: tool.function.name,
        arguments: JSON.stringify({ cmd: "[System.IO.File]::WriteAllText('" + target.replaceAll("'", "''") + "','RELAY_PERMISSION_OK')", yield_time_ms: 10000, max_output_tokens: 300 }) } }] };
      return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: toolReturned ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
    } });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const result = await agents.run(chat.id, role, project, controller.signal);
      assert.equal(result.status, 'complete', result.note); assert(toolReturned);
      t.diagnostic(mode + ': ' + permissionContext);
      assert.equal(fs.existsSync(target), mode !== 'read-only', permissionContext);
      if (mode !== 'read-only') assert.equal(fs.readFileSync(target, 'utf8'), 'RELAY_PERMISSION_OK');
    } finally { clearTimeout(timer); agents.close(); try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch { t.diagnostic('The native sandbox retained temporary runtime files.'); } }
  });
});
