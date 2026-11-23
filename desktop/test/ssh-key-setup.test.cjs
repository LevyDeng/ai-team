const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Server, utils } = require('ssh2');
const { Locations } = require('../workbench/locations.cjs');
const { setupSshKey } = require('../workbench/ssh-key-setup.cjs');

test('SSH key setup enrolls a public key once, verifies it, and rejects a changed host before authentication', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-team-ssh-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => directory);
  const password = 'fixture-password';
  const hostKey = utils.generateKeyPairSync('rsa', { bits: 2048 }).private;
  const connections = new Set();
  let allowedKey;
  let passwordAttempts = 0;
  let writes = 0;
  let trusted = 0;
  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client);
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    client.on('authentication', ctx => {
      if (ctx.username !== 'fixture') return ctx.reject();
      if (ctx.method === 'password') {
        passwordAttempts++;
        return ctx.password === password ? ctx.accept() : ctx.reject(['publickey', 'password']);
      }
      if (ctx.method === 'publickey' && allowedKey?.getPublicSSH().equals(ctx.key.data)) {
        if (!ctx.signature || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
      }
      ctx.reject(['publickey', 'password']);
    });
    client.on('ready', () => {
      client.on('session', accept => accept().on('exec', (acceptExec, _reject, { command }) => {
        assert.match(command, />> ~\/\.ssh\/authorized_keys/);
        const publicKey = command.match(/ssh-ed25519 [A-Za-z0-9+/=]+ ai-team/)?.[0];
        allowedKey = utils.parseKey(publicKey);
        assert.equal(allowedKey.isPrivateKey(), false);
        writes++;
        const stream = acceptExec();
        stream.exit(0);
        stream.end();
      }));
    });
  });
  t.after(() => {
    for (const client of connections) client.end();
    return new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const location = { host: '127.0.0.1', port: server.address().port, username: 'fixture', keyPath: '' };
  const locations = new Locations({ directory }, {}, {}, async () => { trusted++; return true; }, () => {});

  assert.deepEqual(await setupSshKey(locations, location, {}), { needsPassword: true });
  assert.equal(passwordAttempts, 0);
  assert.equal(fs.existsSync(path.join(directory, '.ssh')), false);
  await assert.rejects(setupSshKey(locations, location, { password: 'incorrect' }), /SSH 密码验证失败/);
  assert.equal(writes, 0);

  const configured = await setupSshKey(locations, location, { password });
  assert.ok(configured.keyPath.startsWith(path.join(directory, '.ssh', 'ai-team') + path.sep));
  assert.ok(fs.statSync(configured.keyPath).isFile());
  assert.deepEqual(await setupSshKey(locations, location, {}), configured);
  assert.equal(writes, 1);
  assert.equal(passwordAttempts, 2);
  assert.equal(trusted, 1);

  locations.known['[' + location.host + ']:' + location.port] = 'SHA256:stale';
  await assert.rejects(setupSshKey(locations, location, { password }), /SSH 主机指纹已变化/);
  assert.equal(passwordAttempts, 2);
});
