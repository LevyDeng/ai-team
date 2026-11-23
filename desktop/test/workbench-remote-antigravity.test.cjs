const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agents } = require('../workbench/agents.cjs');
const { ModelCatalogs } = require('../workbench/model-catalogs.cjs');
const { Store } = require('../workbench/store.cjs');
const { configure, authorizationUrl } = require('../workbench/remote-antigravity.cjs');

const executable = '/home/fixture/.local/bin/agy';
const vps = { id: 'fixture', type: 'ssh', os: 'linux', control: 'ssh', name: 'Fixture VPS' };
const proxy = { mode: 'direct' };

function remoteFixture(t, { installed = true, loggedIn = true, hang = false } = {}) {
  const starts = [], sessions = [], stops = [], commands = [];
  const client = {
    forwardIn(host, port, callback) { callback(null, 12345); },
    unforwardIn(host, port, callback) { callback(); },
    exec(command, callback) {
      assert.match(command, /^python3 /);
      const channel = new EventEmitter();
      channel.stderr = new EventEmitter();
      function reply(event) { channel.emit('data', Buffer.from(JSON.stringify(event) + '\n')); }
      channel.close = () => channel.emit('close');
      channel.write = line => queueMicrotask(() => {
        line = line.trim();
        if (['cancel', 'force'].includes(line)) {
          stops.push(line);
          channel.emit('exit', 130);
          return channel.emit('close', 130);
        }
        const request = JSON.parse(line);
        if (request.acp) return starts.push(request);
        if (request.method === 'initialize') return reply({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } } } });
        if (['session/new', 'session/resume'].includes(request.method)) {
          sessions.push(request);
          if (!loggedIn) return reply({ id: request.id, error: { code: -32000, message: 'Authentication required' } });
          return reply({ id: request.id, result: { sessionId: 'remote-session', models: { availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } } });
        }
        if (request.method === 'session/set_model') return reply({ id: request.id, result: {} });
        if (request.method === 'session/prompt') {
          reply({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Remote reply' } } } });
          if (!hang) reply({ id: request.id, result: { stopReason: 'end_turn' } });
        }
      });
      callback(null, channel);
    },
  };
  const locations = {
    async exec(id, command) {
      assert.equal(id, vps.id);
      commands.push(command);
      if (command.includes('https://antigravity.google/cli/install.sh')) {
        installed = true;
        return '';
      }
      return installed ? executable : '';
    },
    async runner(id, cwd) {
      assert.equal(id, vps.id);
      return { client, file: '/home/fixture/runner.py', cwd: cwd.replace(/^~/, '/home/fixture') };
    },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agy-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new Store(directory, directory);
  store.state.locations.push(vps);
  const role = store.saveRole({ ...store.state.roles[0], engine: 'antigravity', locationId: vps.id, executable: '', model: 'fixture-model', effort: '', allowLocationTools: false });
  const project = store.state.projects[0];
  project.directories = [{ locationId: vps.id, path: '~/project' }];
  const chat = store.createChat({ projectId: project.id, roleIds: [role.id] });
  store.message(chat.id, { kind: 'user', text: 'Do the fixture task.', status: 'accepted' });
  const vault = { get: () => '' };
  const agents = new Agents(store, vault, locations, () => {});
  return { store, role, project, chat, vault, agents, locations, commands, starts, sessions, stops, signIn: () => { loggedIn = true; } };
}

test('Remote Antigravity installs once, requests Google authorization, and verifies the resulting login', async t => {
  const { locations, role, commands, starts, signIn } = remoteFixture(t, { installed: false, loggedIn: false });
  let prompts = 0;
  assert.equal(await configure(locations, vps, role, proxy, async entry => {
    assert.equal(entry, executable);
    prompts++;
    signIn();
    return true;
  }), true);
  assert.equal(prompts, 1);
  const installerCommands = commands.filter(command => command.includes('/cli/install.sh'));
  assert.equal(installerCommands.length, 1);
  assert.match(installerCommands[0], /\nbash "\$installer" >&2$/);
  assert.deepEqual(starts.map(start => start.proxy), [proxy, proxy]);
  assert.equal(await configure(locations, vps, role, proxy, () => assert.fail('Existing login should be reused')), true);
  assert.equal(commands.filter(command => command.includes('/cli/install.sh')).length, 1);
});

test('Closing remote authorization releases setup without misreporting a verified login', async t => {
  const { role, locations, starts } = remoteFixture(t, { loggedIn: false });
  assert.equal(await configure(locations, vps, role, proxy, async () => false), false);
  assert.equal(starts.length, 1);
});

test('Remote Antigravity uses the VPS catalog and project directory and resumes the exact ACP session', async t => {
  const { store, role, vault, locations, agents, project, chat, starts, sessions } = remoteFixture(t);
  const catalog = new ModelCatalogs({ directory: store.directory, store, vault, locations, agents });
  assert.deepEqual((await catalog.request(role.id)).models.map(model => model.id), ['fixture-model']);
  const signal = new AbortController().signal;
  const first = await agents.run(chat.id, role, project, signal);
  assert.equal(first.status, 'complete', first.note);
  assert.equal(first.text, 'Remote reply');
  store.message(chat.id, { kind: 'user', text: 'Continue.', status: 'accepted' });
  const second = await agents.run(chat.id, role, project, signal);
  assert.equal(second.status, 'complete', second.note);
  assert.equal(second.agentSessionId, first.agentSessionId);
  assert.deepEqual(starts.slice(1).map(start => start.cwd), ['/home/fixture/project', '/home/fixture/project']);
  assert.equal(sessions.at(-1).method, 'session/resume');
  assert.equal(sessions.at(-1).params.sessionId, first.agentSessionId);
});

test('Forcing a remote Antigravity stop waits for the SSH runner to confirm process shutdown', async t => {
  const { role, agents, project, chat, stops } = remoteFixture(t, { hang: true });
  const controller = new AbortController();
  const task = agents.run(chat.id, role, project, controller.signal, false, { workflowAttemptId: randomUUID() });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const timer = setInterval(() => {
      if (!chat.messages.some(message => message.workflowSubmitted) && Date.now() < deadline) return;
      clearInterval(timer);
      if (Date.now() >= deadline) return reject(new Error('The remote prompt was not submitted.'));
      agents.forceStop(chat.id);
      controller.abort();
      resolve();
    }, 5);
  });
  const result = await task;
  assert.deepEqual(stops, ['force']);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopConfirmed, true);
});

test('Only complete Google OAuth URLs are offered to the browser button', () => {
  const valid = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=example';
  assert.equal(authorizationUrl('Open ' + valid + '\r\n'), valid);
  assert.equal(authorizationUrl(valid), '');
  assert.equal(authorizationUrl(valid.replace('google.com', 'google.com.example.test') + '\n'), '');
  assert.equal(authorizationUrl('https://accounts.google.com/other?client_id=fixture\n'), '');
});
