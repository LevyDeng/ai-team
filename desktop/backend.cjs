const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Client } = require('ssh2');
const { StringDecoder } = require('node:string_decoder');
const { configFromEnv, knownHostKeys, hostMatches, shellQuote } = require('./config.cjs');
const { normalizeCatalog, selection } = require('./models.cjs');
const { maxImageBytes, imageNamePattern } = require('./clipboard-images.cjs');
const crypto = require('node:crypto');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

class Backend extends EventEmitter {
  constructor(root, { shareControlMode = false } = {}) {
    super();
    this.root = root;
    this.shareControlMode = shareControlMode;
    this.status = { mcp: 'unknown', ssh: 'off', tunnel: 'unknown', mcpOwned: false, tunnelOwned: false };
    this.client = null;
    this.service = null;
    this.localPort = null;
    this.remotePort = null;
    this.forceControl = false;
    this.appliedForceControl = null;
    this.controlChanging = false;
    this.controlError = '';
    this.usage = Object.fromEntries(['claude', 'codex'].map((provider) => [provider, { provider, state: 'pending', windows: [], reason: 'not_loaded', loading: false }]));
    this.usagePending = new Map();
    this.usageLastAttempts = new Map();
    this.usageProvider = 'claude';
    this.usageTimer = setInterval(() => {
      if (this.status.ssh === 'ready' && this.status.tunnel === 'ready') this.refreshUsage(this.usageProvider).catch((error) => this.log(`Usage refresh: ${error.message}`));
    }, 30000);
    this.usageTimer.unref();
    this.catalog = { claude: { models: [], updatedAt: null, error: '' }, codex: { models: [], updatedAt: null, error: '' }, loading: false };
    this.catalogPath = path.join(root, '.runtime', 'desktop', 'models.json');
    try {
      const cached = JSON.parse(fs.readFileSync(this.catalogPath, 'utf8'));
      for (const provider of ['claude', 'codex']) {
        try { this.catalog[provider] = { ...normalizeCatalog(cached[provider]), cached: true, error: '' }; } catch {}
      }
    } catch {}
    this.channels = new Map();
    this.knownSessions = new Map();
    this.monitor = { resources: null, sessions: {}, receivedAt: null, error: '' };
    this.pendingTaskStarts = new Map();
    this.logs = [];
    this.generation = 0;
    this.connecting = null;
    this.startupCleanedServers = new Set();
    this.healthBusy = false;
    this.healthTimer = setInterval(() => this.healthCheck(), 15000);
    this.healthTimer.unref();
    this.completionTokens = new Map();
    this.statusCursors = new Map();
    this.completionBusy = false;
    this.completionTimer = setInterval(() => this.checkCompletions(), 4000);
    this.completionTimer.unref();
  }
  update(change) { Object.assign(this.status, change); this.emit('status', this.snapshot()); }
  snapshot() {
    let connection = {};
    try {
      const cfg = configFromEnv(this.root);
      connection = { host: cfg.host, username: cfg.username, sshPort: cfg.sshPort, localPort: this.localPort || cfg.localPort, remotePort: this.remotePort || cfg.remotePort, maxSessions: cfg.maxSessions };
    } catch (error) { connection.error = error.message; }
    return { ...this.status, sessionConnections: this.sessionConnections(), settingsChanging: Boolean(this.settingsChanging), connection, catalog: this.catalog, usage: this.usage, monitor: this.monitor, control: { requested: this.forceControl, applied: this.appliedForceControl, changing: this.controlChanging, error: this.controlError }, logs: this.logs.slice(-80) };
  }
  sessionConnections() {
    if (!this.client || this.status.ssh !== 'ready') return [];
    return [...this.channels].filter(([, channel]) => !channel.finished && !channel.stream.destroyed && !channel.stream.writableEnded)
      .map(([id, channel]) => ({ id, provider: channel.provider, owner: channel.owner }));
  }
  log(text) {
    let clean = String(text).replace(/\x1b\[[0-9;]*m/g, '').trim();
    try { clean = clean.replaceAll(configFromEnv(this.root).secret, '[redacted]'); } catch {}
    if (!clean) return;
    this.logs.push(`${new Date().toLocaleTimeString()}  ${clean.slice(0, 3000)}`);
    if (this.logs.length > 150) this.logs.shift();
    this.emit('log', this.logs.at(-1));
  }
  probe(port, remote = false) {
    const cfg = configFromEnv(this.root);
    if (remote) {
      return new Promise((resolve, reject) => {
        if (!this.client) return reject(new Error('SSH is disconnected.'));
        this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error, channel) => {
          if (error) return reject(error);
          let response = '', done = false;
          const finish = (error) => {
            if (done) return;
            done = true; clearTimeout(timer); channel.destroy();
            if (error) reject(error); else resolve(true);
          };
          const timer = setTimeout(() => finish(new Error('Remote MCP health check timed out.')), 8000);
          channel.on('data', (chunk) => {
            response += chunk;
            if (response.length > 300000) return finish(new Error('Unexpected MCP response.'));
            if (response.includes('\r\n') && !/^HTTP\/1\.[01] 200 /.test(response)) return finish(new Error('Remote port does not provide an authenticated MCP endpoint.'));
            if (/^HTTP\/1\.[01] 200 /.test(response) && response.includes('serverInfo')) finish();
          });
          channel.on('end', () => finish(new Error(`Remote MCP health check failed (${response.split('\r\n')[0] || 'empty response'}). Check the tunnel and both .env secrets.`)));
          channel.on('error', finish);
          const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ai-team-health', version: '0.1.0' } } });
          channel.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${cfg.secret}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        });
      });
    }
    return new Promise((resolve, reject) => {
      const agent = new http.Agent({ keepAlive: false });
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ai-team-health', version: '0.1.0' } } });
      const request = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent, headers: { Authorization: `Bearer ${cfg.secret}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; if (text.length > 300000) response.destroy(); });
        response.on('end', () => {
          agent.destroy();
          if (response.statusCode === 200 && text.includes('serverInfo')) resolve(true);
          else reject(new Error(`MCP health check returned HTTP ${response.statusCode}. Check that both .env secrets match.`));
        });
        response.on('error', reject);
      });
      request.setTimeout(8000, () => request.destroy(new Error('MCP health check timed out.')));
      request.on('error', (error) => { agent.destroy(); reject(error); });
      request.end(body);
    });
  }
  async readControlMode(port) {
    const cfg = configFromEnv(this.root);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ControlStatus', arguments: {} } });
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false, headers: { Authorization: `Bearer ${cfg.secret}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; if (text.length > 200000) response.destroy(new Error('Unexpected control status response.')); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('The MCP service did not provide control status.');
            const payloads = text.trim().startsWith('{') ? [JSON.parse(text)] : text.split(/\r?\n\r?\n/).flatMap((event) => {
              const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
              return data ? [JSON.parse(data)] : [];
            });
            const message = payloads.find((value) => value.id === 2);
            if (!message?.result || message.error || message.result.isError) throw new Error('The MCP service did not provide control status.');
            const value = message.result.structuredContent || JSON.parse((message.result.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
            if (value.enabled === false || value.state === 'disabled') resolve(true);
            else if (value.enabled === true || typeof value.state === 'string') resolve(false);
            else throw new Error('Unexpected MCP control status.');
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(8000, () => request.destroy(new Error('MCP control status timed out.')));
      request.on('error', reject);
      request.end(body);
    });
  }
  async setForceControl(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid desktop control setting.');
    if (this.controlChanging || this.connecting || this.status.mcp === 'starting') throw new Error('Wait for the current service startup to finish.');
    if (this.status.mcp === 'ready' && !this.service) throw new Error('The MCP service belongs to another launcher. Close that launcher and reconnect from ai-team to change control mode.');
    if (this.status.tunnel === 'ready' && !this.status.tunnelOwned) throw new Error('The tunnel belongs to another launcher. Close that launcher and reconnect from ai-team to change control mode.');
    this.forceControl = enabled;
    this.controlError = '';
    if (!this.service) { this.appliedForceControl = null; this.update({}); return this.snapshot(); }
    const generation = this.generation;
    this.controlChanging = true;
    this.update({});
    try {
      const proc = this.service;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The local MCP service did not stop in time.')), 6000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        proc.kill();
      });
      // Job-object child cleanup can finish shortly after the launcher exits.
      for (let attempt = 0; attempt < 30; attempt++) {
        if (generation !== this.generation) throw new Error('Connection canceled.');
        const occupied = await new Promise((resolve) => {
          const socket = net.connect({ host: '127.0.0.1', port: this.localPort });
          const finish = (value) => { socket.destroy(); resolve(value); };
          socket.once('connect', () => finish(true));
          socket.once('error', () => finish(false));
          socket.setTimeout(200, () => finish(true));
        });
        if (!occupied) break;
        if (attempt === 29) throw new Error('The previous MCP listener is still closing. Try again shortly.');
        await sleep(100);
      }
      if (generation !== this.generation) throw new Error('Connection canceled.');
      await this.startMcp();
      if (generation !== this.generation) throw new Error('Connection canceled.');
      if (this.client && this.status.tunnel === 'ready') await this.probe(this.remotePort, true);
      this.log(enabled ? 'Desktop input no longer waits for user inactivity. Physical and AI input can overlap.' : 'Cooperative desktop input protection restored.');
    } catch (error) {
      this.controlError = error.message;
      this.update({ mcp: this.service ? 'error' : 'off' });
      throw error;
    } finally { this.controlChanging = false; this.update({}); }
    return this.snapshot();
  }
  async startMcp() {
    const generation = this.generation;
    const cfg = configFromEnv(this.root);
    const port = this.localPort || cfg.localPort;
    let existing = false;
    try { await this.probe(port); existing = true; }
    catch (error) {
      if (this.service) throw new Error(`The managed MCP service on port ${port} is unavailable: ${error.message}`);
      if (!['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) this.log(`Local port ${port} is not a usable MCP endpoint. Selecting an available port.`);
    }
    if (generation !== this.generation) throw new Error('Connection canceled.');
    if (existing) {
      const applied = await this.readControlMode(port);
      if (generation !== this.generation) throw new Error('Connection canceled.');
      if (applied !== this.forceControl) {
        if (!this.shareControlMode || this.service) throw new Error('The existing MCP control mode differs from your selection. Close its launcher and reconnect from ai-team.');
        this.forceControl = applied;
        this.log('Following the existing MCP service desktop control mode so both interfaces can share it.');
      }
      this.appliedForceControl = applied;
      this.localPort = port;
      this.update({ mcp: 'ready', mcpOwned: Boolean(this.service) });
      if (!this.service) this.log('Using the existing local MCP service. Its original launcher remains in control.');
      return;
    }
    if (this.service) throw new Error('The local MCP service is still starting.');
    this.update({ mcp: 'starting' });
    const launcherArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.root, 'Start-WindowsMcp.ps1'), '-ServiceOnly', '-PreferredLocalPort', String(port)];
    if (this.forceControl) launcherArgs.push('-ForceControl');
    const proc = spawn('powershell.exe', launcherArgs, { cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.service = proc;
    this.localPort = null;
    this.appliedForceControl = null;
    this.update({ mcpOwned: true });
    let failure = '';
    let output = '';
    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const lines = output.split(/\r?\n/);
      output = lines.pop();
      for (const line of lines) {
        const match = /^MCP_PORT=(\d+)$/.exec(line.trim());
        if (match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535 && this.service === proc) {
          this.localPort = Number(match[1]);
          this.update({});
        }
      }
    });
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (text) => { failure = (failure + text).slice(-4000); this.log(text); });
    }
    proc.on('error', (error) => {
      failure = error.message;
      if (this.service === proc) { this.service = null; this.update({ mcp: 'off', mcpOwned: false }); }
      this.log(error.message);
    });
    proc.on('exit', (code) => {
      if (this.service === proc) {
        this.service = null;
        this.appliedForceControl = null;
        this.update({ mcp: 'off', mcpOwned: false });
        this.log(`Local MCP launcher stopped (${code}).`);
      }
    });
    for (let i = 0; i < 600; i++) {
      if (generation !== this.generation) throw new Error('Connection canceled.');
      if (this.service !== proc || proc.exitCode !== null) {
        let details = '';
        try { details = fs.readFileSync(path.join(this.root, 'logs', `mcp-${this.localPort || cfg.localPort}.err.log`), 'utf8').slice(-6000); } catch {}
        if (details.includes('No active interactive desktop')) throw new Error('Windows MCP needs an unlocked interactive desktop. Unlock Windows and launch ai-team from your desktop.');
        throw new Error(failure || 'MCP launcher stopped. Open the MCP logs for details.');
      }
      if (this.localPort) {
        let ready = false;
        try { await this.probe(this.localPort); ready = true; } catch {}
        if (ready) {
          const applied = await this.readControlMode(this.localPort);
          if (generation !== this.generation) throw new Error('Connection canceled.');
          this.appliedForceControl = applied;
          if (applied !== this.forceControl) throw new Error('MCP did not apply the selected desktop control mode.');
          this.update({ mcp: 'ready' });
          return;
        }
      }
      await sleep(1000);
    }
    throw new Error('MCP startup timed out. See the service log.');
  }
  exec(command, timeout = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Connect to the server first.'));
      this.client.exec(command, (error, channel) => {
        if (error) return reject(error);
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { channel.close(); reject(new Error('Remote command timed out.')); }, timeout);
        channel.on('data', (data) => { stdout += data; if (stdout.length > 1000000) channel.close(); });
        channel.stderr.on('data', (data) => { stderr += data; });
        channel.on('close', (code) => {
          clearTimeout(timer);
          if (code && code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `Remote command failed (${code}).`));
          else resolve(stdout.trim());
        });
        channel.on('error', reject);
      });
    });
  }
  async syncServer() {
    if (!Number.isInteger(this.remotePort) || this.remotePort < 1024 || this.remotePort > 65535) throw new Error('Choose a reverse tunnel port before synchronizing server settings.');
    const home = await this.exec('printf %s "$HOME"');
    if (!home.startsWith('/') || /[\r\n\0]/.test(home)) throw new Error('Unexpected remote home directory.');
    this.remoteDir = `${home}/windows-mcp`;
    await this.exec(`umask 077; mkdir -p ${shellQuote(this.remoteDir)}; chmod 700 ${shellQuote(this.remoteDir)}`);
    const sftp = await new Promise((resolve, reject) => this.client.sftp((err, value) => err ? reject(err) : resolve(value)));
    try {
      const files = ['attach-desktop-session.sh', 'relay-tmux.conf', 'start-desktop-session.sh', 'start-claude-container.sh', 'start-claude.sh', 'start-codex-container.sh', 'start-codex.sh', 'mcp.json', 'read-session-history.py', 'read-message-receipt.py', 'read-model-catalog.py', 'receive-clipboard-image.py', 'record-claude-usage.sh', 'read-usage.py', 'desktop-sessions.py', 'record-task-state.sh', 'configure-task-status.py', 'read-system-status.py'];
      files.push('admit-desktop-session.py', 'manage-claude-version.py', '.env');
      for (const name of files) {
        const source = name === '.env' ? path.join(this.root, name) : path.join(this.root, 'server', name);
        const destination = `${this.remoteDir}/${name}`;
        const temporary = `${destination}.${crypto.randomUUID()}.relay-upload`;
        if (name === '.env') {
          const contents = fs.readFileSync(source, 'utf8')
            .replace(/^(\s*REMOTE_MCP_PORT\s*=)[^\r\n]*/m, (_line, prefix) => prefix + this.remotePort)
            .replace(/^(\s*LOCAL_MCP_PORT\s*=)[^\r\n]*/m, (_line, prefix) => prefix + this.localPort);
          await new Promise((resolve, reject) => {
            const stream = sftp.createWriteStream(temporary, { mode: 0o600 });
            stream.on('error', reject);
            stream.on('close', resolve);
            stream.end(contents);
          });
        } else {
          await new Promise((resolve, reject) => sftp.fastPut(source, temporary, { mode: name.endsWith('.sh') ? 0o700 : 0o600 }, (err) => err ? reject(err) : resolve()));
        }
        await new Promise((resolve, reject) => sftp.ext_openssh_rename(temporary, destination, (err) => err ? reject(err) : resolve()));
      }
    } finally { sftp.end(); }
    await this.syncDesktopSettings();
    try { await this.exec(`python3 ${shellQuote(this.remoteDir + '/receive-clipboard-image.py')} cleanup`); }
    catch (error) { this.log(`Clipboard image cache cleanup failed: ${error.message}`); }
    try {
      const setup = JSON.parse(await this.exec(`python3 ${shellQuote(this.remoteDir + '/read-usage.py')} claude --configure`));
      if (!setup.configured) this.log('Claude usage reporting is unavailable; existing status-line settings were preserved.');
    } catch (error) { this.log(`Claude usage reporting setup failed: ${error.message}`); }
    try { await this.exec(`python3 ${shellQuote(this.remoteDir + '/configure-task-status.py')}`); }
    catch (error) { this.log(`Task status reporting setup failed: ${error.message}`); }
    this.log('Remote launchers and MCP settings synchronized. Secret contents are hidden.');
  }
  async syncDesktopSettings() {
    if (!this.client || !this.remoteDir) throw new Error('Connect to the server first.');
    const client = this.client;
    const cfg = configFromEnv(this.root);
    const sftp = await new Promise((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)));
    const destination = this.remoteDir + '/desktop-settings.json';
    const temporary = destination + '.' + crypto.randomUUID();
    try {
      await new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(temporary, { mode: 0o600 });
        stream.on('error', reject); stream.on('close', resolve);
        stream.end(JSON.stringify({ maxSessions: cfg.maxSessions }));
      });
      await new Promise((resolve, reject) => sftp.ext_openssh_rename(temporary, destination, (error) => error ? reject(error) : resolve()));
    } finally { sftp.end(); }
  }
  async activeSessions(id = null, provider = null, { reclaimIdle = false } = {}) {
    if (!this.client || this.status.ssh !== 'ready') throw new Error('Connect to the server first.');
    let command = `python3 ${shellQuote(this.remoteDir + '/desktop-sessions.py')} list`;
    if (reclaimIdle) {
      if (!sessionPattern.test(id) || !['claude', 'codex'].includes(provider)) throw new Error('Invalid session.');
      const request = { id, provider, protected: this.sessionConnections().map(({ id: key, provider: assistant }) => ({ id: key, provider: assistant })) };
      command = `python3 ${shellQuote(this.remoteDir + '/admit-desktop-session.py')} ${shellQuote(JSON.stringify(request))}`;
    }
    const value = JSON.parse(await this.exec(command, reclaimIdle ? 55000 : 20000));
    if (!Array.isArray(value.active) || !Number.isInteger(value.maxSessions)) throw new Error('Unable to read active conversations.');
    value.active = value.active.filter((entry) => sessionPattern.test(entry.id) && ['claude', 'codex'].includes(entry.provider));
    const existing = id && value.active.find((entry) => entry.id === id && entry.provider === provider);
    value.reason = existing ? '' : value.active.length >= value.maxSessions ? 'limit' : value.availableMiB < value.requiredMiB ? 'memory' : '';
    value.available = !value.reason;
    return value;
  }
  async cleanupCompletedSessions() {
    if (!this.client || this.status.ssh !== 'ready' || !this.remoteDir) return { released: [] };
    const request = { action: 'cleanup-completed', protected: this.sessionConnections().map(({ id, provider }) => ({ id, provider })) };
    const result = JSON.parse(await this.exec(`python3 ${shellQuote(this.remoteDir + '/admit-desktop-session.py')} ${shellQuote(JSON.stringify(request))}`, 55000));
    if (!Array.isArray(result.released) || !Array.isArray(result.active)) throw new Error('Unable to safely release idle desktop sessions.');
    this.log(`Idle cleanup released ${result.released.length} completed desktop process(es). Running or uncertain tasks and conversation history were retained.`);
    return result;
  }
  async prepareForExit() {
    if (this.connecting) await this.connecting.catch(() => {});
    // Detach UI channels first so completed sessions in the closing app become eligible.
    for (const owner of new Set([...this.channels.values()].map((channel) => channel.owner))) this.detachOwner(owner);
    await sleep(200);
    return this.cleanupCompletedSessions();
  }
  async reconnectSettings(passphrase, keepRemotePort) {
    const client = this.client, service = this.service;
    const waitFor = (target, event, timeout) => !target ? Promise.resolve() : new Promise((resolve) => {
      const timer = setTimeout(() => { if (event === 'close') target.destroy(); resolve(); }, timeout);
      target.once(event, () => { clearTimeout(timer); resolve(); });
    });
    const waits = [waitFor(client, 'close', 3000), waitFor(service, 'exit', 6000)];
    this.stop();
    await Promise.all(waits);
    this.localPort = null; this.remotePort = null;
    this.nextRemotePort = keepRemotePort || null;
    return this.connect(passphrase || '');
  }
  async uploadClipboardImages(sessionId, owner, files) {
    if (!files.length) return [];
    const client = this.client;
    const channel = this.channels.get(sessionId);
    const current = () => client && this.client === client && this.status.ssh === 'ready' && this.channels.get(sessionId) === channel && channel?.owner === owner && !channel.finished;
    const result = [];
    for (const file of files) {
      if (!current()) throw new Error('Open this session first.');
      if (file.kind !== 'clipboard-image' || path.dirname(file.path) !== path.join(this.root, '.runtime', 'desktop', 'clipboard-images') || !imageNamePattern.test(file.name) || path.basename(file.path) !== file.name) throw new Error('Invalid clipboard image reference.');
      const info = await fs.promises.lstat(file.path);
      if (!info.isFile() || !info.size || info.size > maxImageBytes) throw new Error('Clipboard image changed or exceeds 2 MiB. Paste it again.');
      const data = await fs.promises.readFile(file.path);
      if (data.length !== info.size) throw new Error('Clipboard image changed. Paste it again.');
      const digest = crypto.createHash('sha256').update(data).digest('hex');
      const command = `python3 ${shellQuote(this.remoteDir + '/receive-clipboard-image.py')} ${shellQuote(file.name)} ${data.length} ${digest}`;
      const response = await new Promise((resolve, reject) => {
        client.exec(command, (error, stream) => {
          if (error) return reject(error);
          let output = '', errors = '', settled = false;
          const finish = (error) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) { stream.destroy(); reject(error); } else resolve(output.trim());
          };
          const timer = setTimeout(() => finish(new Error('Clipboard image upload timed out. The draft is retained.')), 55000);
          stream.on('data', (chunk) => { output += chunk; if (output.length > 8192) finish(new Error('Unexpected image upload response.')); });
          stream.stderr.on('data', (chunk) => { errors += chunk; if (errors.length > 8192) finish(new Error('Unexpected image upload response.')); });
          stream.on('error', finish);
          stream.on('close', (code) => finish(code !== 0 ? new Error(errors.trim() || 'Clipboard image upload failed. The draft is retained.') : null));
          if (!current()) return finish(new Error('Open this session first.'));
          stream.end(data);
        });
      });
      const uploaded = JSON.parse(response);
      const expected = `/opt/windows-mcp/clipboard-images/${file.name}`;
      if (!current() || uploaded.containerPath !== expected || uploaded.name !== file.name) throw new Error('Clipboard image upload could not be confirmed.');
      result.push({ path: expected, sizeBytes: data.length, width: file.width, height: file.height, format: file.format });
    }
    return result;
  }
  async refreshUsage(provider, force = false) {
    if (!['claude', 'codex'].includes(provider)) throw new Error('Invalid assistant provider.');
    this.usageProvider = provider;
    const client = this.client;
    if (!client || this.status.ssh !== 'ready' || this.status.tunnel !== 'ready') return this.snapshot();
    const pending = this.usagePending.get(provider);
    if (pending?.client === client) return pending.promise;
    const cooldown = force ? 15000 : provider === 'claude' ? 30000 : 120000;
    if (Date.now() - (this.usageLastAttempts.get(provider) || 0) < cooldown) return this.snapshot();
    if (provider === 'codex' && this.catalog.loading) {
      if (!this.usage[provider].windows.length) this.usage[provider] = { ...this.usage[provider], state: 'pending', reason: 'catalog_busy' };
      this.update({});
      return this.snapshot();
    }
    const entry = { client, promise: null };
    this.usagePending.set(provider, entry);
    this.usageLastAttempts.set(provider, Date.now());
    entry.promise = (async () => {
      this.usage[provider] = { ...this.usage[provider], loading: true };
      this.update({});
      try {
        const raw = await this.exec(`python3 ${shellQuote(this.remoteDir + '/read-usage.py')} ${provider}`, 35000);
        const data = JSON.parse(raw);
        if (this.client !== client) return this.snapshot();
        if (data.provider !== provider || !['ready', 'pending', 'not_signed_in', 'unsupported', 'error'].includes(data.state) || !Array.isArray(data.windows) || data.windows.length > 20) throw new Error('Unexpected usage metadata.');
        if (data.windows.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100)) throw new Error('Unexpected usage metadata.');
        const previous = this.usage[provider];
        this.usage[provider] = data.state === 'error' && previous.windows.length
          ? { ...previous, state: 'error', reason: data.reason || 'query_failed', cached: true, loading: false }
          : { ...data, loading: false };
      } catch {
        if (this.client === client) this.usage[provider] = { ...this.usage[provider], state: 'error', reason: 'query_failed', cached: true, loading: false };
      } finally {
        if (this.usagePending.get(provider) === entry) this.usagePending.delete(provider);
        if (this.client === client) { this.usage[provider].loading = false; this.update({}); }
      }
      return this.snapshot();
    })();
    return entry.promise;
  }
  async refreshModels(client = this.client, generation = this.generation) {
    const current = () => this.client === client && this.generation === generation;
    this.catalog.loading = true;
    this.update({});
    try {
      // Discover sequentially to limit temporary RAM usage on the small VPS.
      for (const provider of ['claude', 'codex']) {
        if (!current()) return;
        try {
          const raw = await this.exec(`python3 ${shellQuote(this.remoteDir + '/read-model-catalog.py')} ${provider}`, 35000);
          if (!current()) return;
          const entry = normalizeCatalog(JSON.parse(raw));
          this.catalog[provider] = { ...entry, updatedAt: Date.now(), cached: false, error: '' };
          this.log(`${provider} model catalog refreshed (${entry.models.length} models).`);
        } catch (error) {
          if (!current()) return;
          this.catalog[provider] = { ...this.catalog[provider], cached: true, error: error.message };
          this.log(`${provider} model catalog refresh failed: ${error.message}`);
        }
        this.update({});
      }
      if (current()) {
        try {
          fs.mkdirSync(path.dirname(this.catalogPath), { recursive: true });
          const temporary = this.catalogPath + '.tmp';
          fs.writeFileSync(temporary, JSON.stringify({ claude: this.catalog.claude, codex: this.catalog.codex }));
          fs.renameSync(temporary, this.catalogPath);
        } catch (error) { this.log(`Model catalog cache could not be saved: ${error.message}`); }
      }
    } finally {
      if (current()) {
        this.catalog.loading = false; this.update({});
        if (this.usageProvider === 'codex') this.refreshUsage('codex').catch((error) => this.log(`Usage refresh: ${error.message}`));
      }
    }
  }
  async findRemotePorts(preferredPort) {
    const script = [
      'import errno, json, socket, sys',
      'preferred = int(sys.argv[1])',
      'ports = []',
      'for offset in range(64512):',
      '    port = 1024 + (preferred - 1024 + offset) % 64512',
      '    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:',
      '        try:',
      '            listener.bind(("127.0.0.1", port))',
      '        except OSError as error:',
      '            if error.errno not in (errno.EADDRINUSE, errno.EACCES):',
      '                raise',
      '            continue',
      '    ports.append(port)',
      '    if len(ports) == 20:',
      '        break',
      'print(json.dumps(ports))',
    ].join('\n');
    const ports = JSON.parse(await this.exec(`python3 -c ${shellQuote(script)} ${preferredPort}`));
    if (!Array.isArray(ports) || ports.length > 20 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== ports.length) throw new Error('Unexpected available server port list.');
    if (!ports.length) throw new Error('No available server MCP ports were found.');
    this.log(`Available server MCP candidates: ${ports.join(', ')}.`);
    return ports;
  }
  async startTunnel(preferredPort, client, generation) {
    const ensureCurrent = () => {
      if (generation !== this.generation || this.client !== client) throw new Error('Connection canceled.');
    };
    const forward = (port) => new Promise((resolve) => client.forwardIn('127.0.0.1', port, (error) => resolve(error || null)));
    ensureCurrent();
    this.remotePort = preferredPort;
    const initialError = await forward(preferredPort);
    ensureCurrent();
    if (!initialError) {
      await this.probe(preferredPort, true);
      ensureCurrent();
      return true;
    }
    // A previously started launcher may still provide a usable authenticated tunnel.
    let shared = false;
    try { await this.probe(preferredPort, true); shared = true; } catch {}
    ensureCurrent();
    if (shared) return false;
    this.log(`Preferred server port ${preferredPort} could not be forwarded: ${initialError.message}`);
    const candidates = await this.findRemotePorts(preferredPort);
    let lastError = initialError;
    for (const port of candidates) {
      ensureCurrent();
      this.remotePort = port;
      const error = await forward(port);
      ensureCurrent();
      if (error) {
        lastError = error;
        this.log(`SSH forwarding for available server candidate ${port} failed: ${error.message}`);
        continue;
      }
      await this.probe(port, true);
      return true;
    }
    throw new Error(`SSH could not forward any of ${candidates.length} available server ports: ${lastError.message}. Check server TCP forwarding permissions.`);
  }
  async connect(passphrase = '') {
    if (this.controlChanging) throw new Error('Wait for the desktop control mode change to finish.');
    if (this.connecting) return this.connecting;
    if (this.status.ssh === 'ready' && this.status.mcp === 'ready' && this.status.tunnel === 'ready') return this.snapshot();
    const generation = ++this.generation;
    this.connecting = this._connect(passphrase, generation).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async _connect(passphrase, generation) {
    try {
      if (this.client) {
        const previous = this.client;
        this.client = null;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000);
          previous.once('close', () => { clearTimeout(timer); resolve(); });
          previous.end();
        });
      }
      await this.startMcp();
      if (generation !== this.generation) throw new Error('Connection canceled.');
      const cfg = configFromEnv(this.root);
      const localPort = this.localPort;
      this.remotePort = null;
      const trusted = knownHostKeys(cfg);
      const algorithms = [...new Set(trusted.flatMap((key) => {
        const type = key.subarray(4, 4 + key.readUInt32BE(0)).toString();
        return type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [type];
      }))];
      this.update({ ssh: 'connecting', tunnel: 'off' });
      const client = new Client();
      this.client = client;
      client.on('error', (error) => this.log(`SSH: ${error.message}`));
      client.on('close', () => {
        if (this.client === client) {
          this.client = null;
          this.monitor.receivedAt = null;
          this.catalog.loading = false;
          for (const value of Object.values(this.usage)) value.loading = false;
          this.update({ ssh: 'off', tunnel: 'off', tunnelOwned: false });
          this.log('SSH disconnected. Remote sessions can be reattached after reconnecting.');
        }
      });
      client.on('tcp connection', (details, accept, reject) => {
        if(require('./reverse-routes.cjs').route(client,details,accept,reject))return;
        if (details.destPort !== this.remotePort || !['127.0.0.1', 'localhost'].includes(details.destIP)) return reject();
        const channel = accept();
        const local = net.connect({ host: '127.0.0.1', port: this.localPort || localPort });
        local.on('error', () => channel.destroy());
        channel.on('error', () => local.destroy());
        channel.on('close', () => local.destroy());
        local.pipe(channel).pipe(local);
      });
      await new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.connect({ host: cfg.host, port: cfg.sshPort, username: cfg.username, privateKey: fs.readFileSync(cfg.keyPath), passphrase: passphrase || undefined, hostVerifier: (key) => hostMatches(key, trusted), algorithms: { serverHostKey: algorithms }, readyTimeout: 15000, keepaliveInterval: 15000, keepaliveCountMax: 3 });
      });
      if (generation !== this.generation) { client.end(); throw new Error('Connection canceled.'); }
      this.update({ ssh: 'ready' });
      const owned = await this.startTunnel(this.nextRemotePort || cfg.remotePort, client, generation);
      this.nextRemotePort = null;
      if (generation !== this.generation || this.client !== client) throw new Error('Connection canceled.');
      await this.syncServer();
      if (generation !== this.generation || this.client !== client) throw new Error('Connection canceled.');
      const serverKey = `${cfg.username}@${cfg.host}:${cfg.sshPort}`;
      if (!this.startupCleanedServers.has(serverKey)) {
        try {
          await this.cleanupCompletedSessions();
          if (generation === this.generation && this.client === client) this.startupCleanedServers.add(serverKey);
        } catch (error) { this.log(`Startup idle cleanup deferred: ${error.message}`); }
      }
      if (generation !== this.generation || this.client !== client) throw new Error('Connection canceled.');
      this.update({ tunnel: 'ready', tunnelOwned: owned });
      this.usageLastAttempts.clear();
      this.log(owned ? `Reverse tunnel ready on server loopback port ${this.remotePort}.` : `Using the existing reverse tunnel on port ${this.remotePort}. Keep its original launcher open.`);
      this.refreshModels(client, generation).catch((error) => this.log(`Model discovery: ${error.message}`));
      this.refreshUsage(this.usageProvider).catch((error) => this.log(`Usage refresh: ${error.message}`));
      this.checkCompletions();
      return this.snapshot();
    } catch (error) {
      if (this.client) this.client.end();
      this.update({ ssh: 'off', tunnel: 'off', tunnelOwned: false });
      this.log(error.message);
      throw error;
    }
  }
  async healthCheck() {
    if (!this.client || this.status.ssh !== 'ready' || this.healthBusy || this.connecting || this.controlChanging) return;
    const client = this.client;
    this.healthBusy = true;
    try {
      const cfg = configFromEnv(this.root);
      let mcp = 'ready', tunnel = 'ready';
      try { await this.probe(this.localPort || cfg.localPort); } catch { mcp = 'error'; }
      try { await this.probe(this.remotePort || cfg.remotePort, true); } catch { tunnel = 'error'; }
      if (this.client !== client || this.controlChanging) return;
      if (mcp !== this.status.mcp || tunnel !== this.status.tunnel) {
        this.update({ mcp, tunnel });
        if (mcp === 'error' || tunnel === 'error') this.log('A service health check failed. Check the old launcher or click Connect & start to reconnect.');
      }
    } catch (error) { this.log(error.message); }
    finally { this.healthBusy = false; }
  }
  async openSession(session, owner, dimensions) {
    if (!sessionPattern.test(session.id)) throw new Error('Invalid session ID.');
    const provider = session.provider || 'claude';
    if (!['claude', 'codex'].includes(provider)) throw new Error('Invalid assistant provider.');
    const settings = selection(session);
    if (!this.client || this.status.tunnel !== 'ready') throw new Error('Start the connection first.');
    const existing = this.channels.get(session.id);
    if (existing) {
      if (existing.owner !== owner) throw new Error('This session is already open in another window.');
      if (!existing.finished) return;
      this.channels.delete(session.id);
    }
    if (typeof session.projectPath !== 'string' || !session.projectPath || session.projectPath.length > 1000 || /[\r\n\0]/.test(session.projectPath)) throw new Error('Invalid project path.');
    const settingsArgs = settings.model ? ` ${shellQuote(settings.model)} ${shellQuote(settings.effort)}` : '';
    const command = `bash ${shellQuote(this.remoteDir + '/attach-desktop-session.sh')} ${shellQuote(session.projectPath)} ${shellQuote(session.id)} ${shellQuote(provider)}${settingsArgs}`;
    await new Promise((resolve, reject) => this.client.exec(command, { pty: { term: 'xterm-256color', cols: dimensions.cols || 100, rows: dimensions.rows || 30 } }, (error, stream) => {
      if (error) return reject(error);
      const channel = { stream, owner, provider, finished: false };
      this.channels.set(session.id, channel);
      const stdout = new StringDecoder('utf8');
      const stderr = new StringDecoder('utf8');
      let pending = '';
      let capacityTail = '', capacityReported = false;
      const capacityDeadline = Date.now() + 15000;
      let flushTimer = null;
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (!pending) return;
        const data = pending;
        pending = '';
        this.emit('data', { id: session.id, owner, data });
      };
      const queue = (data) => {
        if (!data) return;
        if (!capacityReported && Date.now() < capacityDeadline) {
          capacityTail = (capacityTail + data).slice(-8192);
          const marker = /(?:^|\r?\n)RELAY_CAPACITY_(LIMIT|MEMORY)(?:\r?\n|$)/.exec(capacityTail);
          if (marker) { capacityReported = true; this.emit('capacity', { id: session.id, owner, reason: marker[1] === 'MEMORY' ? 'memory' : 'limit' }); }
        }
        pending += data;
        if (pending.length >= 65536) flush();
        else if (!flushTimer) flushTimer = setTimeout(flush, 16);
      };
      stream.on('data', (data) => { if (!channel.finished) queue(stdout.write(data)); });
      stream.stderr.on('data', (data) => { if (!channel.finished) queue(stderr.write(data)); });
      const finish = () => {
        if (channel.finished) return;
        channel.finished = true;
        const tail = stdout.end() + stderr.end();
        queue(tail);
        flush();
        if (this.channels.get(session.id)?.stream === stream) this.channels.delete(session.id);
        this.emit('ended', { id: session.id, owner });
        this.emit('session-connections', this.sessionConnections());
        if (!channel.intentionalClose && !capacityReported && Date.now() < capacityDeadline) this.emit('capacity-check', { id: session.id, owner });
      };
      channel.finish = finish;
      stream.on('close', finish);
      stream.on('error', (error) => { this.log(error.message); finish(); });
      this.emit('session-connections', this.sessionConnections());
      resolve();
    }));
  }
  async messageReceipt(id, provider, options = {}) {
    if (!sessionPattern.test(id) || !['claude', 'codex'].includes(provider)) throw new Error('Invalid session.');
    if (!this.client || this.status.ssh !== 'ready') throw new Error('Connect to the server first.');
    const request = { ...options, session: id, provider };
    const raw = await this.exec(`python3 ${shellQuote(this.remoteDir + '/read-message-receipt.py')} ${shellQuote(JSON.stringify(request))}`, 8000);
    const result = JSON.parse(raw);
    if (result.error) throw new Error('Unable to confirm remote message receipt.');
    return result;
  }
  async readHistory(id, provider, cursor = null, knownCompletion = '') {
    if (!sessionPattern.test(id) || !['claude', 'codex'].includes(provider)) throw new Error('Invalid session.');
    if (!this.client || this.status.ssh !== 'ready') throw new Error('Connect to the server first.');
    const since = cursor && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && Number.isSafeInteger(cursor.inode) && cursor.inode >= 0 ? ` --since ${cursor.offset} ${cursor.inode}` : '';
    const raw = await this.exec(`python3 ${shellQuote(this.remoteDir + '/read-session-history.py')} ${provider} ${id}${since}`, 30000);
    const result = JSON.parse(raw);
    if (!this.completionTokens.has(id)) this.completionTokens.set(id, result.completion || knownCompletion || '');
    return result;
  }
  setKnownSessions(sessions) {
    this.knownSessions = new Map(sessions.filter((session) => sessionPattern.test(session.id) && ['claude', 'codex'].includes(session.provider)).map((session) => [session.id, session.provider]));
    for (const id of Object.keys(this.monitor.sessions)) if (!this.knownSessions.has(id)) delete this.monitor.sessions[id];
    for (const id of this.statusCursors.keys()) if (!this.knownSessions.has(id)) { this.statusCursors.delete(id); this.completionTokens.delete(id); this.pendingTaskStarts.delete(id); }
    for (const id of this.pendingTaskStarts.keys()) if (!this.knownSessions.has(id)) this.pendingTaskStarts.delete(id);
  }
  markTaskRunning(id) {
    const previous = this.monitor.sessions[id];
    this.pendingTaskStarts.set(id, { at: Date.now(), previousAt: previous?.updatedAt || 0, previousCompletion: this.completionTokens.get(id) });
    this.monitor.sessions[id] = { ...previous, state: 'running', source: 'submitted', confirmed: false };
    this.emit('monitor', this.monitor);
  }
  async checkCompletions() {
    if (this.completionBusy || !this.client || this.status.ssh !== 'ready' || this.status.tunnel !== 'ready' || this.settingsChanging) return;
    const client = this.client;
    this.completionBusy = true;
    try {
      const targets = new Map([...this.channels].map(([id, channel]) => [id, channel.provider]));
      for (const [id, provider] of this.knownSessions) if (!targets.has(id)) targets.set(id, provider);
      const request = [...targets].slice(0, 200).map(([id, provider]) => ({ id, provider, cursor: this.statusCursors.get(id) || null }));
      const raw = await this.exec(`python3 ${shellQuote(this.remoteDir + '/read-system-status.py')} ${shellQuote(JSON.stringify(request))}`, 20000);
      const result = JSON.parse(raw);
      if (client !== this.client) return;
      if (result.error || !result.resources || !Number.isFinite(result.resources.memoryTotal) || !result.sessions) throw new Error('Unable to read server metrics or task state.');
      for (const [id, item] of Object.entries(result.sessions)) {
        if (!this.knownSessions.has(id)) continue;
        if (item.cursor) this.statusCursors.set(id, item.cursor);
        const previousState = this.monitor.sessions[id] || { state: 'unknown', updatedAt: 0 };
        let state = item.taskState && (!item.taskUpdatedAt || item.taskUpdatedAt >= (previousState.updatedAt || 0)) ? item.taskState : previousState.state;
        let source = item.taskState && state === item.taskState ? item.taskSource : previousState.source;
        const pending = this.pendingTaskStarts.get(id);
        if (pending) {
          const elapsed = Date.now() - pending.at;
          const newEvent = item.taskUpdatedAt && item.taskUpdatedAt >= result.resources.updatedAt - elapsed;
          const newCompletion = pending.previousCompletion && item.completion && item.completion !== pending.previousCompletion;
          if (!newEvent && !newCompletion) { state = elapsed < 15000 ? 'running' : 'unknown'; source = elapsed < 15000 ? 'submitted' : 'unconfirmed'; }
          if (newEvent || newCompletion) this.pendingTaskStarts.delete(id);
        }
        if (!item.remoteActive && ['running', 'waiting'].includes(state)) { state = 'interrupted'; source = 'process-ended'; }
        this.monitor.sessions[id] = { state: state || 'unknown', updatedAt: Math.max(item.taskUpdatedAt || 0, previousState.updatedAt || 0) || null,
          source, confirmed: source !== 'submitted' && source !== 'unconfirmed', remoteActive: item.remoteActive };
        const previous = this.completionTokens.get(id);
        const token = item.completion || previous || '';
        this.completionTokens.set(id, token);
        if (previous !== undefined && token && token !== previous && state === 'completed') this.emit('completed', { id, owner: this.channels.get(id)?.owner });
      }
      this.monitor = { resources: result.resources, sessions: this.monitor.sessions, receivedAt: Date.now(), error: '' };
      this.emit('monitor', this.monitor);
    } catch (error) {
      if (client === this.client) { this.monitor.error = 'Unable to read server metrics or task state.'; this.emit('monitor', this.monitor); }
      this.log(`Completion check: ${error.message}`);
    }
    finally { this.completionBusy = false; }
  }
  async submitInput(id, owner, data) {
    const channel = this.channels.get(id);
    if (!channel || channel.owner !== owner || channel.stream.destroyed || channel.stream.writableEnded) throw new Error('Open this session first.');
    if (typeof data !== 'string' || data.length > 100000) throw new Error('Input is too long.');
    await new Promise((resolve, reject) => {
      const stream = channel.stream;
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); stream.removeListener('error', onError); stream.removeListener('close', onClose);
        if (error) reject(error); else resolve();
      };
      const onError = () => finish(new Error('SSH input submission failed. The draft is retained.'));
      const onClose = () => finish(new Error('SSH is disconnected.'));
      const timer = setTimeout(() => finish(new Error('SSH input submission timed out. The draft is retained.')), 10000);
      stream.once('error', onError); stream.once('close', onClose);
      try {
        stream.write(data, (error) => finish(error || (this.channels.get(id) !== channel || stream.destroyed ? new Error('SSH is disconnected.') : null)));
      } catch (error) { finish(error); }
    });
  }
  input(id, owner, data) {
    const channel = this.channels.get(id);
    if (!channel || channel.owner !== owner) throw new Error('Open this session first.');
    if (typeof data !== 'string' || data.length > 100000) throw new Error('Input is too long.');
    channel.stream.write(data);
  }
  resize(id, owner, cols, rows) {
    const channel = this.channels.get(id);
    if (channel?.owner === owner && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 20 && cols <= 400 && rows >= 5 && rows <= 200) channel.stream.setWindow(rows, cols, 0, 0);
  }
  detachOwner(owner) {
    for (const channel of this.channels.values()) if (channel.owner === owner) { channel.intentionalClose = true; channel.finish(); channel.stream.close(); }
  }
  async endSession(id, owner, provider = 'claude') {
    if (!sessionPattern.test(id)) throw new Error('Invalid session ID.');
    if (!['claude', 'codex'].includes(provider)) throw new Error('Invalid assistant provider.');
    const channel = this.channels.get(id);
    if (channel && channel.owner !== owner) throw new Error('This session is open in another window.');
    if (channel) channel.intentionalClose = true;
    await this.exec(`bash ${shellQuote(this.remoteDir + '/attach-desktop-session.sh')} --end ${shellQuote(id)} ${shellQuote(provider)}`, 20000);
    if (channel) { channel.finish(); channel.stream.close(); }
  }
  stop() {
    ++this.generation;
    this.catalog.loading = false;
    for (const value of Object.values(this.usage)) value.loading = false;
    this.appliedForceControl = null;
    for (const channel of this.channels.values()) { channel.intentionalClose = true; channel.stream.close(); }
    this.channels.clear();
    this.statusCursors.clear();
    this.monitor.receivedAt = null;
    if (this.client) { this.client.end(); this.client = null; }
    if (this.service) { this.service.kill(); this.service = null; }
    this.update({ mcp: this.status.mcpOwned ? 'off' : this.status.mcp, mcpOwned: false, ssh: 'off', tunnel: 'off', tunnelOwned: false });
    this.log('Disconnected. Services owned by an older launcher were left running. Remote sessions remain resumable.');
  }
}
module.exports = { Backend };
