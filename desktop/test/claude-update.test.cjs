const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, ClaudeUpdater } = require('../workbench/claude-update.cjs');
test('Updater exposes only validated version metadata to the renderer', () => {
  const result = normalize({ state: 'complete', phase: 'complete', installed: '2.1.325', latest: '2.1.325',
    canRollback: true, token: 'fixture-secret', logs: ['private'], preparedVersion: 'not-a-version' });
  assert.equal(result.installed, '2.1.325'); assert.equal(result.preparedVersion, '');
  assert.equal(result.canRollback, true); assert(!JSON.stringify(result).includes('fixture-secret'));
  assert.throws(() => normalize({ state: 'unexpected' }), /Unexpected updater/);
});
test('Opening the updater does not connect, and explicit checks do not start an update', async () => {
  let connections = 0; const calls = [];
  const store = { state: { locations: [{ id: 'managed', managed: true }] } };
  const updater = new ClaudeUpdater('', store, {}, { connect: async () => { connections++; } }, () => {});
  updater.upload = async () => {};
  updater.call = async action => { calls.push(action); return { state: 'idle', installed: '2.1.308', latest: '2.1.325', available: true }; };
  assert.equal(connections, 0); assert.equal(updater.snapshot().enabled, true);
  const status = await updater.request('check');
  assert.equal(connections, 1); assert.deepEqual(calls, ['check']); assert(status.available); assert.equal(updater.busy, false);
  updater.close();
});
test('Concurrent update clicks are rejected and a failed check releases the operation', async () => {
  let release;
  const updater = new ClaudeUpdater('', { state: { locations: [{ id: 'managed', managed: true }] } }, {},
    { connect: () => new Promise(resolve => { release = resolve; }) }, () => {});
  updater.upload = async () => {};
  updater.call = async () => { throw new Error('fixture connection failure'); };
  const pending = updater.request('check');
  await assert.rejects(updater.request('update'), /already in progress/);
  release(); await assert.rejects(pending, /fixture connection failure/);
  assert.equal(updater.busy, false); updater.close();
});
