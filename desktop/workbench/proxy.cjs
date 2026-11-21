const crypto = require('node:crypto');
const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
function settings(value = {}) {
  const mode = value.mode || 'system';
  if (!['system', 'direct', 'custom'].includes(mode)) throw new Error('Choose a supported location proxy mode.');
  if (mode !== 'custom') return { mode, url: '' };
  let url = String(value.url || '').trim();
  if (url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error('Enter an HTTP or HTTPS proxy URL without credentials or a path.');
    url = parsed.origin;
  }
  if (mode === 'custom' && !url) throw new Error('Enter the location proxy URL.');
  return { mode, url };
}
function policy(location, role = {}) {
  const override = role.proxyMode || 'inherit';
  if (!['inherit', 'direct', 'proxy'].includes(override)) throw new Error('Choose a supported role proxy mode.');
  if (override === 'direct') return { mode: 'direct', url: '' };
  const result = settings(location.proxy);
  if (override === 'proxy' && result.mode === 'direct') throw new Error('Configure a system or custom proxy on this location first.');
  return result;
}
function environment(env, value) {
  const result = { ...env }, config = settings(value);
  if (config.mode === 'system') return result;
  for (const key of keys) delete result[key];
  result.NO_PROXY = result.no_proxy = config.mode === 'direct' ? '*' : 'localhost,127.0.0.1,::1';
  if (config.mode === 'custom') for (const key of keys.slice(0, 6)) result[key] = config.url;
  return result;
}
class ProxyRouter {
  constructor(store, electron) { this.store = store; this.electron = electron; this.sessions = new Map(); }
  policy(role) { return policy(this.store.get('locations', role.locationId), role); }
  async fetchFor(role) {
    const location = this.store.get('locations', role.locationId);
    if (location.type !== 'local') throw new Error('Remote provider requests must run on the remote location.');
    const config = this.policy(role);
    const id = crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 24);
    if (!this.sessions.has(id)) this.sessions.set(id, (async () => {
      const session = this.electron.session.fromPartition('relay-provider-' + id);
      await session.setProxy(config.mode === 'custom' ? { mode: 'fixed_servers', proxyRules: config.url, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' } : { mode: config.mode });
      return session;
    })().catch(error => { this.sessions.delete(id); throw error; }));
    const session = await this.sessions.get(id);
    return (input, options) => session.fetch(input, { ...options, credentials: 'omit' });
  }
  async environmentFor(role, env) {
    const location = this.store.get('locations', role.locationId); let config = this.policy(role);
    if (location.type === 'local' && config.mode === 'system') {
      const target = role.baseUrl || (role.engine==='antigravity'?'https://daily-cloudcode-pa.googleapis.com':role.provider === 'gemini' ? 'https://generativelanguage.googleapis.com' : role.provider === 'deepseek' ? 'https://api.deepseek.com' : role.provider === 'moonshot' || role.engine==='kimi' ? 'https://api.moonshot.cn' : role.engine==='cursor'?'https://api2.cursor.sh': ['workbuddy','codebuddy'].includes(role.engine)?'https://www.codebuddy.cn':role.engine === 'claude' ? 'https://api.anthropic.com' : 'https://chatgpt.com');
      const selection = (await this.electron.app.resolveProxy(target)).split(';')[0].trim();
      const match = /^(PROXY|HTTP|HTTPS)\s+(.+)$/i.exec(selection);
      if (match) config = { mode: 'custom', url: (match[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://') + match[2] };
      else if (selection === 'DIRECT') config = { mode: 'direct', url: '' };
      else throw new Error('The system proxy is not HTTP/HTTPS. Configure an HTTP proxy on the local location for native agents.');
    }
    return environment(env, config);
  }
}
module.exports = { settings, policy, environment, ProxyRouter };
