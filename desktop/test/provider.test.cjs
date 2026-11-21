const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Backend } = require('../backend.cjs');

const id = '11111111-2222-4333-8444-555555555555';

test('provider routing keeps Codex and existing Claude sessions separate', async () => {
  const backend = new Backend('/tmp/relay-provider-test');
  backend.status.tunnel = 'ready';
  backend.remoteDir = '/home/user/windows-mcp';
  const commands = [];
  backend.client = {
    exec(command, options, callback) {
      commands.push(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      callback(null, stream);
    }
  };
  await backend.openSession({ id, projectPath: '~/work', provider: 'codex' }, 1, {});
  assert.match(commands.pop(), /'codex'$/);
  await backend.openSession({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', projectPath: '~/work' }, 1, {});
  assert.match(commands.pop(), /'claude'$/);
  backend.exec = async (command) => { commands.push(command); };
  await backend.endSession(id, 1, 'codex');
  assert.match(commands.pop(), /attach-desktop-session\.sh' --end '11111111-2222-4333-8444-555555555555' 'codex'$/);
  assert.equal(backend.channels.has(id), false);
  await backend.openSession({ id, projectPath: '~/work', provider: 'codex' }, 1, {});
  assert.match(commands.pop(), /attach-desktop-session\.sh/);
  await assert.rejects(backend.endSession(id, 1, 'other'), /Invalid assistant provider/);
});

test('remote terminal output is batched without changing byte order', async () => {
  const backend = new Backend('/tmp/relay-output-test');
  backend.status.tunnel = 'ready';
  backend.remoteDir = '/home/user/windows-mcp';
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {};
  backend.client = { exec(_command, _options, callback) { callback(null, stream); } };
  const received = [];
  backend.on('data', (value) => received.push(value.data));
  await backend.openSession({ id, projectPath: '~/work', provider: 'claude' }, 1, {});
  stream.emit('data', Buffer.from('first'));
  stream.emit('data', Buffer.from(' second'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  stream.emit('data', Buffer.from(' third'));
  stream.emit('close');
  assert.deepEqual(received, ['first second', ' third']);
  clearInterval(backend.healthTimer);
  clearInterval(backend.completionTimer);
});
