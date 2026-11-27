const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, PassThrough } = require('node:stream');
const { Store } = require('../workbench/store.cjs');
const { McpTunnels } = require('../workbench/mcp-tunnels.cjs');
const reverseRoutes = require('../reverse-routes.cjs');

test('Store normalizes mcpTunnel settings on Linux SSH locations and validates port bounds', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-team-store-tunnel-'));
  const store = new Store(dir, dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const saved = store.saveLocation({
    name: 'bwg',
    host: '104.194.74.108',
    username: 'ptrees',
    port: 29983,
    os: 'linux',
    control: 'ssh',
    mcpTunnel: { enabled: true, remotePort: 18112, autoStart: true, syncRemoteEnv: true },
  });
  assert.deepEqual(saved.mcpTunnel, {
    enabled: true,
    remotePort: 18112,
    autoStart: true,
    syncRemoteEnv: true,
  });

  assert.throws(() => store.saveLocation({
    name: 'bad-port',
    host: 'example.invalid',
    username: 'u',
    port: 22,
    os: 'linux',
    control: 'ssh',
    mcpTunnel: { enabled: true, remotePort: 80 },
  }), /1024.*65535/);
});

test('McpTunnels ensures local .env, opens reverse tunnel, syncs remote env, and cleans up on stop', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-team-mcp-tunnels-'));
  const store = new Store(dir, dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const loc = store.saveLocation({
    name: 'bwg',
    host: '10.0.0.2',
    username: 'ptrees',
    port: 29983,
    os: 'linux',
    control: 'ssh',
    mcpTunnel: { enabled: true, remotePort: 18115, autoStart: false, syncRemoteEnv: true },
  });

  const client = new EventEmitter();
  const forwarded = [];
  const unforwarded = [];
  const uploaded = {};
  const execCalls = [];
  client.forwardIn = (host, port, cb) => {
    forwarded.push({ host, port });
    cb(null);
  };
  client.unforwardIn = (host, port, cb) => {
    unforwarded.push({ host, port });
    cb?.();
  };
  client.sftp = cb => cb(null, {
    createWriteStream(target) {
      const stream = new PassThrough();
      let buf = '';
      stream.on('data', chunk => { buf += chunk.toString('utf8'); });
      stream.on('finish', () => {
        uploaded[target] = buf;
        stream.destroy();
      });
      return stream;
    },
    end() {},
  });

  const locations = {
    connect: async id => {
      assert.equal(id, loc.id);
      return client;
    },
    exec: async (_id, cmd) => {
      execCalls.push(cmd);
      if (cmd === 'printf %s "$HOME"') return '/home/ptrees';
      return '';
    },
  };
  const backend = {
    status: { mcp: 'ready' },
    localPort: 8111,
    async startMcp() {},
  };

  let emits = 0;
  const tunnels = new McpTunnels({ root: dir, store, locations, backend, emit: () => { emits++; } });
  tunnels.probeRemote = async (_c, port, secret) => {
    assert.equal(port, 18115);
    assert.match(secret, /^[a-f0-9]{64}$/);
    return true;
  };

  const status = await tunnels.setupAndStart(loc.id);
  assert.equal(status.state, 'ready');
  assert.equal(status.remotePort, 18115);
  assert.equal(status.localPort, 8111);
  assert.equal(status.syncedRemoteEnv, true);
  assert.equal(status.remoteEnvPath, '/home/ptrees/.windows-mcp/tunnel.env');
  assert.deepEqual(forwarded, [{ host: '127.0.0.1', port: 18115 }]);
  assert.equal(fs.existsSync(path.join(dir, '.env')), true);

  const uploadedEntry = Object.entries(uploaded)[0];
  assert.ok(uploadedEntry[0].startsWith('/home/ptrees/.windows-mcp/tunnel.env.'));
  assert.match(uploadedEntry[1], /WINDOWS_MCP_URL=http:\/\/127\.0\.0\.1:18115\/mcp/);
  assert.match(uploadedEntry[1], /WINDOWS_MCP_SECRET=[a-f0-9]{64}/);
  assert.ok(execCalls.some(cmd => cmd.includes('mv -f --') && cmd.includes('/home/ptrees/.windows-mcp/tunnel.env')));

  // Verify reverse-routes registered the port for this ssh2 client.
  let routed = false;
  assert.equal(reverseRoutes.route(client, { destPort: 18115, destIP: '127.0.0.1' }, () => {
    routed = true;
    const ch = new EventEmitter();
    ch.destroy = () => {};
    ch.pipe = () => ch;
    return ch;
  }, () => {}), true);
  assert.equal(routed, true);

  const agentTarget = await tunnels.ensureForAgent(loc.id);
  assert.equal(agentTarget.url, 'http://127.0.0.1:18115/mcp');
  assert.match(agentTarget.token, /^[a-f0-9]{64}$/);

  const stopped = await tunnels.stop(loc.id);
  assert.equal(stopped.state, 'off');
  assert.deepEqual(unforwarded, [{ host: '127.0.0.1', port: 18115 }]);
  assert.ok(emits > 0);
});
