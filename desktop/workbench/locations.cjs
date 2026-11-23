const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('ssh2');
const { atomic } = require('./store.cjs');
const { shellQuote, configFromEnv, knownHostKeys, hostMatches } = require('../config.cjs');
const { StringDecoder } = require('node:string_decoder');

function execOn(client, command, timeout) {
  return new Promise((resolve, reject) => client.exec(command, (error, stream) => {
    if (error) { reject(error); return; }
    let data = ''; let errors = ''; let size = 0;
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => { stream.close(); reject(new Error('SSH operation timed out.')); }, timeout);
    stream.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { stream.close(); reject(new Error('SSH output limit exceeded.')); }
      else data += decoder.write(chunk);
    });
    stream.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-2000); });
    stream.on('error', e => { clearTimeout(timer); reject(e); });
    stream.on('close', code => { clearTimeout(timer); code === 0 ? resolve(data + decoder.end()) : reject(new Error(errors || 'SSH command failed.')); });
  }));
}
class Vault {
  constructor(directory, safeStorage) { this.file = path.join(directory, 'secrets.json'); this.safeStorage = safeStorage; this.values = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}; }
  has(id) { return Boolean(this.values[id]); }
  set(id, value) {
    if (!value) return;
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable.');
    this.values[id] = this.safeStorage.encryptString(value).toString('base64'); atomic(this.file, this.values);
  }
  get(id) { return this.values[id] ? this.safeStorage.decryptString(Buffer.from(this.values[id], 'base64')) : ''; }
  remove(id) { delete this.values[id]; atomic(this.file, this.values); }
}
class Locations {
  constructor(store, vault, backend, confirmHost, emit) {
    Object.assign(this, { store, vault, backend, confirmHost, emit }); this.clients = new Map(); this.pending = new Map();
    this.knownFile = path.join(store.directory, 'ssh-hosts.json');
    this.known = fs.existsSync(this.knownFile) ? JSON.parse(fs.readFileSync(this.knownFile, 'utf8')) : {};
  }
  status() { return Object.fromEntries(this.store.state.locations.map(l => [l.id, l.type === 'local' ? 'ready' : l.managed ? (this.backend.status.ssh === 'ready' ? 'ready' : 'offline') : this.clients.has(l.id) ? 'ready' : this.pending.has(l.id) ? 'connecting' : 'offline'])); }
  async connect(id) {
    const location = this.store.get('locations', id);
    if (location.type === 'local') return null;
    if (location.managed) { await this.backend.connect(this.vault.get('ssh:' + id)); return this.backend.client; }
    if (this.clients.has(id)) return this.clients.get(id);
    if (this.pending.has(id)) return this.pending.get(id);
    const task = this.open(location).finally(() => { this.pending.delete(id); this.emit(); });
    this.pending.set(id, task); this.emit(); return task;
  }
  async open(location) {
    const client = new Client(); const hostKey = `[${location.host}]:${location.port}`;
    client.on('tcp connection',(details,accept,reject)=>{if(!require('../reverse-routes.cjs').route(client,details,accept,reject))reject();});
    let changed = false;
    await new Promise((resolve, reject) => {
      client.once('ready', resolve).once('error', reject);
      const credentials = location.keyPath ? { privateKey: fs.readFileSync(location.keyPath), passphrase: this.vault.get('ssh:' + location.id) || undefined } : { agent: process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent' };
      client.connect({ host: location.host, port: location.port, username: location.username, ...credentials, readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        hostVerifier: (key, callback) => {
          const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          if (this.known[hostKey]) { changed = this.known[hostKey] !== fingerprint; callback(!changed); return; }
          this.confirmHost(location, fingerprint).then(accepted => {
            if (accepted) { this.known[hostKey] = fingerprint; atomic(this.knownFile, this.known); }
            callback(accepted);
          }).catch(() => callback(false));
        } });
    }).catch(error => { client.end(); throw new Error(changed ? 'SSH host key changed. Verify the new fingerprint before reconnecting.' : error.message); });
    this.clients.set(location.id, client);
    client.on('close', () => { if (this.clients.get(location.id) === client) this.clients.delete(location.id); this.emit(); });
    client.on('error', () => {}); this.emit(); return client;
  }
  disconnect(id) { const client = this.clients.get(id); this.clients.delete(id); client?.end(); this.emit(); }
  async exec(id, command, timeout = 20000) {
    return execOn(await this.connect(id), command, timeout);
  }
  async readSkillCatalog(id, command) {
    const location = this.store.get('locations', id);
    if (!location.managed) return this.exec(id, command);
    if (this.backend.status.ssh === 'ready' && this.backend.client) return execOn(this.backend.client, command, 20000);

    const cfg = configFromEnv(this.backend.root);
    const trusted = knownHostKeys(cfg);
    const client = new Client();
    try {
      await new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.on('error', reject);
        client.connect({ host: cfg.host, port: cfg.sshPort, username: cfg.username,
          privateKey: fs.readFileSync(cfg.keyPath), passphrase: this.vault.get('ssh:' + id) || undefined,
          hostVerifier: key => hostMatches(key, trusted), readyTimeout: 15000 });
      });
      return await execOn(client, command, 20000);
    } finally { client.end(); }
  }
  async ensureProjectDirectory(id, folder, home) {
    if (typeof folder !== 'string' || !/^(?:\/|~\/)/.test(folder) || /[\0\r\n]/.test(folder)) {
      throw new Error('VPS 项目目录必须以 / 或 ~/ 开头。');
    }
    const location = this.store.get('locations', id);
    const useHome = folder.startsWith('~/');
    if (useHome && (typeof home !== 'string' || !home.startsWith('/') || /[\0\r\n]/.test(home))) {
      throw new Error(`无法确认 ${location.name} 的 SSH 用户主目录。请检查连接或填写绝对路径。`);
    }
    const target = useHome ? home.replace(/\/$/, '') + '/' + folder.slice(2) : folder;
    const quotedTarget = shellQuote(target);
    try {
      await this.exec(id, `umask 077; mkdir -p -- ${quotedTarget} && test -x ${quotedTarget}`);
    } catch (error) {
      throw new Error(`无法在 ${location.name} 创建或访问项目目录 ${folder}。请检查路径及 SSH 用户的目录权限。`, { cause: error });
    }
    return target;
  }
  async runner(id, projectDirectory) {
    const client = await this.connect(id);
    const home = (await this.exec(id, 'printf %s "$HOME"')).trim();
    const cwd = await this.ensureProjectDirectory(id, projectDirectory, home);
    const directory = home + '/.local/share/relay-desk';
    await this.exec(id, `umask 077; mkdir -p ${shellQuote(directory)}`);
    const sftp = await new Promise((resolve, reject) => client.sftp((e, s) => e ? reject(e) : resolve(s)));
    try {
      for(const [source,name] of [['native-history.py','native_history.py'],['run-agent.py','run-agent.py']]){
        const temporary=directory+'/'+name+'.'+crypto.randomUUID();
        await new Promise((resolve,reject)=>sftp.fastPut(path.join(__dirname,source),temporary,{mode:0o700},e=>e?reject(e):resolve()));
        await this.exec(id,'mv -f -- '+shellQuote(temporary)+' '+shellQuote(directory+'/'+name));
      }
    } finally { sftp.end(); }
    return { client, file: directory + '/run-agent.py', home, cwd };
  }
  async catalog(id, engine, proxy) {
    if (!['claude', 'codex'].includes(engine)) throw new Error('This managed location supports Claude and Codex model catalogs.');
    const client = await this.connect(id);
    const home = (await this.exec(id, 'printf %s "$HOME"')).trim();
    const directory = home + '/.local/share/relay-desk';
    await this.exec(id, 'umask 077; mkdir -p ' + shellQuote(directory));
    const target = directory + '/read-model-catalog.py', temporary = target + '.' + crypto.randomUUID();
    const sftp = await new Promise((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)));
    try { await new Promise((resolve, reject) => sftp.fastPut(path.join(__dirname, '../../server/read-model-catalog.py'), temporary, { mode: 0o700 }, error => error ? reject(error) : resolve())); }
    finally { sftp.end(); }
    await this.exec(id, 'mv -f -- ' + shellQuote(temporary) + ' ' + shellQuote(target));
    const result = await this.exec(id, 'printf %s ' + shellQuote(JSON.stringify(proxy || {})) + ' | python3 ' + shellQuote(target) + ' ' + engine + ' --proxy-stdin', 40000);
    return JSON.parse(result);
  }
  close() { for (const id of this.clients.keys()) this.disconnect(id); }
}
module.exports = { Vault, Locations };
