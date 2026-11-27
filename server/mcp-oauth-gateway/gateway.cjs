const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BODY_BYTES = 1024 * 1024;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SEC = 3600;
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600;
const MAX_DCR_CLIENTS = 100;

const requestIdProperty = { type: 'string', description: 'Request ID returned by RequestDirectoryAccess in this conversation.' };
const pathProperty = { type: 'string', description: 'Relative path inside the approved project directory. Use "." for the project directory.' };
function directoryTool(name, description, properties, required, readOnlyHint) {
  return {
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: false },
  };
}
const directoryTools = [
  directoryTool('RequestDirectoryAccess', 'Ask the user to approve access to one Windows project directory in AI Team. Use only the directory and access level the user requests. Save the returned request ID for this conversation. If pending, ask the user to confirm on their PC and then call CheckDirectoryAccess.',
    {
      directory: { type: 'string', description: 'Absolute path to an existing Windows project directory.' },
      access: { type: 'string', enum: ['read', 'read-write'] },
      reason: { type: 'string', maxLength: 500 },
    }, ['directory', 'access', 'reason'], false),
  directoryTool('CheckDirectoryAccess', 'Check whether the user approved this conversation\'s directory access request.',
    { requestId: requestIdProperty }, ['requestId'], true),
  directoryTool('ReadProjectFiles', 'Read UTF-8 text, list entries, inspect a path, or search for literal text in an approved project directory. Reading a file returns the revision needed to modify it.',
    { requestId: requestIdProperty, path: pathProperty, operation: { type: 'string', enum: ['read', 'list', 'info', 'search'] },
      query: { type: 'string', description: 'Literal text to search for when operation is search.' } }, ['requestId', 'path', 'operation'], true),
  directoryTool('WriteProjectFile', 'Create or modify one UTF-8 text file, up to 128 KiB, in a directory approved for read-write access. Read an existing file before editing and pass its returned revision. For a new file pass "create" as revision.',
    { requestId: requestIdProperty, path: pathProperty, content: { type: 'string' },
      revision: { type: 'string', description: 'Revision from ReadProjectFiles, or "create" when creating a file.' } },
    ['requestId', 'path', 'content', 'revision'], false),
];
const directoryToolNames = new Set(directoryTools.map(tool => tool.name));

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function parseDotEnvFile(filePath) {
  const result = {};
  if (!filePath || !fs.existsSync(filePath)) return result;
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function isAllowedRedirectUri(uri, client) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (client?.redirectUris?.length) {
    return client.redirectUris.includes(uri);
  }
  if (parsed.protocol === 'https:') {
    const host = parsed.hostname.toLowerCase();
    return host === 'gemini.google.com' ||
      host.endsWith('.google.com') ||
      host === 'googleusercontent.com' ||
      host.endsWith('.googleusercontent.com');
  }
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  }
  return false;
}

function isValidDcrRedirectUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  }
  return false;
}

function verifyPkceS256(verifier, challenge) {
  if (!verifier || !challenge || verifier.length < 43 || verifier.length > 128) return false;
  const digest = crypto.createHash('sha256').update(verifier, 'ascii').digest();
  const encoded = digest.toString('base64url');
  return timingSafeEqualHex(encoded, challenge);
}

function parseSseJsonRpc(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch {
      // Ignore non-JSON SSE keepalive/comments.
    }
  }
  return messages;
}

function parseUpstreamBody(text, contentType) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (String(contentType || '').includes('text/event-stream') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    const parsed = parseSseJsonRpc(trimmed);
    if (parsed.length) return parsed;
  }
  const json = JSON.parse(trimmed);
  return Array.isArray(json) ? json : [json];
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonResponse(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function loadState(stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return { clients: {}, refreshTokens: {}, accessTokens: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
      refreshTokens: parsed.refreshTokens && typeof parsed.refreshTokens === 'object' ? parsed.refreshTokens : {},
      accessTokens: parsed.accessTokens && typeof parsed.accessTokens === 'object' ? parsed.accessTokens : {},
    };
  } catch {
    return { clients: {}, refreshTokens: {}, accessTokens: {} };
  }
}

function linkLegacyOAuthTokens(state) {
  const groups = new Map();
  for (const [kind, records, lifetime] of [
    ['access', state.accessTokens, ACCESS_TOKEN_TTL_SEC],
    ['refresh', state.refreshTokens, REFRESH_TOKEN_TTL_SEC],
  ]) {
    for (const [hash, record] of Object.entries(records)) {
      if (!record || record.authorizationId || !Number.isFinite(record.expiresAt)) continue;
      const issuedAt = record.expiresAt - lifetime * 1000;
      const key = JSON.stringify([record.clientId, record.scope, issuedAt]);
      if (!groups.has(key)) groups.set(key, { access: [], refresh: [] });
      groups.get(key)[kind].push({ hash, record });
    }
  }
  for (const { access, refresh } of groups.values()) {
    if (access.length !== 1 || refresh.length !== 1) continue;
    const id = sha256Hex('legacy-oauth-grant:' + access[0].hash + ':' + refresh[0].hash);
    access[0].record.authorizationId = id;
    refresh[0].record.authorizationId = id;
  }
}

function saveState(stateFile, state) {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const tmp = stateFile + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

function createGatewayServer(options) {
  const issuer = String(options.issuer || 'https://mcp.ptrees.org').replace(/\/$/, '');
  const resourceUrl = String(options.resourceUrl || `${issuer}/mcp`);
  const allowedTools = new Set(
    (Array.isArray(options.allowedTools) ? options.allowedTools : String(options.allowedTools || 'ControlStatus,DisplayInventory,Screenshot,Snapshot').split(','))
      .map(s => s.trim())
      .filter(Boolean)
  );
  const authPasswordHash = String(options.authPasswordHash || '');
  const directoryAccessEnabled = Boolean(options.directoryAccessEnabled);
  if (directoryAccessEnabled) allowedTools.delete('FileSystem');
  const staticClientId = String(options.staticClientId || '');
  const staticClientSecretHash = String(options.staticClientSecretHash || '');
  const stateFile = options.stateFile || '';
  const tunnelEnvFile = options.tunnelEnvFile || '';
  const fetchImpl = options.fetch || globalThis.fetch;

  const state = loadState(stateFile);
  linkLegacyOAuthTokens(state);
  const authCodes = new Map();
  const csrfTokens = new Map();
  const failedAttempts = new Map();

  function pruneExpired() {
    const now = Date.now();
    for (const [k, v] of authCodes) if (v.expiresAt <= now) authCodes.delete(k);
    for (const [k, v] of csrfTokens) if (v.expiresAt <= now) csrfTokens.delete(k);
    let dirty = false;
    for (const [k, v] of Object.entries(state.accessTokens)) {
      if (v.expiresAt <= now) { delete state.accessTokens[k]; dirty = true; }
    }
    for (const [k, v] of Object.entries(state.refreshTokens)) {
      if (v.expiresAt <= now) { delete state.refreshTokens[k]; dirty = true; }
    }
    if (dirty) saveState(stateFile, state);
  }

  function resolveClient(clientId) {
    if (!clientId) return null;
    if (staticClientId && clientId === staticClientId) {
      return {
        clientId: staticClientId,
        secretHash: staticClientSecretHash,
        authMethod: staticClientSecretHash ? 'client_secret_post' : 'none',
        redirectUris: null,
        isStatic: true,
      };
    }
    return state.clients[clientId] || null;
  }

  function resolveUpstream() {
    const fileEnv = parseDotEnvFile(tunnelEnvFile);
    const url = (fileEnv.WINDOWS_MCP_URL || options.upstreamUrl || '').trim();
    const secret = (fileEnv.WINDOWS_MCP_SECRET || options.upstreamSecret || '').trim();
    return { url, secret };
  }

  function authenticateBearer(req) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return null;
    const raw = auth.slice(7).trim();
    if (!raw) return null;
    const tokenHash = sha256Hex(raw);
    const record = state.accessTokens[tokenHash];
    if (!record || record.expiresAt <= Date.now()) return null;
    return { ...record, authorizationId: record.authorizationId || tokenHash };
  }

  function issueTokens(clientId, scope, authorizationId = crypto.randomUUID()) {
    const accessToken = crypto.randomBytes(32).toString('base64url');
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    state.accessTokens[sha256Hex(accessToken)] = {
      clientId,
      scope,
      authorizationId,
      expiresAt: now + ACCESS_TOKEN_TTL_SEC * 1000,
    };
    state.refreshTokens[sha256Hex(refreshToken)] = {
      clientId,
      scope,
      authorizationId,
      expiresAt: now + REFRESH_TOKEN_TTL_SEC * 1000,
    };
    saveState(stateFile, state);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: refreshToken,
      scope,
    };
  }

  function renderAuthorizeForm({ clientId, redirectUri, scope, stateParam, codeChallenge, codeChallengeMethod, resource, csrf, errorText = '' }) {
    const toolsText = [...allowedTools, ...(directoryAccessEnabled ? directoryToolNames : [])].join(', ') || '（无）';
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 小队 · 远程 MCP 授权</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f4f6f5; color: #1d2420; margin: 0; padding: 24px; display: grid; place-items: center; min-height: 100vh; }
  .card { background: #fff; border: 1px solid #d9e2dc; border-radius: 14px; max-width: 460px; width: 100%; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,.06); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 14px; line-height: 1.6; color: #4f5d55; margin: 8px 0; }
  .meta { background: #f7faf8; border: 1px solid #e1ebe4; border-radius: 10px; padding: 12px; font-size: 13px; margin: 14px 0; word-break: break-all; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #c9d4cd; border-radius: 8px; font-size: 15px; }
  button { width: 100%; margin-top: 16px; padding: 11px; border: 0; border-radius: 8px; background: #17a74e; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  .err { color: #b83232; background: #fdf2f2; border: 1px solid #f5c2c2; border-radius: 8px; padding: 8px 10px; font-size: 13px; margin: 10px 0; }
</style></head><body><main class="card">
<h1>授权访问 AI 小队远程 MCP</h1>
<p>以下外部应用请求接入你的 Windows-MCP 工具网关，请输入网关授权密码以确认。${directoryAccessEnabled ? '项目目录权限需要在 AI 小队本机另行批准。' : ''}</p>
<div class="meta">
  <div><strong>客户端 ID：</strong>${escapeHtml(clientId)}</div>
  <div><strong>回调地址：</strong>${escapeHtml(redirectUri)}</div>
  <div><strong>允许的工具白名单：</strong>${escapeHtml(toolsText)}</div>
</div>
${errorText ? `<div class="err">${escapeHtml(errorText)}</div>` : ''}
<form method="post" action="/authorize">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
  <input type="hidden" name="scope" value="${escapeHtml(scope)}">
  <input type="hidden" name="state" value="${escapeHtml(stateParam)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
  <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
  <input type="hidden" name="resource" value="${escapeHtml(resource)}">
  <label for="passphrase">网关授权密码</label>
  <input id="passphrase" name="passphrase" type="password" required autocomplete="current-password" autofocus>
  <button type="submit">确认并授权接入</button>
</form></main></body></html>`;
  }

  function extractClientCredentials(req, params) {
    let clientId = params.get('client_id') || '';
    let clientSecret = params.get('client_secret') || '';
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, colon));
          clientSecret = decodeURIComponent(decoded.slice(colon + 1));
        }
      } catch {}
    }
    return { clientId, clientSecret };
  }

  function resolveDirectoryBridge() {
    const env = parseDotEnvFile(tunnelEnvFile);
    const url = env.DIRECTORY_ACCESS_URL || '';
    const token = env.DIRECTORY_ACCESS_TOKEN || '';
    return /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/rpc$/.test(url) && /^[a-f0-9]{64}$/.test(token) ? { url, token } : null;
  }

  async function callDirectoryTool(msg, oauthToken) {
    const branch = resolveDirectoryBridge();
    const result = (value, error) => ({
      jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: error || JSON.stringify(value) }],
        ...(error ? { isError: true } : { structuredContent: value }),
      },
    });
    const offline = '本机目录权限通道未连接。请保持 AI 小队开启，并在对应位置启动 MCP 隧道和远端配置同步。';
    if (!branch) return result(null, offline);
    const { name, arguments: args = {} } = msg.params;
    try {
      const response = await fetchImpl(branch.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
        headers: { Authorization: 'Bearer ' + branch.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ principal: oauthToken.authorizationId, name, args }),
      });
      if (!response.ok) return result(null, offline);
      const { value, error } = await response.json();
      return result(value, error);
    } catch {
      return result(null, offline);
    }
  }

  async function forwardMcpMessages(messages, sessionId, oauthToken) {
    const { url, secret } = resolveUpstream();
    const responses = new Map();
    const forwardList = [];

    for (const msg of messages) {
      if (msg?.method === 'tools/call') {
        const toolName = msg.params?.name;
        if (directoryAccessEnabled && directoryToolNames.has(toolName)) {
          if (msg.id !== undefined) responses.set(msg.id, await callDirectoryTool(msg, oauthToken));
          continue;
        }
        if (!allowedTools.has(toolName)) {
          if (msg.id !== undefined) {
            responses.set(msg.id, {
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32602, message: `工具「${toolName || 'unknown'}」未在远程网关白名单中开放。` },
            });
          }
          continue;
        }
      }
      forwardList.push(msg);
    }

    if (forwardList.length) {
      const payload = forwardList.length === 1 && messages.length === 1 ? forwardList[0] : forwardList;
      let upstreamResp;
      try {
        if (!url || !secret) throw new Error('Windows-MCP upstream unavailable');
        const headers = {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        upstreamResp = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
      } catch {
        for (const msg of forwardList) {
          if (msg?.id !== undefined) {
            responses.set(msg.id, {
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: '无法连接本机 Windows-MCP 反向隧道，请确认电脑已开机且 AI 小队隧道处于连接状态。' },
            });
          }
        }
        return messages.map(m => m?.id !== undefined ? responses.get(m.id) : null).filter(Boolean);
      }

      const rawText = await upstreamResp.text();
      if (!upstreamResp.ok) {
        for (const msg of forwardList) {
          if (msg?.id !== undefined) {
            responses.set(msg.id, {
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: `Windows-MCP 网关上游返回 HTTP ${upstreamResp.status}。` },
            });
          }
        }
      } else if (rawText.trim()) {
        const parsed = parseUpstreamBody(rawText, upstreamResp.headers.get('content-type'));
        const listRequestIds = new Set(forwardList.filter(m => m?.method === 'tools/list' && m.id !== undefined).map(m => m.id));
        for (const reply of parsed) {
          if (reply && listRequestIds.has(reply.id) && Array.isArray(reply.result?.tools)) {
            reply.result = {
              ...reply.result,
              tools: [...reply.result.tools.filter(tool => allowedTools.has(tool?.name) && !directoryToolNames.has(tool?.name)),
                ...(directoryAccessEnabled ? directoryTools : [])],
            };
          }
          if (reply && reply.id !== undefined) responses.set(reply.id, reply);
        }
      }
    }

    return messages
      .filter(msg => msg && msg.id !== undefined)
      .map(msg => responses.get(msg.id))
      .filter(Boolean);
  }

  return http.createServer(async (req, res) => {
    try {
      pruneExpired();
      const url = new URL(req.url || '/', issuer);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/healthz') {
        const upstream = resolveUpstream();
        return jsonResponse(res, 200, {
          ok: true,
          upstreamConfigured: Boolean(upstream.url && upstream.secret),
          allowedTools: [...allowedTools],
          ...(directoryAccessEnabled ? {
            directoryAccessEnabled: true,
            directoryAccessConfigured: Boolean(resolveDirectoryBridge()),
          } : {}),
        });
      }

      if (req.method === 'GET' && (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp')) {
        return jsonResponse(res, 200, {
          resource: resourceUrl,
          authorization_servers: [issuer],
          bearer_methods_supported: ['header'],
          scopes_supported: ['mcp:tools'],
        });
      }

      if (req.method === 'GET' && (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/openid-configuration')) {
        return jsonResponse(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['mcp:tools'],
        });
      }

      if (req.method === 'POST' && pathname === '/register') {
        const bodyText = await readBody(req, 64 * 1024);
        let body;
        try { body = JSON.parse(bodyText || '{}'); }
        catch { return jsonResponse(res, 400, { error: 'invalid_client_metadata' }); }
        const redirectUris = body.redirect_uris;
        if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > 10 || !redirectUris.every(isValidDcrRedirectUri)) {
          return jsonResponse(res, 400, { error: 'invalid_redirect_uri', error_description: 'Redirect URIs must use HTTPS (or loopback HTTP).' });
        }
        if (Object.keys(state.clients).length >= MAX_DCR_CLIENTS) {
          return jsonResponse(res, 429, { error: 'too_many_clients', error_description: 'Client registration limit reached.' });
        }
        const authMethod = body.token_endpoint_auth_method || 'client_secret_post';
        if (!['client_secret_post', 'client_secret_basic', 'none'].includes(authMethod)) {
          return jsonResponse(res, 400, { error: 'invalid_client_metadata' });
        }
        const clientId = 'mcp_' + crypto.randomBytes(12).toString('base64url');
        const clientSecret = authMethod === 'none' ? undefined : crypto.randomBytes(24).toString('base64url');
        state.clients[clientId] = {
          clientId,
          clientName: String(body.client_name || 'MCP Client').slice(0, 120),
          redirectUris,
          authMethod,
          secretHash: clientSecret ? sha256Hex(clientSecret) : '',
          createdAt: Date.now(),
        };
        saveState(stateFile, state);
        return jsonResponse(res, 201, {
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: authMethod,
        });
      }

      if (req.method === 'GET' && pathname === '/authorize') {
        const p = url.searchParams;
        const clientId = p.get('client_id') || '';
        const redirectUri = p.get('redirect_uri') || '';
        const responseType = p.get('response_type') || '';
        const scope = p.get('scope') || 'mcp:tools';
        const stateParam = p.get('state') || '';
        const codeChallenge = p.get('code_challenge') || '';
        const codeChallengeMethod = p.get('code_challenge_method') || (codeChallenge ? 'S256' : '');
        const resource = p.get('resource') || '';
        const client = resolveClient(clientId);

        if (!client || responseType !== 'code' || !isAllowedRedirectUri(redirectUri, client)) {
          return jsonResponse(res, 400, { error: 'invalid_request', error_description: 'Invalid client_id, response_type, or redirect_uri.' });
        }
        if (!codeChallenge || codeChallengeMethod !== 'S256') {
          return jsonResponse(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 is required.' });
        }

        const csrf = crypto.randomBytes(16).toString('base64url');
        csrfTokens.set(csrf, { expiresAt: Date.now() + AUTH_CODE_TTL_MS });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
        });
        res.end(renderAuthorizeForm({ clientId, redirectUri, scope, stateParam, codeChallenge, codeChallengeMethod, resource, csrf }));
        return;
      }

      if (req.method === 'POST' && pathname === '/authorize') {
        const raw = await readBody(req, 32 * 1024);
        const p = new URLSearchParams(raw);
        const csrf = p.get('csrf') || '';
        const clientId = p.get('client_id') || '';
        const redirectUri = p.get('redirect_uri') || '';
        const scope = p.get('scope') || 'mcp:tools';
        const stateParam = p.get('state') || '';
        const codeChallenge = p.get('code_challenge') || '';
        const codeChallengeMethod = p.get('code_challenge_method') || '';
        const resource = p.get('resource') || '';
        const passphrase = p.get('passphrase') || '';
        const client = resolveClient(clientId);

        if (!client || !isAllowedRedirectUri(redirectUri, client) || !codeChallenge || codeChallengeMethod !== 'S256') {
          return jsonResponse(res, 400, { error: 'invalid_request' });
        }
        const csrfRecord = csrfTokens.get(csrf);
        csrfTokens.delete(csrf);
        if (!csrfRecord || csrfRecord.expiresAt <= Date.now()) {
          return jsonResponse(res, 400, { error: 'invalid_request', error_description: 'Authorization page expired. Please retry.' });
        }

        const remoteIp = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
        const attempt = failedAttempts.get(remoteIp);
        if (attempt && attempt.blockedUntil > Date.now()) {
          const nextCsrf = crypto.randomBytes(16).toString('base64url');
          csrfTokens.set(nextCsrf, { expiresAt: Date.now() + AUTH_CODE_TTL_MS });
          res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(renderAuthorizeForm({ clientId, redirectUri, scope, stateParam, codeChallenge, codeChallengeMethod, resource, csrf: nextCsrf, errorText: '尝试次数过多，请 60 秒后再试。' }));
          return;
        }

        if (!authPasswordHash || !timingSafeEqualHex(sha256Hex(passphrase), authPasswordHash)) {
          const count = (attempt?.count || 0) + 1;
          failedAttempts.set(remoteIp, { count, blockedUntil: count >= 5 ? Date.now() + 60_000 : 0 });
          const nextCsrf = crypto.randomBytes(16).toString('base64url');
          csrfTokens.set(nextCsrf, { expiresAt: Date.now() + AUTH_CODE_TTL_MS });
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(renderAuthorizeForm({ clientId, redirectUri, scope, stateParam, codeChallenge, codeChallengeMethod, resource, csrf: nextCsrf, errorText: '授权密码不正确。' }));
          return;
        }

        failedAttempts.delete(remoteIp);
        const code = crypto.randomBytes(24).toString('base64url');
        authCodes.set(code, {
          clientId,
          redirectUri,
          scope,
          codeChallenge,
          codeChallengeMethod,
          expiresAt: Date.now() + AUTH_CODE_TTL_MS,
        });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        if (stateParam) target.searchParams.set('state', stateParam);
        res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (req.method === 'POST' && pathname === '/token') {
        const raw = await readBody(req, 64 * 1024);
        const contentType = req.headers['content-type'] || '';
        const params = contentType.includes('application/json')
          ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v ?? '')]))
          : new URLSearchParams(raw);
        const { clientId, clientSecret } = extractClientCredentials(req, params);
        const client = resolveClient(clientId);
        if (!client) return jsonResponse(res, 401, { error: 'invalid_client' });
        if (client.secretHash && !timingSafeEqualHex(sha256Hex(clientSecret), client.secretHash)) {
          return jsonResponse(res, 401, { error: 'invalid_client' });
        }

        const grantType = params.get('grant_type') || '';
        if (grantType === 'authorization_code') {
          const code = params.get('code') || '';
          const redirectUri = params.get('redirect_uri') || '';
          const verifier = params.get('code_verifier') || '';
          const record = authCodes.get(code);
          authCodes.delete(code);
          if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId || record.redirectUri !== redirectUri) {
            return jsonResponse(res, 400, { error: 'invalid_grant' });
          }
          if (!verifyPkceS256(verifier, record.codeChallenge)) {
            return jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
          }
          return jsonResponse(res, 200, issueTokens(clientId, record.scope));
        }

        if (grantType === 'refresh_token') {
          const refresh = params.get('refresh_token') || '';
          const hash = sha256Hex(refresh);
          const record = state.refreshTokens[hash];
          if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId) {
            return jsonResponse(res, 400, { error: 'invalid_grant' });
          }
          delete state.refreshTokens[hash];
          return jsonResponse(res, 200, issueTokens(clientId, record.scope, record.authorizationId));
        }

        return jsonResponse(res, 400, { error: 'unsupported_grant_type' });
      }

      if (pathname === '/mcp') {
        const token = authenticateBearer(req);
        if (!token) {
          return jsonResponse(
            res,
            401,
            { error: 'unauthorized', error_description: 'Valid OAuth access token required.' },
            { 'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="mcp:tools"` }
          );
        }
        if (req.method === 'GET' || req.method === 'DELETE') {
          res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        const raw = await readBody(req, MAX_BODY_BYTES);
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { return jsonResponse(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        const batch = Array.isArray(parsed);
        const messages = batch ? parsed : [parsed];
        const replies = await forwardMcpMessages(messages, req.headers['mcp-session-id'], token);
        if (!replies.length) {
          res.writeHead(202);
          res.end();
          return;
        }
        return jsonResponse(res, 200, batch ? replies : replies[0]);
      }

      jsonResponse(res, 404, { error: 'not_found' });
    } catch (error) {
      const status = error?.statusCode || 500;
      jsonResponse(res, status, { error: 'server_error', error_description: error?.message || 'Internal error' });
    }
  });
}

if (require.main === module) {
  const host = process.env.LISTEN_HOST || '127.0.0.1';
  const port = Number(process.env.LISTEN_PORT || 18080);
  const server = createGatewayServer({
    issuer: process.env.ISSUER || 'https://mcp.ptrees.org',
    resourceUrl: process.env.RESOURCE_URL,
    allowedTools: process.env.ALLOWED_TOOLS,
    directoryAccessEnabled: process.env.DIRECTORY_ACCESS_ENABLED === '1',
    authPasswordHash: process.env.AUTH_PASSWORD_HASH,
    staticClientId: process.env.STATIC_CLIENT_ID,
    staticClientSecretHash: process.env.STATIC_CLIENT_SECRET_HASH,
    stateFile: process.env.STATE_FILE || '/data/oauth-state.json',
    tunnelEnvFile: process.env.TUNNEL_ENV_FILE || '/run/windows-mcp/tunnel.env',
    upstreamUrl: process.env.WINDOWS_MCP_URL,
    upstreamSecret: process.env.WINDOWS_MCP_SECRET,
  });
  server.listen(port, host, () => {
    console.log(`MCP OAuth gateway listening on http://${host}:${port}`);
  });
}

module.exports = { createGatewayServer, sha256Hex, parseSseJsonRpc, verifyPkceS256 };
