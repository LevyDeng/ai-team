const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { follow, readRecord, requestStop, taskDirectory, createProgressWriter, clear } = require('../workbench/local-executor.cjs');
const { atomic } = require('../workbench/store.cjs');

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-executor-test-'));
  t.after(() => fs.rmSync(workspace, {recursive:true, force:true}));
  const task = {id:randomUUID(), createdAt:Date.now()};
  const directory = taskDirectory(workspace, task.id);
  fs.mkdirSync(directory, {recursive:true});
  const pid = 12345;
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  write('progress.json', {pid, sequence:1, at:task.createdAt});
  return {workspace, task, directory, pid, write};
}

test('A stalled worker is reclaimed after recording the cancellation request', async t => {
  const {workspace, task, directory, pid} = fixture(t);
  let attempts = 0;
  const result = await follow(workspace, task, AbortSignal.abort(), () => {}, {cancelMs:0, stopWorker:async (target, worker) => {
    attempts++;
    assert.equal(target, directory);
    assert.equal(worker, pid);
    assert.equal(readRecord(directory, 'cancel.json').requested, true);
    return true;
  }});
  assert.equal(attempts, 1);
  assert.deepEqual(result.result, {status:'cancelled', stopConfirmed:true, forced:true});
});

test('Cancellation persists across restart without claiming that an unverified worker stopped', async t => {
  const {workspace, task, write} = fixture(t);
  write('cancel.json', {requested:true, requestedAt:Date.now()-20000});
  await assert.rejects(follow(workspace, task, new AbortController().signal, () => {}, {stopWorker:async () => false}),
    {code:'LOCAL_EXECUTOR_STOP_UNCONFIRMED'});
});

test('A worker that acknowledges its own stop needs no recovery', async t => {
  const {workspace, task, pid, write} = fixture(t);
  const finished = {pid, sequence:2, at:Date.now(), finished:true, result:{status:'cancelled', stopConfirmed:true}};
  write('progress.json', finished);
  assert.deepEqual(await follow(workspace, task, AbortSignal.abort(), () => {}, {cancelMs:0, stopWorker:async () => assert.fail('Already stopped')}), finished);
});

test('Force upgrades a pending stop without waiting for the grace period', async t => {
  const {workspace, task, directory} = fixture(t);
  const original = requestStop(workspace, task.id);
  let forced = false;
  const result = await follow(workspace, task, AbortSignal.abort(), () => { forced = true; }, {
    force:() => forced,
    cancelMs:60_000,
    stopWorker:async () => {
      const request = readRecord(directory, 'cancel.json');
      assert.equal(request.force, true);
      assert.equal(request.requestedAt, original.requestedAt);
      return true;
    },
  });
  assert.equal(result.result.forced, true);
});

test('Reopening a forced stop reclaims the same worker even without a new abort', async t => {
  const {workspace, task, pid, directory} = fixture(t);
  requestStop(workspace, task.id, true);
  assert.equal(requestStop(workspace, task.id).force, true);
  const result = await follow(workspace, task, new AbortController().signal, () => {}, {
    cancelMs:60_000,
    stopWorker:async (target, worker) => target === directory && worker === pid,
  });
  assert.equal(result.result.stopConfirmed, true);
});

test('A failed progress rename leaves the worker running and a later heartbeat publishes the newest state', async t => {
  const {directory} = fixture(t);
  let locked = true;
  const save = createProgressWriter(directory, (file, record) => {
    if (locked) throw Object.assign(new Error('Sharing violation'), {code:'EPERM', syscall:'rename'});
    atomic(file, record);
  });
  assert.equal(save({sequence:2}), false);
  assert.equal(readRecord(directory, 'progress.json').sequence, 1);
  locked = false;
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(save({sequence:3}), true);
  assert.equal(readRecord(directory, 'progress.json').sequence, 3);
});

test('Final replies survive a locked progress file and can be collected after restart', async t => {
  const {workspace, task, directory, pid} = fixture(t);
  const save = createProgressWriter(directory, (file, record) => {
    if (path.basename(file) === 'progress.json') throw Object.assign(new Error('Sharing violation'), {code:'EPERM', syscall:'rename'});
    atomic(file, record);
  });
  const final = {pid, sequence:3, at:Date.now(), finished:true, messages:[{id:'answer', text:'Final answer'}], result:{status:'complete'}};
  assert.equal(save({sequence:2}), false);
  assert.equal(save(final), true);
  const seen = [];
  assert.deepEqual(await follow(workspace, task, new AbortController().signal, record => seen.push(record)), final);
  assert.deepEqual(seen, [final]);
  clear(workspace, task.id);
  assert.equal(fs.existsSync(directory), false);
});
