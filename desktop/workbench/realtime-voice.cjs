const { speechFor, spokenText } = require('./chat-voice.cjs');

const sampleRate = 16000;
const frameBytes = 3200;
const playbackDeadline = 90000;

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Uint8Array.from(Buffer.concat([header, pcm])).buffer;
}

class Utterance {
  constructor() { this.reset(); this.noise = 100; }
  reset() { this.lead = []; this.parts = []; this.voiced = 0; this.quiet = 0; }

  feed(frame) {
    if (frame.length !== frameBytes) return;
    let sum = 0;
    for (let i = 0; i < frame.length; i += 2) sum += frame.readInt16LE(i) ** 2;
    const rms = Math.sqrt(sum / (frame.length / 2));
    const speech = rms > Math.max(275, this.noise * 3);
    if (!this.parts.length) {
      this.lead.push(frame);
      if (this.lead.length > 5) this.lead.shift();
      this.voiced = speech ? this.voiced + 1 : 0;
      if (!speech) this.noise = this.noise * 0.93 + rms * 0.07;
      if (this.voiced >= 3) this.parts = this.lead.splice(0);
      return;
    }
    this.parts.push(frame);
    this.quiet = speech ? 0 : this.quiet + 1;
    if (this.quiet < 8 && this.parts.length < 450) return;
    const pcm = Buffer.concat(this.parts.slice(0, this.parts.length - Math.max(0, this.quiet - 2)));
    this.reset();
    return wav(pcm);
  }
}

function takePhrases(text, done) {
  const phrases = [];
  let offset = 0;
  const boundary = /[。！？!?；;](?:[”’"」』])?|[.](?=\s)|\n/g;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    const phrase = text.slice(offset, end);
    if (phrase.trim().length < 8 && !done) continue;
    phrases.push(phrase); offset = end;
  }
  while (text.length - offset > 160) {
    const cut = text.slice(offset, offset + 160).search(/\s[^\s]*$/);
    const end = offset + (cut > 90 ? cut + 1 : 160);
    phrases.push(text.slice(offset, end)); offset = end;
  }
  if (done && offset < text.length) { phrases.push(text.slice(offset)); offset = text.length; }
  return { phrases: phrases.map(spokenText).filter(Boolean), consumed: offset };
}

function visiblePrefix(text, done) {
  let fence = null;
  const lines = [];
  for (const line of text.split(/(?<=\n)/)) {
    const mark = line.match(/^[ \t]*(```+|~~~+)/)?.[1];
    if (mark) {
      if (!fence) fence = mark[0];
      else if (fence === mark[0]) fence = null;
      continue;
    }
    if (!fence) lines.push(line);
  }
  const joined = lines.join('');
  return done ? joined : joined.replace(/(?:^|\n)[ \t]*(?:\x60{1,2}|~{1,2})$/, '');
}

class RealtimeVoice {
  constructor({ voice, getChat, busy, submit }) {
    Object.assign(this, { voice, getChat, busy, submit });
    this.sessions = new Map();
  }

  start(chatId, owner, deliver) {
    const chat = this.getChat(chatId);
    if (!chat || chat.disbandedAt || chat.workflow || (!chat.voice?.enabled && !chat.voice?.inputEnabled)) {
      throw new Error('请先为这个对话开启语音输入或输出。');
    }
    const existing = this.sessions.get(chatId);
    if (existing?.owner === owner) return;
    if (existing) throw new Error('这个对话已在另一台设备上使用语音。');
    const session = { chatId, owner, deliver, detector: new Utterance(), replies: new Map(), queue: [],
      controller: new AbortController(), active: null, phase: '' };
    this.sessions.set(chatId, session);
    this.sync(chatId);
  }

  stop(chatId, owner) {
    const session = this.sessions.get(chatId);
    if (!session || (owner !== undefined && session.owner !== owner)) return;
    this.sessions.delete(chatId);
    session.controller.abort();
    session.active?.finish();
    session.deliver('phase', { phase: 'off' });
  }

  close() { for (const id of this.sessions.keys()) this.stop(id); }

  frame(chatId, owner, frame) {
    const session = this.sessions.get(chatId);
    if (session?.owner !== owner || session.phase !== 'listening') return;
    if (frame.length !== frameBytes) return;
    const audio = session.detector.feed(Buffer.from(frame));
    if (!audio) return;
    session.transcribing = true;
    this.sync(chatId);
    void this.sendUtterance(session, audio);
  }

  async sendUtterance(session, audio) {
    const { chatId, controller } = session;
    try {
      const text = await this.voice.transcribe(this.getChat(chatId), audio, controller.signal, 'wav');
      controller.signal.throwIfAborted();
      const chat = this.getChat(chatId);
      if (chat?.voice?.inputEnabled && text) this.submit(chatId, text);
    } catch (error) {
      if (!controller.signal.aborted) session.deliver('error', { message: error.message });
    } finally {
      session.transcribing = false;
      this.sync(chatId);
    }
  }

  message(chatId, message) {
    const session = this.sessions.get(chatId), chat = this.getChat(chatId);
    if (!session || !chat?.voice?.enabled || message.kind !== 'assistant' || message.branchContext ||
        message.moderatorTask || !['running', 'complete'].includes(message.status) || !chat.roleIds.includes(message.roleId)) return;
    let reply = session.replies.get(message.id);
    if (!reply) {
      if (session.replies.size >= 500) session.replies.delete(session.replies.keys().next().value);
      reply = { prefix: '', index: 0, complete: false };
      session.replies.set(message.id, reply);
    }
    if (reply.complete) return;
    const done = message.status === 'complete', visible = visiblePrefix(message.text || '', done);
    reply.complete = done;
    // Native adapters can replace a partial answer. Advance only over a stable spoken prefix.
    if (!visible.startsWith(reply.prefix)) return;
    const rest = visible.slice(reply.prefix.length);
    const { phrases, consumed } = takePhrases(rest, done);
    reply.prefix += rest.slice(0, consumed);
    let voice;
    try { voice = speechFor(chat, message.roleId); }
    catch (error) {
      if (done) session.deliver('error', { message: (message.roleName ? message.roleName + '：' : '') + error.message });
      return;
    }
    for (const text of phrases) {
      if (session.queue.length >= 120) break;
      session.queue.push({ messageId: message.id, roleId: message.roleId, index: ++reply.index, text, voice });
    }
    if (session.queue.length) void this.play(session);
  }

  async play(session) {
    if (session.playing) return;
    const { chatId, controller } = session;
    const playback = Promise.withResolvers();
    session.playback = playback.promise;
    session.playing = true;
    this.sync(chatId);
    try {
      while (session.queue.length && !controller.signal.aborted && this.getChat(chatId)?.voice?.enabled) {
        const { text, voice, ...segment } = session.queue.shift();
        const audio = await this.voice.synthesize(this.getChat(chatId), voice, text, controller.signal);
        controller.signal.throwIfAborted();
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            session.deliver('error', { message: '尚未收到播放完成确认，后续语音将等待。若播放已卡住，可关闭再开启语音输出。' });
          }, playbackDeadline);
          session.active = { segment, finish: () => { clearTimeout(timer); session.active = null; resolve(); } };
          session.deliver('audio', { ...segment, audio });
        });
      }
    } catch (error) {
      session.queue.length = 0;
      if (!controller.signal.aborted) session.deliver('error', { message: error.message });
    } finally {
      session.playing = false;
      session.playback = null;
      playback.resolve();
      this.sync(chatId);
    }
  }

  async whenPlaybackIdle() {
    let pending;
    while ((pending = [...this.sessions.values()].map(item => item.playback).filter(Boolean)).length) {
      await Promise.all(pending);
    }
  }

  played(chatId, owner, messageId, index) {
    const session = this.sessions.get(chatId), segment = session?.active?.segment;
    if (session?.owner === owner && segment?.messageId === messageId && segment?.index === index) session.active.finish();
  }

  sync(chatId) {
    const session = this.sessions.get(chatId), chat = this.getChat(chatId);
    if (!session) return;
    if (!chat || chat.disbandedAt || !chat.voice || (!chat.voice.enabled && !chat.voice.inputEnabled)) {
      this.stop(chatId);
      return;
    }
    const idle = !this.busy(chatId) && (!chat.inputQueue?.length || chat.queuePaused);
    const phase = session.transcribing ? 'transcribing' : session.playing ? 'playing' :
      chat.voice.enabled && !idle ? 'waiting' : chat.voice.inputEnabled ? 'listening' : 'ready';
    if (phase !== session.phase) {
      session.detector.reset();
      session.phase = phase;
      session.deliver('phase', { phase });
    }
  }
}

module.exports = { RealtimeVoice, Utterance, visiblePrefix, takePhrases, frameBytes };
