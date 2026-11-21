const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Backend } = require('../backend.cjs');

const script = path.resolve(__dirname, '../../server/read-session-history.py');
const id = '11111111-2222-3333-4444-555555555555';

test('session history shows conversation text but omits tool and thinking data', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-history-'));
  t.after(() => {
    if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected temporary history path.');
    fs.rmSync(home, { recursive: true, force: true });
  });
  const claudeDir = path.join(home, 'windows-mcp', 'claude', 'projects', '-workspace');
  fs.mkdirSync(claudeDir, { recursive: true });
  const rows = [
    { type: 'user', message: { role: 'user', content: 'User question' } },
    { type: 'assistant', uuid: 'finished-1', message: { role: 'assistant', id: 'one', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'text', text: 'Helpful answer' }, { type: 'tool_use', name: 'Read', input: { secret: 'tool data' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'private tool output' }] } },
    { type: 'assistant', uuid: 'empty-frame', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
  ];
  const historyFile = path.join(claudeDir, `${id}.jsonl`);
  fs.writeFileSync(historyFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const run = (extra = []) => spawnSync('python', [script, 'claude', id, ...extra], { env: { ...process.env, XDG_STATE_HOME: home }, encoding: 'utf8' });
  const full = run();
  assert.equal(full.status, 0, full.stderr);
  const result = JSON.parse(full.stdout);
  // NTFS inode IDs can exceed JavaScript's exact integer range.
  const exactInode = (output) => /"inode":\s*(\d+)/.exec(output)[1];
  const firstInode = exactInode(full.stdout);
  assert.deepEqual(result.messages, [{ role: 'user', text: 'User question' }, { role: 'assistant', text: 'Helpful answer' }]);
  assert.equal(result.completion, 'finished-1');
  assert.equal(result.cursor.offset, fs.statSync(historyFile).size);
  assert.doesNotMatch(full.stdout, /private thought|private tool output|tool data/);
  const status = run(['--status']);
  assert.equal(JSON.parse(status.stdout).completion, 'finished-1');
  fs.appendFileSync(historyFile, JSON.stringify({ type: 'assistant', uuid: 'finished-2', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'New answer' }] } }) + '\n');
  const deltaOutput = run(['--since', String(result.cursor.offset), firstInode]).stdout;
  const delta = JSON.parse(deltaOutput);
  assert.deepEqual(delta.messages, [{ role: 'assistant', text: 'New answer' }]);
  assert.equal(delta.completion, 'finished-2');
  assert.equal(delta.reset, false);
  assert.equal(JSON.parse(run(['--status', '--since', String(result.cursor.offset), firstInode]).stdout).completion, 'finished-2');
  fs.writeFileSync(historyFile, JSON.stringify(rows[0]) + '\n');
  const replaced = JSON.parse(run(['--since', String(delta.cursor.offset), exactInode(deltaOutput)]).stdout);
  assert.equal(replaced.reset, true);
  assert.deepEqual(replaced.messages, [{ role: 'user', text: 'User question' }]);
});

test('a new completed turn emits one notification and an old turn emits none', async () => {
  const backend = new Backend(path.resolve(__dirname, '..'));
  backend.client = {};
  backend.status.ssh = 'ready';
  backend.status.tunnel = 'ready';
  backend.remoteDir = '/remote/windows-mcp';
  backend.setKnownSessions([{ id, provider: 'claude' }]);
  backend.channels.set(id, { provider: 'claude', owner: 4 });
  backend.completionTokens.set(id, 'old-turn');
  backend.exec = async () => JSON.stringify({ resources: { memoryTotal: 4096, updatedAt: Date.now() }, sessions: { [id]: { completion: 'new-turn', taskState: 'completed', taskSource: 'hook', taskUpdatedAt: Date.now(), remoteActive: true } } });
  const completed = [];
  backend.on('completed', (value) => completed.push(value));
  await backend.checkCompletions();
  await backend.checkCompletions();
  assert.deepEqual(completed, [{ id, owner: 4 }]);
  clearInterval(backend.healthTimer);
  clearInterval(backend.completionTimer);
});

test('empty incremental history keeps the completion baseline without replacing the status poll cursor', async () => {
  const backend = new Backend(path.resolve(__dirname, '..'));
  backend.client = {};
  backend.status.ssh = 'ready';
  backend.remoteDir = '/remote/windows-mcp';
  backend.exec = async () => JSON.stringify({ messages: [], completion: '', cursor: { offset: 120, inode: 7 } });
  const history = await backend.readHistory(id, 'claude', { offset: 120, inode: 7 }, 'already-complete');
  assert.equal(backend.completionTokens.get(id), 'already-complete');
  assert.deepEqual(history.cursor, { offset: 120, inode: 7 });
  assert.equal(backend.statusCursors.has(id), false);
  clearInterval(backend.healthTimer);
  clearInterval(backend.completionTimer);
});

test('completion polling resumes from its last remote file position', async () => {
  const backend = new Backend(path.resolve(__dirname, '..'));
  backend.client = {};
  backend.status.ssh = 'ready';
  backend.status.tunnel = 'ready';
  backend.remoteDir = '/remote/windows-mcp';
  backend.setKnownSessions([{ id, provider: 'claude' }]);
  backend.channels.set(id, { provider: 'claude', owner: 4 });
  const commands = [];
  backend.exec = async (command) => { commands.push(command); return JSON.stringify({ resources: { memoryTotal: 4096, updatedAt: Date.now() }, sessions: { [id]: { completion: 'turn-1', cursor: { offset: 250, inode: 9 }, taskState: 'completed', taskUpdatedAt: Date.now(), remoteActive: true } } }); };
  await backend.checkCompletions();
  await backend.checkCompletions();
  assert.match(commands[0], /read-system-status\.py/);
  assert.match(commands[0], /"cursor":null/);
  assert.match(commands[1], /"cursor":\{"offset":250,"inode":9\}/);
  clearInterval(backend.healthTimer);
  clearInterval(backend.completionTimer);
});

test('Codex rollout history reads messages and the finished turn marker', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-history-'));
  t.after(() => {
    if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected temporary history path.');
    fs.rmSync(home, { recursive: true, force: true });
  });
  const sessions = path.join(home, 'windows-mcp', 'codex', 'ui', id, 'sessions', '2026', '10', '26');
  fs.mkdirSync(sessions, { recursive: true });
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } },
    { type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'output_text', text: 'hidden' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ];
  fs.writeFileSync(path.join(sessions, 'rollout-test.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
  const run = spawnSync('python', [script, 'codex', id], { env: { ...process.env, XDG_STATE_HOME: home }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.messages, [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Done' }]);
  assert.equal(result.completion, 'turn-1');
  assert.doesNotMatch(run.stdout, /hidden/);
});
