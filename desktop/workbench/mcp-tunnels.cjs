const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseEnv, shellQuote } = require('../config.cjs');
const reverseRoutes = require('../reverse-routes.cjs');
const { DirectoryAccess, createDirectoryAccessBridge } = require('./directory-access.cjs');

function defaultTunnelConfig(location) {
  const cfg = location?.mcpTunnel || {};
  return {
    enabled: Boolean(cfg.enabled),
    remotePort: Number.isInteger(cfg.remotePort) && cfg.remotePort >= 1024 && cfg.remotePort <= 65535 ? cfg.remotePort : 18111,
    autoStart: Boolean(cfg.autoStart),
    syncRemoteEnv: cfg.syncRemoteEnv !== false,
  };
}

function formatTunnelEnv(remotePort, secret, directoryBridge) {
  return [
    '# Managed by ai-team workbench. Do not edit manually.',
    `WINDOWS_MCP_URL=http://127.0.0.1:${remotePort}/mcp`,
    `WINDOWS_MCP_SECRET=${secret}`,
    ...(directoryBridge ? [
      `DIRECTORY_ACCESS_URL=${directoryBridge.url}`,
      `DIRECTORY_ACCESS_TOKEN=${directoryBridge.token}`,
    ] : []),
    '',
  ].join('\n');
}

class McpTunnels {
  constructor({ root, store, locations, backend, emit, approveDirectory }) {
    Object.assign(this, { root, store, locations, backend, emit, approveDirectory });
    this.active = new Map();
    this.pending = new Map();
    this.lastError = new Map();
    this.closed = false;
  }

  ensureLocalEnv() {
    const envPath = path.join(this.root, '.env');
    let raw = '';
    let values = {};
    if (fs.existsSync(envPath)) {
      raw = fs.readFileSync(envPath, 'utf8');
      values = parseEnv(raw);
    }
    const updates = {};
    if (!/^[a-f0-9]{64}$/.test(values.WINDOWS_MCP_SECRET || '')) {
      updates.WINDOWS_MCP_SECRET = crypto.randomBytes(32).toString('hex');
    }
    const localPort = Number(values.LOCAL_MCP_PORT);
    if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
      updates.LOCAL_MCP_PORT = '8111';
    }
    const remotePort = Number(values.REMOTE_MCP_PORT);
    if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
      updates.REMOTE_MCP_PORT = '18111';
    }
    const sshPort = Number(values.SSH_PORT);
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      updates.SSH_PORT = '22';
    }
    if (!/^[\w][\w.-]*@[\w][\w.-]*$/.test(values.SSH_TARGET || '')) {
      updates.SSH_TARGET = 'relay@localhost.invalid';
    }
    if (Object.keys(updates).length) {
      const newline = raw.includes('\r\n') ? '\r\n' : '\n';
      const remaining = new Map(Object.entries(updates));
      const lines = raw ? raw.split(/\r?\n/).map(line => {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (!match || !remaining.has(match[1])) return line;
        const replacement = `${match[1]}=${remaining.get(match[1])}`;
        remaining.delete(match[1]);
        return replacement;
      }) : [];
      while (lines.length && lines.at(-1) === '') lines.pop();
      for (const [k, v] of remaining) lines.push(`${k}=${v}`);
      const tmp = envPath + '.mcp-' + crypto.randomUUID();
      fs.writeFileSync(tmp, lines.join(newline) + newline, { mode: 0o600 });
      fs.renameSync(tmp, envPath);
      values = { ...values, ...updates };
    }
    return {
      localPort: Number(values.LOCAL_MCP_PORT),
      secret: values.WINDOWS_MCP_SECRET,
    };
  }

  async ensureLocalMcp() {
    const env = this.ensureLocalEnv();
    if (this.backend.status.mcp !== 'ready' || !this.backend.localPort) {
      await this.backend.startMcp();
    }
    const localPort = this.backend.localPort || env.localPort;
    return { localPort, secret: env.secret };
  }

  probeRemote(client, remotePort, secret) {
    return new Promise((resolve, reject) => {
      if (!client) return reject(new Error('SSH 未连接。'));
      client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, channel) => {
        if (error) return reject(error);
        let response = '';
        let done = false;
        const finish = err => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          channel.destroy();
          if (err) reject(err);
          else resolve(true);
        };
        const timer = setTimeout(() => finish(new Error('远端 MCP 隧道健康检查超时。')), 8000);
        channel.on('data', chunk => {
          response += chunk;
          if (response.length > 300000) return finish(new Error('远端 MCP 响应异常。'));
          if (response.includes('\r\n') && !/^HTTP\/1\.[01] 200 /.test(response)) {
            return finish(new Error('远端端口未返回有效的 MCP 认证响应。'));
          }
          if (/^HTTP\/1\.[01] 200 /.test(response) && response.includes('serverInfo')) finish();
        });
        channel.on('end', () => finish(new Error(`远端 MCP 隧道健康检查失败（${response.split('\r\n')[0] || '空响应'}）。`)));
        channel.on('error', finish);
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ai-team-tunnel-probe', version: '0.1.0' } },
        });
        channel.write(
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${remotePort}\r\nAuthorization: Bearer ${secret}\r\n` +
          `Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
        );
      });
    });
  }

  async findRemotePorts(locationId, preferredPort) {
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
    const ports = JSON.parse(await this.locations.exec(locationId, `python3 -c ${shellQuote(script)} ${preferredPort}`));
    if (!Array.isArray(ports) || !ports.length) throw new Error('服务器上没有可用的 MCP 监听端口。');
    return ports;
  }

  async syncRemoteTunnelEnv(locationId, client, remotePort, secret, directoryBridge) {
    const home = (await this.locations.exec(locationId, 'printf %s "$HOME"')).trim();
    if (!home.startsWith('/') || /[\r\n\0]/.test(home)) throw new Error('无法识别服务器用户主目录。');
    const dir = `${home}/.windows-mcp`;
    const target = `${dir}/tunnel.env`;
    const tmp = `${target}.${crypto.randomUUID()}`;
    await this.locations.exec(locationId, `umask 077; mkdir -p -- ${shellQuote(dir)}; chmod 700 -- ${shellQuote(dir)}`);
    const content = formatTunnelEnv(remotePort, secret, directoryBridge);
    const sftp = await new Promise((resolve, reject) => client.sftp((err, value) => err ? reject(err) : resolve(value)));
    try {
      await new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(tmp, { mode: 0o600 });
        stream.on('error', reject);
        stream.on('close', resolve);
        stream.end(content);
      });
    } finally {
      sftp.end();
    }
    await this.locations.exec(locationId, `mv -f -- ${shellQuote(tmp)} ${shellQuote(target)} && chmod 600 -- ${shellQuote(target)}`);
    return target;
  }

  async syncEntry(location, entry, syncEnv) {
    if (!syncEnv) {
      entry.directoryBridge?.close();
      entry.directoryBridge = null;
      entry.directoryAccess = null;
      entry.syncedRemoteEnv = false;
      return;
    }
    if (this.approveDirectory && !entry.directoryBridge) {
      const access = new DirectoryAccess({
        approve: details => this.approveDirectory(location.name, details),
        changed: () => this.emit?.(),
      });
      const bridge = await createDirectoryAccessBridge(access);
      try {
        entry.directoryBridge = await reverseRoutes.expose(entry.client, bridge);
        entry.directoryAccess = access;
      } catch (error) {
        bridge.close();
        throw error;
      }
    }
    entry.remoteEnvPath = await this.syncRemoteTunnelEnv(location.id, entry.client, entry.remotePort, entry.secret, entry.directoryBridge);
    entry.syncedRemoteEnv = true;
  }

  async setupAndStart(locationId, options = {}) {
    if (this.closed) throw new Error('MCP 隧道管理器已关闭。');
    const location = this.store.get('locations', locationId);
    if (location.type !== 'ssh' || location.os !== 'linux') {
      throw new Error('仅 Linux SSH 位置支持配置 MCP 反向隧道。');
    }
    if (location.managed) {
      await this.locations.connect(locationId);
      this.emit?.();
      return this.statusFor(locationId);
    }
    if (this.pending.has(locationId)) return this.pending.get(locationId);
    const task = this._startCustom(location, options).finally(() => {
      this.pending.delete(locationId);
      this.emit?.();
    });
    this.pending.set(locationId, task);
    this.emit?.();
    return task;
  }

  async _startCustom(location, options = {}) {
    this.lastError.delete(location.id);
    const cfg = defaultTunnelConfig(location);
    const preferredPort = Number.isInteger(options.remotePort) ? options.remotePort : cfg.remotePort;
    const syncEnv = options.syncRemoteEnv !== undefined ? Boolean(options.syncRemoteEnv) : cfg.syncRemoteEnv;
    try {
      const { localPort, secret } = await this.ensureLocalMcp();
      const client = await this.locations.connect(location.id);
      const existing = this.active.get(location.id);
      if (existing && existing.client === client && existing.localPort === localPort) {
        try {
          await this.probeRemote(client, existing.remotePort, secret);
          if (syncEnv !== existing.syncedRemoteEnv) await this.syncEntry(location, existing, syncEnv);
          return this.statusFor(location.id);
        } catch {
          await this.stop(location.id);
        }
      } else if (existing) {
        await this.stop(location.id);
      }

      const forward = port => new Promise(resolve => client.forwardIn('127.0.0.1', port, err => resolve(err || null)));
      let boundPort = preferredPort;
      let owned = false;
      const firstErr = await forward(preferredPort);
      if (!firstErr) {
        owned = true;
      } else {
        let reusable = false;
        try {
          await this.probeRemote(client, preferredPort, secret);
          reusable = true;
        } catch {}
        if (!reusable) {
          const candidates = await this.findRemotePorts(location.id, preferredPort);
          let lastErr = firstErr;
          let found = false;
          for (const candidate of candidates) {
            const err = await forward(candidate);
            if (!err) {
              boundPort = candidate;
              owned = true;
              found = true;
              break;
            }
            lastErr = err;
          }
          if (!found) {
            throw new Error(`SSH 无法在服务器转发任何可用端口：${lastErr.message}`);
          }
        }
      }

      let removeRoute = () => {};
      if (owned) {
        removeRoute = reverseRoutes.add(client, boundPort, localPort);
      }
      try {
        await this.probeRemote(client, boundPort, secret);
      } catch (error) {
        removeRoute();
        if (owned) {
          try { client.unforwardIn('127.0.0.1', boundPort, () => {}); } catch {}
        }
        throw error;
      }

      const entry = {
        client,
        remotePort: boundPort,
        localPort,
        secret,
        owned,
        syncedRemoteEnv: false,
        remoteEnvPath: '',
        cleanup: () => {
          entry.directoryBridge?.close();
          removeRoute();
          if (owned) {
            try { client.unforwardIn('127.0.0.1', boundPort, () => {}); } catch {}
          }
        },
      };
      try {
        await this.syncEntry(location, entry, syncEnv);
        if (this.closed) throw new Error('MCP 隧道管理器已关闭。');
      } catch (error) {
        entry.cleanup();
        throw error;
      }
      this.active.set(location.id, entry);
      client.once('close', () => {
        if (this.active.get(location.id) === entry) {
          entry.cleanup();
          this.active.delete(location.id);
          this.emit?.();
        }
      });
      return this.statusFor(location.id);
    } catch (error) {
      this.lastError.set(location.id, error.message);
      throw error;
    }
  }

  async stop(locationId) {
    const location = this.store.get('locations', locationId);
    if (location.managed) {
      this.backend.stop();
      this.emit?.();
      return this.statusFor(locationId);
    }
    const entry = this.active.get(locationId);
    if (entry) {
      this.active.delete(locationId);
      entry.cleanup();
    }
    this.lastError.delete(locationId);
    this.emit?.();
    return this.statusFor(locationId);
  }

  revokeDirectoryAccess(locationId) {
    this.active.get(locationId)?.directoryAccess?.revoke();
  }

  async ensureForAgent(locationId) {
    const location = this.store.get('locations', locationId);
    if (location.managed || location.type !== 'ssh' || location.os !== 'linux') return null;
    if (!location.mcpTunnel?.enabled && !this.active.has(locationId)) return null;
    const status = await this.setupAndStart(locationId);
    const entry = this.active.get(locationId);
    if (!entry || status.state !== 'ready') return null;
    return {
      url: `http://127.0.0.1:${entry.remotePort}/mcp`,
      token: entry.secret,
    };
  }

  async startupAutoStart() {
    for (const location of this.store.state.locations) {
      if (location.type === 'ssh' && location.os === 'linux' && location.mcpTunnel?.autoStart) {
        try {
          await this.setupAndStart(location.id);
        } catch (error) {
          this.lastError.set(location.id, error.message);
          this.emit?.();
        }
      }
    }
  }

  statusFor(locationId) {
    const location = this.store.state.locations.find(l => l.id === locationId);
    if (!location || location.type !== 'ssh' || location.os !== 'linux') {
      return { state: 'unsupported', remotePort: null, localPort: null, syncedRemoteEnv: false, remoteEnvPath: '', error: '' };
    }
    if (location.managed) {
      const state = this.backend.status.tunnel === 'ready'
        ? 'ready'
        : this.backend.status.ssh === 'connecting' || this.backend.status.mcp === 'starting'
          ? 'connecting'
          : 'off';
      return {
        state,
        remotePort: this.backend.remotePort || null,
        localPort: this.backend.localPort || null,
        syncedRemoteEnv: state === 'ready',
        remoteEnvPath: this.backend.remoteDir ? `${this.backend.remoteDir}/.env` : '',
        error: this.lastError.get(locationId) || '',
      };
    }
    const entry = this.active.get(locationId);
    if (entry) {
      return {
        state: 'ready',
        remotePort: entry.remotePort,
        localPort: entry.localPort,
        syncedRemoteEnv: entry.syncedRemoteEnv,
        remoteEnvPath: entry.remoteEnvPath,
        directoryRequests: entry.directoryAccess?.summary() || [],
        error: '',
      };
    }
    if (this.pending.has(locationId)) {
      return {
        state: 'connecting',
        remotePort: defaultTunnelConfig(location).remotePort,
        localPort: this.backend.localPort || null,
        syncedRemoteEnv: false,
        remoteEnvPath: '',
        error: '',
      };
    }
    return {
      state: this.lastError.has(locationId) ? 'error' : 'off',
      remotePort: defaultTunnelConfig(location).remotePort,
      localPort: this.backend.localPort || null,
      syncedRemoteEnv: false,
      remoteEnvPath: '',
      error: this.lastError.get(locationId) || '',
    };
  }

  status() {
    const tunnels = {};
    for (const location of this.store.state.locations) {
      if (location.type === 'ssh' && location.os === 'linux') {
        tunnels[location.id] = this.statusFor(location.id);
      }
    }
    return {
      localMcp: {
        state: this.backend.status.mcp || 'unknown',
        localPort: this.backend.localPort || null,
        forceControl: this.backend.appliedForceControl,
        error: this.backend.controlError || '',
      },
      tunnels,
    };
  }

  close() {
    this.closed = true;
    for (const entry of this.active.values()) {
      try { entry.cleanup(); } catch {}
    }
    this.active.clear();
  }
}

module.exports = { McpTunnels, defaultTunnelConfig, formatTunnelEnv };
