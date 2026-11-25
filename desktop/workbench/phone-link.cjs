const tls = require('node:tls');
const { networkInterfaces } = require('node:os');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const frame = { auth: 1, text: 5, remember: 8, resume: 9, ready: 10, message: 12, error: 16, ping: 17, pong: 18, saved: 19 };
const pairingWindow = 600000;

function matchesToken(payload, token) {
  return Boolean(token) && payload.length === 32 && timingSafeEqual(payload, Buffer.from(token));
}

function privateAddress(address) {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address || '');
}

function addresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => entries
    .filter(item => item.family === 'IPv4' && !item.internal && privateAddress(item.address))
    .map(item => ({ name, address: item.address })));
}

function pairingTool(runtime, args, input = '', dependencyDirectory) {
  const python = process.env.AI_TEAM_PHONE_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const launcher = python === 'py' ? ['-3.12'] : [];
  const env = dependencyDirectory ? { ...process.env, AI_TEAM_PHONE_DEPS: dependencyDirectory } : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(python, [...launcher, path.join(__dirname, 'phone-pairing.py'), runtime, ...args],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const error = () => new Error('手机配对组件启动失败。请检查是否已安装 Python 3.12、cryptography 和 qrcode。');
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(error()); }, 12000);
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part; if (stdout.length > 40000) child.kill(); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(error()); });
    child.once('close', code => {
      clearTimeout(timer);
      try { if (code !== 0) throw error(); resolve(JSON.parse(stdout)); }
      catch { reject(error()); }
    });
    child.stdin.end(input);
  });
}

class PhoneLink {
  constructor({ runtime, getChat, submit, changed, dependencyDirectory, allowReconnect = false,
    identity = (directory, args, input) => pairingTool(directory, args, input, dependencyDirectory) }) {
    Object.assign(this, { runtime, getChat, submit, changed, identity, allowReconnect });
  }

  status() {
    const entry = this.entry;
    return entry && { chatId: entry.chatId, connected: Boolean(entry.socket), address: entry.address,
      ...(this.allowReconnect ? { remembered: Boolean(entry.resumeToken) } : {}) };
  }

  async open(chatId, address) {
    const chat = this.getChat(chatId);
    if (!chat || chat.disbandedAt || chat.workflow) throw new Error('请选择可发送消息的会话。');
    if (!addresses().some(item => item.address === address)) throw new Error('请选择电脑在当前局域网中的地址。');
    if (this.entry?.chatId === chatId && this.entry.address === address && this.entry.ui) {
      if (this.allowReconnect && Date.now() >= this.entry.expires) {
        throw new Error('配对码已过期。已配对的手机可直接重连。要重新扫码，请先关闭手机连接再开启。');
      }
      return this.entry.ui;
    }
    if (this.entry) throw new Error('请先关闭现有手机连接。');
    const entry = { chatId, address, token: randomBytes(16).toString('hex'), sockets: new Set() };
    this.entry = entry;
    try {
      const identity = await this.identity(this.runtime, ['identity', address, ...(this.allowReconnect ? ['365'] : [])]);
      if (this.entry !== entry) throw new Error('配对已关闭。');
      const server = entry.server = tls.createServer({ ...identity, minVersion: 'TLSv1.2', handshakeTimeout: 5000 },
        socket => this.connect(entry, socket));
      server.on('connection', socket => {
        if (entry.sockets.size >= 8) { socket.destroy(); return; }
        entry.sockets.add(socket);
        socket.once('close', () => entry.sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, address, () => { server.removeListener('error', reject); resolve(); });
      });
      server.on('error', () => { if (this.entry === entry) this.close(); });
      if (this.entry !== entry) throw new Error('配对已关闭。');
      const code = address + ':' + server.address().port + '/' + identity.fingerprint + '/' + entry.token;
      const qr = await this.identity(this.runtime, ['qr'], code);
      if (this.entry !== entry) throw new Error('配对已关闭。');
      entry.expires = Date.now() + pairingWindow;
      entry.expiration = setTimeout(() => {
        if (this.entry === entry && !entry.resumeToken && !entry.socket) this.close();
      }, pairingWindow);
      entry.expiration.unref();
      this.changed();
      return entry.ui = { code, qr };
    } catch (error) {
      if (this.entry === entry) this.close();
      throw error;
    }
  }

  close() {
    const entry = this.entry;
    if (!entry) return;
    this.entry = null;
    clearTimeout(entry.expiration);
    for (const socket of entry.sockets) socket.destroy();
    entry.socket?.destroy();
    entry.server?.close();
    this.changed();
  }

  connect(entry, socket) {
    if (this.entry !== entry || !privateAddress(socket.remoteAddress)) { socket.destroy(); return; }
    let buffer = Buffer.alloc(0);
    socket.on('error', () => socket.destroy());
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', chunk => {
      if (chunk.length + buffer.length > 128 * 1024) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      while (!socket.destroyed && buffer.length >= 5) {
        const kind = buffer[0], len = buffer.readUInt32BE(1);
        if (len > 8192) { socket.destroy(); return; }
        if (buffer.length < 5 + len) return;
        const payload = buffer.subarray(5, 5 + len);
        buffer = buffer.subarray(5 + len);
        if (entry.socket === socket) this.receive(entry, kind, payload);
        else if ((kind === frame.auth && !entry.socket && Date.now() < entry.expires && matchesToken(payload, entry.token)) ||
            (this.allowReconnect && kind === frame.resume && matchesToken(payload, entry.resumeToken))) {
          const previous = entry.socket;
          entry.socket = socket;
          if (kind === frame.auth) entry.resumeToken = undefined;
          previous?.destroy();
          entry.messages = new Map();
          socket.setTimeout(0);
          if (this.allowReconnect) socket.setKeepAlive(true, 30000);
          this.send(entry, frame.ready, { name: this.getChat(entry.chatId)?.name || '' });
          this.sync();
          this.changed();
        } else socket.destroy();
      }
    });
    socket.once('close', () => {
      if (entry.socket !== socket || this.entry !== entry) return;
      entry.socket = null;
      if (!entry.resumeToken && Date.now() >= entry.expires) this.close();
      else this.changed();
    });
  }

  receive(entry, kind, payload) {
    if (this.allowReconnect && !payload.length) {
      if (kind === frame.remember) {
        const token = entry.resumeToken ||= randomBytes(16).toString('hex');
        this.send(entry, frame.saved, { token });
        this.changed();
        return;
      }
      if (kind === frame.ping) {
        this.send(entry, frame.pong, Buffer.alloc(0));
        return;
      }
    }
    if (kind !== frame.text) return;
    try {
      const value = payload.toString('utf8').trim();
      if (value) this.submit(entry.chatId, value);
    } catch (error) { this.send(entry, frame.error, { message: error.message }); }
  }

  sync() {
    const entry = this.entry;
    if (!entry?.socket) return;
    const chat = this.getChat(entry.chatId);
    if (!chat || chat.disbandedAt || chat.workflow) { this.close(); return; }
    for (const message of chat.messages.slice(-30)) this.message(chat.id, message);
  }

  message(chatId, message) {
    const entry = this.entry;
    if (entry?.chatId !== chatId || !entry.socket || !['assistant', 'user'].includes(message.kind) ||
        message.moderatorTask || message.branchContext) return;
    const view = { id: message.id, type: message.kind, roleId: message.roleId,
      roleName: message.roleName, text: (message.text || '').slice(0, 12000), status: message.status };
    const json = JSON.stringify(view);
    if (entry.messages.get(message.id) === json) return;
    if (entry.messages.size >= 100) entry.messages.delete(entry.messages.keys().next().value);
    entry.messages.set(message.id, json);
    this.send(entry, frame.message, view);
  }

  send(entry, type, value) {
    const socket = entry.socket;
    if (!socket || socket.destroyed) return;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    if (bytes.length > 16 * 1024 * 1024 || socket.writableLength + bytes.length > 17 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    const header = Buffer.alloc(5); header[0] = type; header.writeUInt32BE(bytes.length, 1);
    socket.write(Buffer.concat([header, bytes]));
  }
}

module.exports = { PhoneLink, addresses };
