const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ChatVoice, settings, roleSettings, speechFor, spokenText, credentialKey } = require('../workbench/chat-voice.cjs');
const { levelVoiceWav } = require('../workbench/voice-level.cjs');

const remote = id => ({ source: 'remote', id });
const wav = Buffer.from('RIFF\x00\x00\x00\x00WAVE');

function speechWav(amplitude, { pause = 0, peak = false } = {}) {
  const voiced = 16000;
  const audio = Buffer.alloc(44 + (voiced + pause) * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  for (let i = 0; i < voiced; i++) audio.writeInt16LE(i % 2 ? -amplitude : amplitude, 44 + i * 2);
  if (peak) audio.writeInt16LE(26000, 80);
  return audio;
}

test('Voice leveling brings quiet and loud clips to the same level despite trailing silence', () => {
  const quiet = levelVoiceWav(speechWav(1000, { pause: 16000 }));
  const loud = levelVoiceWav(speechWav(12500));
  assert.equal(quiet.readInt16LE(44), loud.readInt16LE(44));
  assert.equal(quiet.readInt16LE(quiet.length - 2), 0);
});

test('Voice leveling caps boosts, tames isolated peaks, and preserves unsupported WAV data', () => {
  assert.equal(levelVoiceWav(speechWav(300)).readInt16LE(44), 1200);
  assert(levelVoiceWav(speechWav(1500, { peak: true })).readInt16LE(80) < 31130);
  const unsupported = speechWav(1000);
  unsupported.writeUInt16LE(3, 20);
  const original = Buffer.from(unsupported);
  assert.deepEqual(levelVoiceWav(unsupported), original);
});

test('Local and remote synthesis use the same playback level', async () => {
  const service = new ChatVoice(async () => new Response(speechWav(12500)), { get: () => '' });
  service.local.request = async () => ({ wav: speechWav(1000).toString('base64') });
  const chat = { id: 'chat', voice: { baseUrl: 'https://example.test/v1' } };
  const signal = new AbortController().signal;
  const fromLocal = await service.synthesize(chat, { model: { source: 'local', id: 'local-fixture' } }, 'Fixture speech', signal);
  const fromRemote = await service.synthesize(chat, { model: remote('remote-fixture') }, 'Fixture speech', signal);
  assert.deepEqual(fromLocal, fromRemote);
});

test('Each participant must set a voice for their effective model', () => {
  const inherited = remote('default-tts'), override = remote('participant-tts');
  const chat = {
    voice: settings({ model: inherited }),
    roleVoices: {
      first: roleSettings({ model: { source: 'inherit' }, voiceModel: inherited, voice: 'warm' }),
      second: roleSettings({ model: override, voiceModel: override, voice: 'bright' }),
    },
  };
  assert.equal(chat.voice.enabled, false);
  assert.equal(speechFor(chat, 'first').voice, 'warm');
  assert.equal(speechFor(chat, 'second').model.id, override.id);
  assert.throws(() => speechFor(chat, 'third'));
  chat.voice.model = remote('replacement');
  assert.throws(() => speechFor(chat, 'first'));
  assert.equal(speechFor(chat, 'second').voice, 'bright');
  assert.throws(() => settings({ baseUrl: 'http://example.test/v1' }));
});

test('Remote requests send the selected voice and explicitly recorded audio only when enabled', async () => {
  const calls = [];
  const service = new ChatVoice(async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/speech') ? new Response(wav) : Response.json({ text: 'Transcribed draft' });
  }, { get: key => key === credentialKey('chat', 'https://example.test/v1') ? 'fixture-key' : '' });
  const chat = {
    id: 'chat', roleIds: ['role'], messages: [{ id: 'reply', roleId: 'role', kind: 'assistant', status: 'complete', text: '**Talk**' }],
    voice: settings({ model: remote('chat-tts'), baseUrl: 'https://example.test/v1', transcription: 'remote', transcriptionModel: 'chat-asr' }),
    roleVoices: { role: roleSettings({ voiceModel: remote('chat-tts'), voice: 'warm' }) },
  };
  const sender = Object.assign(new EventEmitter(), { id: 1 });
  const speak = () => service.run(chat, sender, randomUUID(), signal => service.speak(chat, 'reply', signal));
  await assert.rejects(speak);
  assert.equal(calls.length, 0);
  chat.voice.enabled = true;
  assert.deepEqual(await speak(), wav);
  assert.deepEqual(JSON.parse(calls[0].options.body), { input: 'Talk', model: 'chat-tts', voice: 'warm', response_format: 'wav' });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-key');
  const clip = Uint8Array.from([1, 2, 3]).buffer;
  const result = await service.run(chat, sender, randomUUID(), signal => service.transcribe(chat, clip, signal));
  assert.equal(result, 'Transcribed draft');
  assert.equal(calls[1].options.body.get('model'), 'chat-asr');
  assert.deepEqual(await calls[1].options.body.get('file').arrayBuffer(), clip);
});

test('Speech skips fenced code and preserves text surrounding it', () => {
  assert.equal(spokenText('## Result\n\n' + '```js\nconst first = 1;\nconst second = 2;\n```\n\nRead [details](https://example.test).'), 'Result\n\n\n\nRead details.');
});
