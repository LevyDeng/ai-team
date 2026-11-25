const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CliUpdates } = require('../workbench/cli-updates.cjs');
const { hasUpdate } = require('../workbench/cli-release.cjs');
const { replacePackage } = require('../workbench/managed-npm.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-updates-test-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const calls = [];
  const state = { locations: [{ id: 'managed', managed: true }], roles: [], settings: {} };
  const store = { state, save: t.mock.fn() };
  const local = {};
  const versions = {};
  const blockers = {};
  const broken = new Set();
  for (const engine of ['codex', 'antigravity', 'kimi', 'codebuddy']) {
    const executable = path.join(dir, engine);
    fs.writeFileSync(executable, engine);
    versions[engine] = '1.9.0';
    local[engine] = {
      managed: () => executable,
      installed: () => versions[engine],
      latest: async () => { calls.push('check:' + engine); return '1.10.0'; },
      install: async ({ expected }) => {
        calls.push('install:' + engine);
        assert.equal(expected, '1.10.0');
        if (broken.has(engine)) throw new Error('Fixture install failure');
        versions[engine] = expected;
        return { executable, version: expected };
      },
    };
  }
  const remote = {
    snapshot: () => ({ enabled: true, available: true, installed: '2.1.0', latest: '2.2.0' }),
    async request(action) { calls.push('remote:' + action); return { state: 'running' }; },
  };
  const dependencies = {
    store, file: path.join(dir, 'cache.json'), local, remote, changed: () => {},
    resolveExecutable: role => role.executable || local[role.engine]?.managed() || '',
    busyRoles: engine => blockers[engine] || [], fetchLocal: async () => fetch, npmEnvironment: async () => ({}),
  };
  const add = (engine, extra = {}) => state.roles.push({ engine, locationId: 'local', ...extra });
  return { updates: new CliUpdates(dependencies), dependencies, calls, dir, state, store, versions, blockers, broken, add };
}

test('Release comparisons account for numeric segments, prereleases and downgrades', () => {
  assert.equal(hasUpdate('1.9.0', '1.10.0'), true);
  assert.equal(hasUpdate('1.10.0-beta.1', '1.10.0'), true);
  assert.equal(hasUpdate('1.10.1', '1.10.0'), false);
  assert.equal(hasUpdate('1.10.0', '1.10.0'), false);
  assert.equal(hasUpdate('1.9.0', '1.10.0-beta.1'), false);
  assert.equal(hasUpdate('', '1.10.0'), false);
});

test('Startup checks only enabled local roles using the managed runtime and reuses a valid cache across launches', async t => {
  const f = fixture(t);
  f.add('codex');
  f.add('codex', { executable: f.dependencies.local.codex.managed() });
  f.add('kimi', { enabled: false });
  f.add('codebuddy', { executable: path.join(f.dir, 'external') });
  f.add('antigravity', { locationId: 'managed' });
  f.add('claude', { locationId: 'managed' });
  await f.updates.startup();
  assert.deepEqual(f.calls, ['check:codex']);
  const reopened = new CliUpdates(f.dependencies);
  await reopened.startup();
  assert.deepEqual(f.calls, ['check:codex']);
  assert.equal(reopened.snapshot().count, 2);
  assert.equal(reopened.snapshot().rows.find(row => row.engine === 'codex').usingManaged, 2);
  fs.appendFileSync(f.dependencies.local.codex.managed(), 'changed');
  await reopened.startup();
  assert.deepEqual(f.calls, ['check:codex', 'check:codex']);
});

test('Disabling startup or reminders is independent and still allows a manual check', async t => {
  const f = fixture(t);
  f.add('codex');
  f.updates.savePreference('autoCheck', false);
  assert.deepEqual(f.updates.preferences(), { autoCheck: false, reminders: true });
  await f.updates.startup();
  assert.deepEqual(f.calls, []);
  f.updates.savePreference('reminders', false);
  assert.deepEqual(new CliUpdates(f.dependencies).preferences(), { autoCheck: false, reminders: false });
  await f.updates.runBatch('check');
  assert.deepEqual(f.calls, ['check:codex']);
  assert.equal(f.updates.snapshot().count, 1);
  assert.equal(f.store.save.mock.callCount(), 2);
});

test('Batch update skips busy engines, proceeds after failure, and reports server work as started', async t => {
  const f = fixture(t);
  for (const engine of ['codex', 'kimi', 'codebuddy']) f.add(engine);
  f.add('claude', { locationId: 'managed' });
  await f.updates.startup();
  f.calls.length = 0;
  f.blockers.codex = ['Busy Codex'];
  f.broken.add('kimi');
  t.mock.method(console, 'warn', () => {});
  await f.updates.runBatch('install');
  assert.deepEqual(f.calls, ['install:kimi', 'install:codebuddy', 'remote:update']);
  assert.deepEqual(f.updates.snapshot().batchResult, { operation: 'install', checked: 0, installed: 1, started: 1, failed: 1, skipped: 1 });
  assert.equal(f.versions.codebuddy, '1.10.0');
  assert.equal(f.updates.snapshot().rows.find(row => row.engine === 'kimi').status, 'install_failed');
});

test('A newly enabled role and a manual install share version checks and installation locks', async t => {
  const f = fixture(t);
  f.add('codex', { enabled: false });
  await f.updates.startup();
  f.state.roles[0].enabled = true;
  const first = f.updates.check('codex');
  assert.deepEqual(await f.updates.install('codex'), { status: 'skipped' });
  assert.equal(await first, 'checked');
  const install = f.updates.install('codex');
  assert.equal(f.updates.isInstalling(f.state.roles[0]), true);
  assert.equal(await f.updates.check('codex'), 'skipped');
  assert.equal((await install).status, 'installed');
  assert.equal(f.updates.snapshot().count, 0);
});

test('The managed npm installer preserves the old version on failed verification and publication', async t => {
  const f = fixture(t);
  const target = path.join(f.dir, 'runtime');
  const executable = path.join(target, 'cli.exe');
  fs.mkdirSync(target);
  fs.writeFileSync(executable, 'Previous version');
  const options = {
    target, name: 'fixture-cli', version: '1.10.0',
    verify: staging => path.join(staging, 'cli.exe'),
  };
  const install = async ({ directory, pkg }) => {
    assert.equal(pkg, 'fixture-cli@1.10.0');
    fs.writeFileSync(path.join(directory, 'cli.exe'), 'New version');
    assert.equal(fs.readFileSync(executable, 'utf8'), 'Previous version');
  };
  await assert.rejects(replacePackage({ ...options, verify() { throw new Error('Verification failed'); } }, install), /Verification failed/);
  await assert.rejects(replacePackage({ ...options, publish() { throw new Error('Publication failed'); } }, install), /Publication failed/);
  assert.equal(fs.readFileSync(executable, 'utf8'), 'Previous version');
  assert.equal(await replacePackage(options, install), executable);
  assert.equal(fs.readFileSync(executable, 'utf8'), 'New version');
  assert.deepEqual(fs.readdirSync(f.dir).filter(name => name.startsWith('runtime')), ['runtime']);
});
