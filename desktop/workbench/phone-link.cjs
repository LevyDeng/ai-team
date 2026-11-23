const tls = require('node:tls');
const { networkInterfaces } = require('node:os');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const frame = { auth: 1, listen: 2, stop: 3, mic: 4, text: 5, played: 6,
  ready: 10, phase: 11, message: 12, audio: 14, error: 16 };

function privateAddress(address) {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address || '');
}

function addresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => entries
    .filter(item => item.family === 'IPv4' && !item.internal && privateAddress(item.address))
    .map(item => ({ name, address: item.address })));
}

function pairingTool(runtime, config, args, input = '') {
  const python = config?.python || process.env.VOICE_DESK_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const launcher = python === 'py' ? ['-3.12'] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(python, [...launcher, path.join(__dirname, 'voice-runtime', 'pairing.py'), runtime, ...args],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const error = () => new Error('手机配对组件启动失败。请先安装 AI 小队语音运行时依赖。');
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
  constructor({ runtime, getChat, live, submit, changed, identity = pairingTool }) {
    Object.assign(this, { runtime, getChat, live, submit, changed, identity });
  }

  status() {
    const entry = this.entry;
    return entry && { chatId: entry.chatId, connected: Boolean(entry.socket), address: entry.address };
  }

  async open(chatId, address) {
    const chat = this.getChat(chatId);
    if (!chat || chat.disbandedAt || chat.workflow) throw new Error('请选择可发送消息的会话。');
    if (!addresses().some(item => item.address === address)) throw new Error('请选择电脑在当前局域网中的地址。');
    if (this.entry?.chatId === chatId && this.entry.address === address && this.entry.ui) return this.entry.ui;
    if (this.entry) throw new Error('请先关闭现有手机连接。');
    const entry = { chatId, address, token: randomBytes(16).toString('hex'), sockets: new Set(), expires: Date.now() + 600000 };
    this.entry = entry;
    try {
      const identity = await this.identity(this.runtime, chat.voice, ['identity', address]);
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
      const qr = await this.identity(this.runtime, chat.voice, ['qr'], code);
      if (this.entry !== entry) throw new Error('配对已关闭。');
      entry.expiration = setTimeout(() => { if (this.entry === entry && !entry.socket) this.close(); }, 600000);
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
    if (entry.socket) this.live.stop(entry.chatId, entry.socket);
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
        else if (kind === frame.auth && !entry.socket && Date.now() < entry.expires &&
            len === 32 && timingSafeEqual(payload, Buffer.from(entry.token))) {
          entry.socket = socket;
          entry.listening = false;
          entry.lastState = '';
          entry.messages = new Map();
          socket.setTimeout(0);
          this.live.stop(entry.chatId);
          this.send(entry, frame.ready, { name: this.getChat(entry.chatId)?.name || '' });
          this.sync();
          this.changed();
        } else socket.destroy();
      }
    });
    socket.once('close', () => {
      if (entry.socket !== socket || this.entry !== entry) return;
      this.live.stop(entry.chatId, socket);
      entry.socket = null;
      if (Date.now() >= entry.expires) this.close();
      else this.changed();
    });
  }

  receive(entry, kind, payload) {
    try {
      if (kind === frame.listen) {
        entry.listening = true;
        this.sync();
      } else if (kind === frame.stop) {
        entry.listening = false;
        this.sync();
      } else if (kind === frame.mic && entry.listening) {
        this.live.frame(entry.chatId, entry.socket, payload);
      } else if (kind === frame.text) {
        const value = payload.toString('utf8').trim();
        if (value) this.submit(entry.chatId, value);
      } else if (kind === frame.played) {
        const { messageId, index } = JSON.parse(payload.toString('utf8'));
        this.live.played(entry.chatId, entry.socket, messageId, index);
      }
    } catch (error) { this.send(entry, frame.error, { message: error.message }); }
  }

  sync() {
    const entry = this.entry;
    if (!entry?.socket) return;
    const chat = this.getChat(entry.chatId);
    if (!chat || chat.disbandedAt || chat.workflow) { this.close(); return; }
    const desired = chat.voice?.enabled || (entry.listening && chat.voice?.inputEnabled);
    if (!desired) this.live.stop(entry.chatId, entry.socket);
    else this.live.start(entry.chatId, entry.socket, (kind, value) => {
      if (kind === 'audio') {
        const { audio, ...metadata } = value;
        const json = Buffer.from(JSON.stringify(metadata));
        const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
        this.send(entry, frame.audio, Buffer.concat([size, json, audio]));
      } else if (kind === 'phase') this.sendState(entry, this.getChat(entry.chatId));
      else this.send(entry, frame[kind], value);
    });
    this.sendState(entry, chat);
    for (const message of chat.messages.slice(-30)) this.message(chat.id, message);
  }

  sendState(entry, chat) {
    if (!chat) return;
    const state = { phase: this.live.sessions.get(chat.id)?.phase || 'off',
      input: chat.voice?.inputEnabled === true, output: chat.voice?.enabled === true };
    const key = JSON.stringify(state);
    if (key === entry.lastState) return;
    entry.lastState = key;
    this.send(entry, frame.phase, state);
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
