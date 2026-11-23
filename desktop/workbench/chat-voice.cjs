const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { levelVoiceWav } = require('./voice-level.cjs');

const localModels = new Set([
  'Fish Audio Drama 3', 'Qwen TTS 0.6B Base', 'Qwen TTS 1.7B Base', 'Qwen TTS 1.7B VoiceDesign',
]);
const maxRecording = 8 * 1024 * 1024;
const maxSpeech = 24 * 1024 * 1024;
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const credentialKey = (chatId, url) => 'voice:' + chatId + ':' + createHash('sha256').update(url || '').digest('hex');

function model(value, inherit = false) {
  const source = value?.source || (inherit ? 'inherit' : 'remote');
  if (inherit && source === 'inherit') return { source };
  const id = text(value?.id, 200);
  if ((source === 'remote' && !/[\x00-\x1f]/.test(id)) || (source === 'local' && localModels.has(id))) return { source, id };
  throw new Error('请选择受支持的语音合成模型。');
}

function baseUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch {}
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url?.hostname);
  if (!url || url.protocol !== 'https:' && !(loopback && url.protocol === 'http:') ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('语音服务地址须使用 HTTPS，本机地址也可使用 HTTP。请把密钥单独填入密钥栏。');
  }
  return url.href.replace(/\/+$/, '');
}

function settings(value) {
  const transcription = value?.transcription || 'local';
  if (!['off', 'local', 'remote'].includes(transcription)) throw new Error('请选择有效的转写方式。');
  const directory = text(value?.directory, 4096);
  const python = text(value?.python, 4096);
  if ([directory, python].some(item => item && (!path.isAbsolute(item) || /[\x00-\x1f]/.test(item)))) {
    throw new Error('原语音资源目录和 Python 路径须使用本机绝对路径。');
  }
  return {
    enabled: value?.enabled === true, inputEnabled: value?.inputEnabled === true && transcription !== 'off',
    model: model(value?.model), baseUrl: baseUrl(text(value?.baseUrl, 2048)), directory, python,
    transcription, transcriptionModel: text(value?.transcriptionModel, 200),
  };
}

function roleSettings(value) {
  const reference = text(value?.reference, 4096);
  if (reference && (!path.isAbsolute(reference) || /[\x00-\x1f]/.test(reference))) {
    throw new Error('请选择本机参考录音文件。');
  }
  return {
    model: model(value?.model, true), voice: text(value?.voice, 200), style: text(value?.style, 2000),
    reference, transcript: text(value?.transcript, 4000), language: value?.language === 'en' ? 'en' : 'zh',
    voiceModel: model(value?.voiceModel),
  };
}

function effectiveModel(chat, roleId) {
  const chosen = chat.roleVoices?.[roleId]?.model;
  return chosen?.source && chosen.source !== 'inherit' ? chosen : chat.voice?.model;
}

function speechFor(chat, roleId) {
  const voice = chat.roleVoices?.[roleId];
  const selected = effectiveModel(chat, roleId);
  if (!selected?.id) throw new Error('请先选择语音合成模型。');
  if (!voice || selected.source !== voice.voiceModel?.source || selected.id !== voice.voiceModel.id) {
    throw new Error('请在此角色的会话设置中为当前语音模型选择声音。');
  }
  const missingVoice = selected.source === 'remote' ? !voice.voice :
    (selected.id.endsWith(' Base') && !voice.reference ||
      selected.id === 'Qwen TTS 1.7B VoiceDesign' && !voice.style ||
      selected.id === 'Fish Audio Drama 3' && (voice.reference ? !voice.transcript : !voice.style));
  if (missingVoice) {
    throw new Error('请补全此角色的音色、声音描述或参考录音设定。');
  }
  return { ...voice, model: selected };
}

function spokenText(value) {
  return value.replace(/^[ \t]*```[^\n]*\n[\s\S]*?(?:^[ \t]*```[^\n]*$|(?![\s\S]))/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*])\s+/gm, '')
    .replace(/[`*_~]/g, '').trim().slice(0, 4000);
}

class LocalVoice {
  constructor(runtimeDirectory, changed) {
    this.runtimeDirectory = runtimeDirectory;
    this.queue = Promise.resolve();
    this.changed = changed;
  }

  status() {
    const { model, pending } = this.worker || {};
    return { model: model || null, loading: pending?.target || null };
  }

  enqueue(operation) {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }

  request(config, value, signal) {
    const run = this.enqueue(() => {
      signal.throwIfAborted();
      return this.send(config, value);
    });
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      run.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }

  send(config, value) {
    const { directory, python } = config;
    const key = JSON.stringify([directory, python]);
    if (this.worker?.key !== key) {
      this.close();
      const executable = python || process.env.VOICE_DESK_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
      const args = executable === 'py' ? ['-3.12'] : [];
      const env = { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
      if (directory) for (const [variable, folder] of [['RELAY_VOICE_DEPS', 'deps'], ['RELAY_VOICE_MODELS', 'asr-models']]) {
        const previous = path.join(directory, '.runtime', folder);
        if (!env[variable] && !fs.existsSync(path.join(this.runtimeDirectory, folder)) && fs.existsSync(previous)) env[variable] = previous;
      }
      const child = spawn(executable, [...args, '-u', path.join(__dirname, 'chat-voice-worker.py'), this.runtimeDirectory],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
      const worker = { key, child };
      this.worker = worker;
      const lines = readline.createInterface({ input: child.stdout, terminal: false });
      lines.on('line', line => {
        try { worker.pending?.finish(null, JSON.parse(line)); }
        catch { worker.pending?.finish(new Error('本地语音服务返回了无法读取的结果。')); }
      });
      child.stderr.on('data', chunk => console.error('Local voice worker:', chunk.toString().trimEnd()));
      const failed = () => {
        if (this.worker === worker) this.worker = undefined;
        worker.pending?.finish(new Error('本地语音服务已退出。请检查 Python 和本地语音依赖。'));
        this.changed();
      };
      child.on('error', failed);
      child.on('exit', failed);
      child.stdin.on('error', () => {
        failed();
        child.kill();
      });
    }
    return this.sendToWorker(this.worker, value);
  }

  sendToWorker(worker, value) {
    return new Promise((resolve, reject) => {
      const target = value.model?.id;
      worker.pending = { target: target !== worker.model ? target : undefined, finish: (error, result) => {
        clearTimeout(timer);
        worker.pending = undefined;
        if (result) worker.model = result.model;
        this.changed();
        if (error || result?.error) reject(error || new Error('本地语音处理失败，请检查模型和依赖。\n' + result.error));
        else resolve(result);
      } };
      const timer = setTimeout(() => {
        worker.pending?.finish(new Error('等待本地语音服务超时，请检查模型是否已安装。'));
        if (this.worker === worker) this.close();
      }, 240000);
      worker.child.stdin.write(JSON.stringify(value) + '\n');
      this.changed();
    });
  }

  release() {
    return this.enqueue(() => {
      if (this.worker?.model) return this.sendToWorker(this.worker, { type: 'release-speech' });
    });
  }

  close() {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    worker.pending?.finish(new Error('本地语音服务已停止。'));
    this.changed();
    worker.child.stdin.end();
    const timer = setTimeout(() => worker.child.kill(), 20000);
    timer.unref();
    worker.child.once('exit', () => clearTimeout(timer));
  }
}

class ChatVoice {
  constructor(fetch, vault, runtimeDirectory, localChanged = () => {}) {
    this.fetch = fetch;
    this.vault = vault;
    this.local = new LocalVoice(runtimeDirectory, localChanged);
    this.requests = new Map();
  }

  async run(chat, sender, requestId, operation) {
    if (!chat.voice?.enabled || chat.disbandedAt) throw new Error('请先在对话设置中开启语音。');
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) throw new Error('语音请求无效。');
    const key = sender.id + ':' + requestId;
    if (this.requests.has(key) || this.requests.size >= 8) throw new Error('语音服务正忙，请稍后再试。');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    sender.once('destroyed', cancel);
    this.requests.set(key, { chatId: chat.id, cancel });
    try { return await operation(controller.signal); }
    finally {
      sender.removeListener('destroyed', cancel);
      this.requests.delete(key);
    }
  }

  cancel(sender, requestId) { this.requests.get(sender.id + ':' + requestId)?.cancel(); }
  cancelChat(chatId) {
    for (const item of this.requests.values()) if (item.chatId === chatId) item.cancel();
  }
  close() {
    for (const item of this.requests.values()) item.cancel();
    this.local.close();
  }

  async remote(chat, route, body, signal, headers = {}) {
    const url = chat.voice.baseUrl;
    if (!url) throw new Error('请在对话语音设置中填写远程服务地址。');
    const apiKey = this.vault.get(credentialKey(chat.id, url));
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    try {
      const response = await this.fetch(url + '/audio/' + route, {
        method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('远程语音服务请求失败，请检查服务地址、密钥和模型。\n' + error.message);
    }
  }

  async speak(chat, messageId, signal) {
    const message = chat.messages.find(item => item.id === messageId);
    if (message?.kind !== 'assistant' || message.status !== 'complete' || message.moderatorTask ||
        !chat.roleIds.includes(message.roleId)) throw new Error('请选择当前对话角色已完成的回复。');
    const input = spokenText(message.text || '');
    if (!input) return null;
    return this.synthesize(chat, speechFor(chat, message.roleId), input, signal);
  }

  async synthesize(chat, voice, input, signal) {
    if (voice.model.source === 'local') {
      const result = await this.local.request(chat.voice, { type: 'speech', input, ...voice }, signal);
      signal.throwIfAborted();
      return levelVoiceWav(Buffer.from(result.wav, 'base64'));
    }
    const response = await this.remote(chat, 'speech', JSON.stringify({
      input, model: voice.model.id, voice: voice.voice, response_format: 'wav',
      ...(voice.style ? { instructions: voice.style } : {}),
    }), signal, { 'Content-Type': 'application/json' });
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body || []) {
        bytes += chunk.byteLength;
        if (bytes > maxSpeech) break;
        chunks.push(chunk);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('接收语音失败，请检查远程服务后再试。\n' + error.message);
    }
    if (bytes > maxSpeech) throw new Error('生成的语音过长，请缩短回复后再试。');
    const wav = Buffer.concat(chunks, bytes);
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('远程语音服务未返回 WAV 音频。');
    }
    return levelVoiceWav(wav);
  }

  async transcribe(chat, recording, signal, format = 'webm') {
    if (!(recording instanceof ArrayBuffer) || !recording.byteLength || recording.byteLength > maxRecording) {
      throw new Error('没有可转写的录音，或录音过长。');
    }
    const { transcription, transcriptionModel } = chat.voice;
    if (transcription === 'local') {
      const result = await this.local.request(chat.voice, {
        type: 'transcription', audio: Buffer.from(recording).toString('base64'),
      }, signal);
      signal.throwIfAborted();
      return text(result.text, 30000);
    }
    if (transcription !== 'remote' || !transcriptionModel) throw new Error('请先配置语音转写模型。');
    const form = new FormData();
    form.append('file', new Blob([recording], { type: 'audio/' + format }), 'recording.' + format);
    form.append('model', transcriptionModel);
    const response = await this.remote(chat, 'transcriptions', form, signal);
    try { return text((await response.json()).text, 30000); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new Error('远程服务没有返回可读取的转写结果。\n' + error.message);
    }
  }
}

module.exports = { ChatVoice, settings, roleSettings, speechFor, spokenText, credentialKey };
