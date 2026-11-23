const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');

function silence() {
  const wav = Buffer.alloc(44 + 4800);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

async function until(check) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error('Timed out waiting for a voice smoke step.');
}

async function phoneSmoke(js, chat) {
  const addresses = await js("api['phone-addresses']()");
  assert(addresses.length, 'A private LAN address is required for the phone smoke test.');
  await js("$('chat-settings').click(); $('chat-phone-link').click()");
  await until(() => js("Boolean($('phone-start'))"));
  await js("$('phone-start').click()");
  await until(() => js("Boolean($('phone-code').value)"));
  const code = await js("$('phone-code').value");
  const [endpoint, pin, token] = code.split('/');
  const [host, port] = endpoint.split(':');
  const messages = [];
  const socket = tls.connect({ host, port: Number(port), rejectUnauthorized: false });
  socket.on('error', () => {});
  function send(kind, data) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    const head = Buffer.alloc(5); head[0] = kind; head.writeUInt32BE(payload.length, 1);
    socket.write(Buffer.concat([head, payload]));
  }
  let pending = Buffer.alloc(0);
  socket.on('data', data => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
      const length = pending.readUInt32BE(1);
      const kind = pending[0], payload = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      if (kind === 14) {
        const size = payload.readUInt32BE(0), metadata = JSON.parse(payload.subarray(4, 4 + size));
        messages.push({ kind, ...metadata });
        assert.equal(payload.toString('ascii', size + 4, size + 8), 'RIFF');
        send(6, JSON.stringify(metadata));
      } else messages.push({ kind, ...JSON.parse(payload) });
    }
  });
  try {
    await once(socket, 'secureConnect');
    assert.equal(socket.getPeerCertificate().fingerprint256.replaceAll(':', '').toLowerCase(), pin);
    send(1, token);
    await until(() => messages.some(message => message.kind === 10 && message.name === chat.name));
    send(5, 'Fixture text from the phone');
    await until(() => chat.messages.some(message => message.kind === 'user' && message.text === 'Fixture text from the phone'));
    await until(() => messages.filter(message => message.kind === 14).length >= 2);
    assert.deepEqual(messages.filter(message => message.kind === 14).slice(0, 2).map(message => message.roleId), chat.roleIds.slice(0, 2));
    assert(messages.some(message => message.kind === 12 && message.text === 'Fixture text from the phone'));
    const spokenBefore = chat.messages.filter(message => message.kind === 'user' && message.text === 'Recognized fixture speech').length;
    send(2);
    await until(() => messages.filter(message => message.kind === 11).at(-1)?.phase === 'listening');
    const voiced = Buffer.alloc(3200);
    for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(4000, i);
    for (let i = 0; i < 4; i++) send(4, voiced);
    for (let i = 0; i < 8; i++) send(4, Buffer.alloc(3200));
    await until(() => chat.messages.filter(message => message.kind === 'user' && message.text === 'Recognized fixture speech').length === spokenBefore + 1);
  } finally {
    socket.destroy();
    await js("api['phone-close']()");
  }
}

async function referencePickerSmoke(js, store, chat, dialog) {
  const existingFolder = path.join(store.directory, 'existing-voice');
  const selectedFolder = path.join(store.directory, 'selected-voices');
  for (const folder of [existingFolder, selectedFolder]) fs.mkdirSync(folder, { recursive: true });
  const existing = path.join(existingFolder, 'existing.wav');
  const selected = path.join(selectedFolder, 'role-one.wav');
  const calls = [];
  const originalPicker = dialog.showOpenDialog;
  const previousDirectory = store.state.settings.voiceReferenceDirectory;
  delete store.state.settings.voiceReferenceDirectory;
  dialog.showOpenDialog = async options => {
    calls.push(options);
    return calls.length === 1 ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] };
  };
  try {
    for (const [index, roleId] of chat.roleIds.slice(0, 2).entries()) {
      await js('openChatRole(' + JSON.stringify(roleId) + ')');
      await js("$('chat-role-voice').open = true; $('role-voice-source').value = 'local'; $('role-voice-source').onchange()");
      if (index === 0) await js("$('role-voice-reference').value = " + JSON.stringify(existing));
      await js("$('role-voice-reference-pick').onclick()");
      assert.equal(await js("$('role-voice-reference').value"), index === 0 ? selected : '');
      await js("$('dialog').close()");
    }
    assert.deepEqual(calls.map(item => item.defaultPath), [existingFolder, selectedFolder]);
    assert.equal(store.persisted().settings.voiceReferenceDirectory, selectedFolder);
  } finally {
    dialog.showOpenDialog = originalPicker;
    if (previousDirectory === undefined) delete store.state.settings.voiceReferenceDirectory;
    else store.state.settings.voiceReferenceDirectory = previousDirectory;
    store.save();
  }
}

async function localModelSmoke(js, store, chat) {
  const reference = process.env.RELAY_VOICE_SMOKE_REFERENCE;
  assert(reference && fs.existsSync(reference), 'Set RELAY_VOICE_SMOKE_REFERENCE to an existing reference recording.');
  const roleId = chat.roleIds[0];
  const model = { source: 'local', id: 'Qwen TTS 0.6B Base' };
  await js(`(async () => {
    await api['chat-voice-settings'](${JSON.stringify(chat.id)}, { model: ${JSON.stringify(model)} });
    await api['chat-role-settings'](${JSON.stringify(chat.id)}, ${JSON.stringify(roleId)}, {
      model: '', effort: '',
      voice: { model: { source: 'inherit' }, voiceModel: ${JSON.stringify(model)}, language: 'en', reference: ${JSON.stringify(reference)} },
    });
  })()`);
  await js("$('chat-settings').click(); $('chat-voice-settings-open').click(); $('voice-local-settings').open = true");
  assert.equal(await js("$('voice-model-controls').hidden"), false);
  assert.equal(await js("$('voice-model-warmup').disabled"), false);
  const total = chat.messages.length;
  await js("$('voice-model-warmup').onclick()");
  assert.equal(await js("$('voice-model-status').textContent"), '已加载 ' + model.id);
  assert.equal(chat.messages.length, total);
  assert.equal(chat.voice.enabled, false);
  await js("$('voice-model-release').onclick()");
  assert.equal(await js("$('voice-model-status').textContent"), '尚未加载本地合成模型');
  assert.equal(await js("$('voice-model-release').disabled"), true);
  await js("$('dialog').close(); $('voice-quick-output').click()");
  await until(() => chat.voice.enabled);
  const message = store.message(chat.id, { roleId, kind: 'assistant', status: 'complete', text: 'Ready again.' });
  assert.equal(await js(`(async () => {
    const audio = await api['chat-voice-speak'](${JSON.stringify(chat.id)}, crypto.randomUUID(), ${JSON.stringify(message.id)});
    return new TextDecoder().decode(audio.slice(0, 4));
  })()`), 'RIFF');
  assert.equal((await js("api['voice-model-status']()")).model, model.id);
  await js("api['voice-model-release']()");
}

async function run(js, store, fixture, agents, dialog) {
  if (process.argv.includes('--voice-local-model-smoke')) return localModelSmoke(js, store, fixture.chat);
  const emit = agents.emit;
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ route: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks) });
    if (request.url.endsWith('/speech')) {
      response.setHeader('Content-Type', 'audio/wav');
      response.end(silence());
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ text: 'Recognized fixture speech' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const c = fixture.chat;
    assert.equal(await js("$('voice-live-status').hidden"), true);
    assert.equal(await js("$('voice-quick-controls').hidden"), false);
    assert.equal(await js("$('voice-quick-input').getAttribute('aria-pressed')"), 'false');
    assert.equal(await js("document.querySelector('.play-voice').hidden"), true);
    await referencePickerSmoke(js, store, c, dialog);
    await js("$('chat-settings').click(); $('chat-voice-settings-open').click()");
    assert.equal(await js("$('voice-enabled').checked"), false);
    assert.equal(await js("$('voice-input').checked"), false);
    const url = JSON.stringify('http://127.0.0.1:' + server.address().port + '/v1');
    await js(`$('voice-enabled').click(); $('voice-default-id').value='smoke-tts';
      $('voice-transcribe-mode').value='remote'; $('voice-transcribe-mode').onchange();
      $('voice-asr-model').value='smoke-asr'; $('voice-url').value=${url};
      $('voice-key').value='fixture-key'; $('dialog-form').requestSubmit()`);
    await until(() => js("!$('dialog').open && $('voice-quick-output').getAttribute('aria-pressed') === 'true'"));
    assert.equal(c.voice.enabled, true);
    assert.equal(c.voice.inputEnabled, false);
    const snapshot = await js('api.snapshot()');
    assert.equal(snapshot.chats.find(chat => chat.id === c.id).voice.hasKey, true);
    assert.equal(JSON.stringify(snapshot).includes('fixture-key'), false);
    const voiceBefore = structuredClone(c.voice);
    await js("$('voice-quick-output').click()");
    await until(() => js("$('voice-quick-output').getAttribute('aria-pressed') === 'false' && !$('voice-quick-output').disabled"));
    assert.deepEqual(c.voice, { ...voiceBefore, enabled: false });
    await js("$('voice-quick-output').click()");
    await until(() => js("$('voice-quick-output').getAttribute('aria-pressed') === 'true' && !$('voice-quick-output').disabled"));
    assert.deepEqual(c.voice, voiceBefore);
    for (const [index, roleId] of c.roleIds.slice(0, 2).entries()) {
      await js(`openChatRole(${JSON.stringify(roleId)});
        $('chat-role-persona-text').value='Independent persona ${index}';
        $('role-voice-name').value='fixture-voice-${index}'; $('dialog-form').requestSubmit()`);
      await until(() => js("!$('dialog').open"));
      assert.equal(c.rolePersonas[roleId].persona, 'Independent persona ' + index);
      assert.equal(store.get('roles', roleId).persona, '');
    }
    for (const roleId of c.roleIds.slice(0, 2)) {
      const message = store.message(c.id, { roleId, kind: 'assistant', status: 'complete', text: 'Fixture reply' });
      emit({ chatId: c.id, message });
    }
    await until(() => requests.length === 2);
    assert.deepEqual(requests.map(item => JSON.parse(item.body).voice), ['fixture-voice-0', 'fixture-voice-1']);
    assert(requests.every(item => item.authorization === 'Bearer fixture-key'));
    await until(() => js("$('voice-live-status').textContent === '语音输出已开启'"));
    if (process.argv.includes('--use-fake-device-for-media-stream')) {
      agents.run = async (chatId, role) => {
        const message = store.message(chatId, { roleId: role.id, roleName: role.name, kind: 'assistant',
          status: 'complete', text: 'Fixture response!' });
        emit({ chatId, message });
        return message;
      };
      await js(`window.savedVoiceConfirm = window.confirm;
        window.confirm = message => { window.voiceConfirmMessage = message; return false; };
        $('voice-quick-input').click()`);
      assert.equal(await js("$('dialog').open"), false);
      assert.equal(c.voice.inputEnabled, false);
      assert.match(await js('window.voiceConfirmMessage'), /在聊天底栏关闭语音输入/);
      try {
        await js("window.confirm = () => true; $('voice-quick-input').click()");
        await until(() => js("$('voice-quick-input').getAttribute('aria-pressed') === 'true' && $('voice-live-status').textContent.includes('正在听')"));
      } finally {
        await js("window.confirm = window.savedVoiceConfirm; delete window.savedVoiceConfirm; delete window.voiceConfirmMessage");
      }
      await js(`(async () => {
        const pcm = new Int16Array(1600).fill(4000);
        for(let i=0;i<4;i++) await api['voice-live-frame'](${JSON.stringify(c.id)}, pcm.buffer);
        for(let i=0;i<8;i++) await api['voice-live-frame'](${JSON.stringify(c.id)}, new ArrayBuffer(3200));
      })()`);
      await until(() => c.messages.some(message => message.kind === 'user' && message.text === 'Recognized fixture speech'));
      await until(() => js("$('voice-live-status').textContent.includes('正在听')"));
      const transcription = requests.find(item => item.route.endsWith('/transcriptions'));
      assert.match(transcription.route, /\/transcriptions$/);
      assert.match(transcription.body.toString('ascii'), /smoke-asr/);
      assert.match(transcription.body.toString('ascii'), /recording.wav/);
      assert.equal(await js("$('input').value"), '');
      if (process.argv.includes('--phone-link-smoke')) await phoneSmoke(js, c);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { run };
