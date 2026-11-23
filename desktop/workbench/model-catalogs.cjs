const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { atomic } = require('./store.cjs');
const { cleanEnv, findExecutable } = require('./agents.cjs');
const { fileAuthArgs } = require('./native-auth.cjs');
const { usesDesktopLogin, sharedProcessArgs } = require('./desktop-login.cjs');
const vendors = require('./vendor-agents.cjs');
const { AcpClient } = require('./acp-client.cjs');
const { spawn: spawnAgent } = require('node:child_process');
const remoteAntigravity = require('./remote-antigravity.cjs');
const bases = { openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai', deepseek: 'https://api.deepseek.com', moonshot:'https://api.moonshot.cn/v1' };
async function queryVendor(role,home,cwd,env) {
  const entry=findExecutable(role),launch=vendors.launch(entry,vendors.args({...role,model:'',effort:''}),env);
  const child=spawnAgent(launch.command,launch.args,{cwd,env:launch.env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  const client=new AcpClient(child,{text:''},()=>{},role);
  try {
    await client.initialize();
    const session = await client.session(cwd, {});
    if (role.engine === 'cursor') {
      try {
        const { models } = await client.call('cursor/list_available_models', {});
        if (Array.isArray(models) && models.length) return models.map(model => ({
          id: model.value, label: model.name, isDefault: model.value === 'default',
          parameters: cursorParameters(model.configOptions),
        }));
      } catch (error) {
        if (error.rpcCode !== -32601) throw error;
      }
    }
    return vendorModels(session, role.engine);
  } finally {client.close();await vendors.stop(child);}
}
function cursorParameters(options) {
  return (Array.isArray(options) ? options : []).filter(option =>
    option?.type === 'select' && ['thought_level', 'model_config'].includes(option.category) &&
    /^[\w-]+$/.test(option.id) && Array.isArray(option.options)
  ).map(option => ({
    id: option.id, category: option.category, defaultValue: option.currentValue,
    values: option.options.map(choice => choice.value).filter(value => typeof value === 'string' && /^[\w.-]+$/.test(value)),
  }));
}
function vendorModels(session, engine) {
  const direct = session.models?.availableModels;
  const selection = (session.configOptions || []).find(option => option.category === 'model' || option.id === 'model');
  if (Array.isArray(direct) && (engine !== 'antigravity' || !selection)) {
    return direct.map(model => ({ id: model.modelId, label: model.name, description: model.description }));
  }
  return (selection?.options || []).flatMap(item => item.options || [item]).map(model => ({ id: model.value, label: model.name }));
}
function normalize(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).filter(entry => entry && !entry.hidden).map(entry => {
    const id=String(entry.model || entry.id || entry.value || '');
    const levels=entry.efforts ?? entry.supportedEffortLevels ?? entry.supportedReasoningEfforts;
    const efforts=Array.isArray(levels) ? [...new Set(levels.map(level=>level?.reasoningEffort ?? level).filter(level=>typeof level==='string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)))] : undefined;
    const defaultEffort=entry.defaultEffort || entry.defaultEffortLevel || entry.defaultReasoningEffort;
    return {
      id, label:String(entry.label || entry.displayName || id).slice(0,200), description:String(entry.description || '').slice(0,600),
      ...(entry.resolvedModel ? {resolvedModel:String(entry.resolvedModel).slice(0,200)} : {}),
      ...(entry.isDefault || entry.value==='default' ? {isDefault:true} : {}),
      ...(efforts ? {efforts,defaultEffort:efforts.includes(defaultEffort)?defaultEffort:''} : {}),
      ...(Array.isArray(entry.parameters) ? { parameters: entry.parameters } : {}),
    };
  }).filter(entry => entry.id && entry.id.length <= 200 && !/[\s\x00-\x1f]/.test(entry.id) && !seen.has(entry.id) && seen.add(entry.id)).slice(0, 500);
}
function queryCli(role, home, cwd, proxyEnvironment) {
  if(vendors.isVendor(role.engine))return queryVendor(role,home,cwd,proxyEnvironment || vendors.environment(role,cleanEnv(home)));
  if (!['codex', 'claude'].includes(role.engine)) return Promise.reject(new Error('This native agent does not expose a supported model catalog. Enter a model ID manually.'));
  const executable = findExecutable(role);
  if (/\.cmd$/i.test(executable)) return Promise.reject(new Error('Select a native agent executable to read its model catalog.'));
  const env = proxyEnvironment || cleanEnv(home);
  for (const folder of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) if (!usesDesktopLogin(role) || folder !== env.CODEX_HOME) fs.mkdirSync(folder, { recursive: true });
  const args = role.engine === 'codex' ? [...(usesDesktopLogin(role) ? sharedProcessArgs : fileAuthArgs), 'app-server', '--listen', 'stdio://', '-c', 'check_for_update_on_startup=false', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false'] :
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const decoder = new StringDecoder('utf8'); let buffer = '', size = 0, done = false, requestId = 2; const entries = [];
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); child.stdin.end(); child.kill(); error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('The native model catalog timed out. Check agent installation and login.')), 25000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('Could not start the native agent model catalog.')));
    child.on('exit', () => { if (!done) finish(new Error('The native agent closed before returning its model catalog.')); });
    child.stdout.on('data', chunk => {
      if (done) return;
      size += chunk.length; if (size > 2 * 1024 * 1024) { finish(new Error('Model catalog exceeded its size limit.')); return; }
      buffer += decoder.write(chunk);
      try {
        let index;
        while ((index = buffer.indexOf('\n')) >= 0 && !done) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (role.engine === 'claude') {
            if (message.type !== 'control_response' || message.response?.request_id !== 'catalog') continue;
            if (message.response.subtype === 'error') throw new Error('Native model discovery failed. Check agent installation and login.');
            finish(null, message.response.response?.models || []);
          } else if (message.id === 1 || message.id === requestId) {
            if (message.error) throw new Error('Native model discovery failed. Check agent installation and login.');
            if (message.id === 1) { send({ method: 'initialized', params: {} }); send({ id: requestId, method: 'model/list', params: { limit: 100, includeHidden: false } }); }
            else {
              entries.push(...(message.result?.data || []));
              if (message.result?.nextCursor && entries.length < 500) send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false, cursor: message.result.nextCursor } });
              else finish(null, entries);
            }
          }
        }
      } catch (error) { finish(error); }
    });
    send(role.engine === 'claude' ? { type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } } : { id: 1, method: 'initialize', params: { clientInfo: { name: 'relay_desk', version: '0.1.0' } } });
  });
}
class ModelCatalogs {
  constructor({ directory, store, vault, locations, backend, agents, network, fetch: request = fetch, native = queryCli }) {
    Object.assign(this, { directory, store, vault, locations, backend, agents, network, fetch: request, native }); this.pending = new Map();
    this.file = path.join(directory, 'model-catalogs.json');
    try { this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.cache = {}; }
  }
  async request(input, { force = false, cacheOnly = false } = {}) {
    const draft = typeof input === 'string' ? { ...this.store.get('roles', input) } : input;
    if (!draft || (!['codex', 'claude', 'opencode'].includes(draft.engine) && !vendors.isVendor(draft.engine)) || !['native', ...Object.keys(bases)].includes(draft.provider)) throw new Error('Choose a supported agent and provider first.');
    const saved = draft.id ? this.store.get('roles', draft.id) : null;
    const location = this.store.get('locations', draft.locationId);
    if (draft.provider !== 'native' && (draft.engine !== 'codex' || location.type !== 'local')) throw new Error('API model catalogs currently require a local Codex role.');
    const base = String(draft.baseUrl || bases[draft.provider] || '').trim().replace(/\/+$/, '');
    if (draft.provider !== 'native') {
      const url = new URL(base); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS provider URL without embedded credentials.');
    }
    const key = String(draft.apiKey || (saved?.provider === draft.provider ? this.vault.get('api:' + saved.id) || '' : '')).trim();
    if (draft.provider !== 'native' && !key) throw new Error('Enter an API key to load models. The role does not need to be saved first.');
    const proxy = this.network?.policy(draft);
    const connection=[location.type,location.host,location.port,location.username,location.keyPath];
    const loginScope = vendors.supportsRemote(draft.engine, location) ? require('./native-sessions.cjs').loginScope(draft, location) : '';
    const loginEpoch = loginScope ? this.store.state.nativeLoginEpochs?.[loginScope] || 0 : undefined;
    const cacheKey = [draft.id || 'new', draft.engine, draft.provider, location.id, base, draft.executable || '', key, proxy, draft.codexLoginSource || 'isolated', usesDesktopLogin(draft) ? this.agents.desktopHome() : '', connection];
    if (loginScope) cacheKey.push(loginEpoch);
    const digest = crypto.createHash('sha256').update(JSON.stringify(cacheKey)).digest('hex');
    const cached = this.cache[digest];
    if (cacheOnly) return {models:cached?.models || [], cached:true};
    if (!force && cached?.models?.length && (draft.engine !== 'cursor' || cached.cursorParameters === 1)) {
      return { ...cached, cached: true };
    }
    if (this.pending.has(digest)) return this.pending.get(digest);
    const work = (async () => {
      try {
        let entries;
        if (draft.provider !== 'native') {
          const request = this.network ? await this.network.fetchFor(draft) : this.fetch;
          const response = await request(base + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000), redirect: 'error' });
          if (!response.ok) throw new Error('Model list request failed (HTTP ' + response.status + '). Check the key and provider URL.');
          const body = await response.text(); if (body.length > 2 * 1024 * 1024) throw new Error('Model catalog exceeded its size limit.');
          entries = JSON.parse(body).data;
        } else if (vendors.supportsRemote(draft.engine, location)) {
          try {
            entries = vendorModels(await remoteAntigravity.probe(this.locations, location, draft, proxy), draft.engine);
          } catch (error) {
            if (error.code === 'VENDOR_LOGIN_REQUIRED') throw new Error('请先点击「配置并登录 VPS」完成 Google 授权，再读取模型。');
            throw error;
          }
        } else if (location.managed) {
          if (this.network) entries = (await this.locations.catalog(location.id, draft.engine, proxy)).models;
          else { await this.locations.connect(location.id); await this.backend.refreshModels(); entries = this.backend.catalog[draft.engine]?.models; }
        } else if (location.type === 'local') {
          const home = draft.id ? this.agents.home(draft) : path.join(this.directory, 'catalog-preview');
          const cwd = path.join(this.directory, 'catalog-cwd'); fs.mkdirSync(cwd, { recursive: true });
          let env = this.agents.environment ? this.agents.environment(draft, home) : cleanEnv(home);
          if (this.network) env = await this.network.environmentFor(draft, env);
          entries = await this.native(draft, home, cwd, env);
        } else throw new Error('This SSH location has no model-catalog adapter. Enter a model ID manually.');
        const models = normalize(entries);
        if (!models.length) throw new Error('The provider returned no selectable models. A model ID can still be entered manually.');
        const result = { models, updatedAt: Date.now(), source: draft.provider === 'native' ? 'cli' : 'api',
          ...(draft.engine === 'cursor' ? { cursorParameters: 1 } : {}) };
        this.cache[digest] = result;
        const retained = Object.entries(this.cache).sort((a,b) => b[1].updatedAt - a[1].updatedAt).slice(0, 64);
        this.cache = Object.fromEntries(retained); atomic(this.file, this.cache);
        return { ...result, cached: false };
      } catch (error) {
        const message = error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name) || /net::ERR_|fetch failed/i.test(error.message) ? 'Could not connect to the model provider. Check the system proxy or network connection.' : error instanceof SyntaxError ? 'The model provider returned an invalid catalog response.' : error.message;
        if (cached?.models?.length) return { ...cached, cached: true, warning: message };
        throw new Error(message);
      }
    })();
    this.pending.set(digest, work);
    try { return await work; } finally { this.pending.delete(digest); }
  }
}
module.exports = { ModelCatalogs, normalize, queryCli };
