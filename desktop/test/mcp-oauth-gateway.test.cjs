const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createGatewayServer, sha256Hex } = require('../../server/mcp-oauth-gateway/gateway.cjs');
const { DirectoryAccess, createDirectoryAccessBridge } = require('../workbench/directory-access.cjs');

test('MCP OAuth gateway enforces PKCE + passphrase auth and filters tools to the read-only whitelist', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-team-oauth-gw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tunnelEnvFile = path.join(dir, 'tunnel.env');
  fs.writeFileSync(tunnelEnvFile, 'WINDOWS_MCP_URL=http://127.0.0.1:19999/mcp\nWINDOWS_MCP_SECRET=secret-xyz\n');

  const upstreamCalls = [];
  const fakeFetch = async (url, init) => {
    upstreamCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const req = JSON.parse(init.body);
    if (req.method === 'tools/list') {
      const sse = 'event: message\ndata: ' + JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [
            { name: 'ControlStatus', description: 'Status' },
            { name: 'DisplayInventory', description: 'Displays' },
            { name: 'Shell', description: 'Dangerous shell' },
            { name: 'Click', description: 'Mouse click' },
          ],
        },
      }) + '\n\n';
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: '[{"index":0}]' }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const server = createGatewayServer({
    issuer: 'https://mcp.ptrees.org',
    allowedTools: 'ControlStatus,DisplayInventory',
    authPasswordHash: sha256Hex('correct-pass'),
    stateFile: path.join(dir, 'state.json'),
    tunnelEnvFile,
    fetch: fakeFetch,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. Discovery + 401 challenge
  const meta = await fetch(`${base}/.well-known/oauth-protected-resource`).then(r => r.json());
  assert.equal(meta.authorization_servers[0], 'https://mcp.ptrees.org');

  const unauth = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata=/);

  // 2. Dynamic Client Registration
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Gemini Web',
      redirect_uris: ['https://gemini.google.com/oauth/callback'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  assert.ok(client.client_id && client.client_secret);

  // 3. Authorize page + PKCE S256
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const authUrl = new URL(`${base}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', 'https://gemini.google.com/oauth/callback');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', 'xyz-state');

  const authResp = await fetch(authUrl);
  assert.doesNotMatch(authResp.headers.get('content-security-policy') || '', /form-action/);
  const html = await authResp.text();
  const csrfMatch = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(csrfMatch);

  // Wrong passphrase -> 403
  const badForm = new URLSearchParams({
    csrf: csrfMatch[1],
    client_id: client.client_id,
    redirect_uri: 'https://gemini.google.com/oauth/callback',
    scope: 'mcp:tools',
    state: 'xyz-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    passphrase: 'wrong',
  });
  const badRes = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: badForm.toString(),
    redirect: 'manual',
  });
  assert.equal(badRes.status, 403);
  const badHtml = await badRes.text();
  const nextCsrf = /name="csrf" value="([^"]+)"/.exec(badHtml)[1];

  // Right passphrase -> 302 with code
  badForm.set('csrf', nextCsrf);
  badForm.set('passphrase', 'correct-pass');
  const okRes = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: badForm.toString(),
    redirect: 'manual',
  });
  assert.equal(okRes.status, 302);
  const redirectBack = new URL(okRes.headers.get('location'));
  assert.equal(redirectBack.searchParams.get('state'), 'xyz-state');
  const code = redirectBack.searchParams.get('code');
  assert.ok(code);

  // 4. Token exchange
  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://gemini.google.com/oauth/callback',
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const tokens = await tokenRes.json();
  assert.ok(tokens.access_token && tokens.refresh_token);

  // 5. tools/list filters out Shell and Click
  const listRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }).then(r => r.json());
  assert.deepEqual(listRes.result.tools.map(x => x.name), ['ControlStatus', 'DisplayInventory']);

  // 6. Blocked tool never reaches upstream
  const blockedRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Shell', arguments: {} } }),
  }).then(r => r.json());
  assert.equal(blockedRes.error.code, -32602);
  assert.equal(upstreamCalls.length, 1);

  // 7. Allowed tool forwards with secret Bearer token
  const allowedRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'DisplayInventory', arguments: {} } }),
  }).then(r => r.json());
  assert.equal(allowedRes.result.content[0].text, '[{"index":0}]');
  assert.equal(upstreamCalls[1].headers.Authorization, 'Bearer secret-xyz');
});

test('remote directory access requires a local grant, survives token refresh and can be revoked', async t => {
  const fixtures = path.resolve(__dirname, '../../.tmp');
  fs.mkdirSync(fixtures, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtures, 'ai-team-directory-access-'));
  const project = path.join(dir, 'project');
  const external = path.join(dir, 'external');
  fs.mkdirSync(project);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(project, 'notes.txt'), 'original');
  fs.writeFileSync(path.join(project, '.env'), 'private');
  fs.writeFileSync(path.join(external, 'outside.txt'), 'outside');
  fs.symlinkSync(external, path.join(project, 'linked'), 'junction');
  fs.linkSync(path.join(external, 'outside.txt'), path.join(project, 'linked.txt'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let approval;
  let prompts = 0;
  const access = new DirectoryAccess({
    approve: value => { prompts++; return new Promise(resolve => { approval = { value, resolve }; }); },
    changed: () => {},
  });
  const bridge = await createDirectoryAccessBridge(access);
  const tunnelEnvFile = path.join(dir, 'tunnel.env');
  fs.writeFileSync(tunnelEnvFile, `DIRECTORY_ACCESS_URL=${bridge.url}\nDIRECTORY_ACCESS_TOKEN=${bridge.token}\n`);
  const stateFile = path.join(dir, 'state.json');
  const expiresAt = Date.now() + 60_000;
  const auth = { clientId: 'test', scope: 'mcp:tools', expiresAt };
  fs.writeFileSync(stateFile, JSON.stringify({
    accessTokens: { [sha256Hex('initial-token')]: auth,
      [sha256Hex('other-token')]: { ...auth, authorizationId: 'other' } },
    refreshTokens: { [sha256Hex('refresh-token')]: { ...auth, expiresAt: expiresAt + (30 * 24 - 1) * 3600 * 1000 } },
  }));
  const upstreamCalls = [];
  const server = createGatewayServer({
    directoryAccessEnabled: true,
    allowedTools: 'ControlStatus,FileSystem',
    staticClientId: 'test', stateFile, tunnelEnvFile,
    upstreamUrl: 'http://127.0.0.1:19999/mcp', upstreamSecret: 'upstream-test-token',
    fetch: (url, init) => {
      if (url === bridge.url) return fetch(url, init);
      const message = JSON.parse(init.body);
      upstreamCalls.push(message.method);
      return Promise.resolve(Response.json({ id: message.id, result: { tools: [{ name: 'ControlStatus' }, { name: 'FileSystem' }] } }));
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { bridge.close(); server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const mcp = (method, params, token = 'initial-token') => fetch(base + '/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then(response => response.json());
  const call = (name, args, token) => mcp('tools/call', { name, arguments: args }, token);
  assert.equal((await fetch(bridge.url, { method: 'POST' })).status, 401);
  const tools = (await mcp('tools/list', {})).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['ControlStatus', 'RequestDirectoryAccess', 'CheckDirectoryAccess', 'ReadProjectFiles', 'WriteProjectFile']);
  assert.equal(tools.at(-1).annotations.destructiveHint, true);
  assert.equal((await call('FileSystem', { mode: 'write' })).error.code, -32602);

  const request = (await call('RequestDirectoryAccess', {
    directory: project, access: 'read-write', reason: 'Edit notes',
  })).result.structuredContent;
  assert.equal(request.status, 'pending');
  assert.equal(approval.value.directory, project);
  const grant = { requestId: request.requestId };
  const read = { ...grant, operation: 'read', path: 'notes.txt' };
  assert.equal((await call('ReadProjectFiles', read)).result.isError, true);
  assert.equal((await call('CheckDirectoryAccess', grant, 'other-token')).result.isError, true);
  approval.resolve(true);
  assert.equal((await call('CheckDirectoryAccess', grant)).result.structuredContent.status, 'approved');
  const refreshed = await fetch(base + '/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'test', refresh_token: 'refresh-token' }),
  }).then(response => response.json());
  assert.ok(refreshed.access_token);
  const { revision, content } = (await call('ReadProjectFiles', read, refreshed.access_token)).result.structuredContent;
  assert.equal(content, 'original');
  assert.equal((await call('WriteProjectFile', { ...grant, path: 'notes.txt', content: 'updated', revision })).result.structuredContent.status, 'written');
  assert.equal((await call('WriteProjectFile', { ...grant, path: 'notes.txt', content: 'stale update', revision })).result.isError, true);
  assert.equal((await call('WriteProjectFile', { ...grant, path: 'new.txt', content: 'created', revision: 'create' })).result.structuredContent.status, 'written');
  assert.equal(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8'), 'updated');
  assert.equal(fs.readFileSync(path.join(project, 'new.txt'), 'utf8'), 'created');
  const listed = (await call('ReadProjectFiles', { ...grant, path: '.', operation: 'list' })).result.structuredContent;
  assert.deepEqual(listed.entries.map(entry => entry.name).sort(), ['new.txt', 'notes.txt']);
  const searched = (await call('ReadProjectFiles', {
    ...grant, path: '.', operation: 'search', query: 'updated',
  })).result.structuredContent;
  assert.deepEqual(searched.matches, [{ path: 'notes.txt', line: 1, text: 'updated' }]);
  for (const forbidden of ['../external/outside.txt', 'linked/outside.txt', 'linked.txt', '.env', 'notes.txt:alternate']) {
    assert.equal((await call('ReadProjectFiles', { ...read, path: forbidden })).result.isError, true);
  }
  assert.equal(prompts, 1);
  assert.deepEqual(upstreamCalls, ['tools/list']);
  access.revoke();
  assert.equal((await call('WriteProjectFile', { ...grant, path: 'later.txt', content: 'blocked', revision: 'create' })).result.isError, true);

  const readOnly = (await call('RequestDirectoryAccess', { directory: project, access: 'read', reason: 'Inspect notes' })).result.structuredContent;
  approval.resolve(true);
  assert.equal((await call('WriteProjectFile', { requestId: readOnly.requestId, path: 'later.txt', content: 'blocked', revision: 'create' })).result.isError, true);
  const pending = (await call('RequestDirectoryAccess', { directory: project, access: 'read', reason: 'Another check' })).result.structuredContent;
  access.revoke();
  assert.equal(approval.value.signal.aborted, true);
  approval.resolve(true);
  assert.equal((await call('CheckDirectoryAccess', { requestId: pending.requestId })).result.isError, true);
});
