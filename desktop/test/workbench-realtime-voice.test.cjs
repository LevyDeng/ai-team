const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: tick } = require('node:timers/promises');
const { RealtimeVoice, Utterance, visiblePrefix, takePhrases, frameBytes } = require('../workbench/realtime-voice.cjs');

const tone = Buffer.alloc(frameBytes);
for (let i = 0; i < tone.length; i += 2) tone.writeInt16LE(4000 * (i % 4 ? -1 : 1), i);
const silence = Buffer.alloc(frameBytes);

function utter(consume) {
  for (const chunk of [...Array(4).fill(tone), ...Array(8).fill(silence)]) consume(chunk);
}

test('Speech endpoint produces one 16 kHz recording after a pause', () => {
  const detector = new Utterance(), clips = [];
  for (let i = 0; i < 8; i++) assert.equal(detector.feed(silence), undefined);
  utter(chunk => { const clip = detector.feed(chunk); if (clip) clips.push(Buffer.from(clip)); });
  assert.equal(clips.length, 1);
  assert.equal(clips[0].readUInt32LE(24), 16000);
  assert.equal(clips[0].readUInt32LE(40), clips[0].length - 44);
});

function fixture(t, flags) {
  let busy = false;
  const sent = [], events = [], spoken = [];
  const model = { source: 'remote', id: 'fixture-model' };
  const chat = { id: 'chat', roleIds: ['one', 'two'], voice: { ...flags, model },
    roleVoices: Object.fromEntries(['one', 'two'].map(id => [id, { voiceModel: model, voice: id }])) };
  const live = new RealtimeVoice({
    voice: {
      async transcribe(_chat, audio, _signal, format) {
        assert.equal(format, 'wav');
        assert.equal(Buffer.from(audio).toString('ascii', 0, 4), 'RIFF');
        return 'Automatically submitted';
      },
      async synthesize(_chat, voice, text) { spoken.push([voice.voice, text]); return Buffer.from('audio'); },
    },
    getChat: () => chat, busy: () => busy,
    submit: (_id, text) => { sent.push(text); busy = true; },
  });
  t.after(() => live.close());
  live.start(chat.id, 'device', (kind, value) => events.push({ kind, ...value }));
  return { chat, live, sent, events, spoken, idle: () => { busy = false; live.sync(chat.id); },
    phase: () => live.sessions.get(chat.id).phase, speak: (id, text, status) =>
      live.message(chat.id, { id, roleId: id, kind: 'assistant', text, status }),
    record: () => utter(frame => live.frame(chat.id, 'device', frame)),
  };
}

test('Input alone submits automatically and never generates reply audio', async t => {
  const x = fixture(t, { inputEnabled: true, enabled: false });
  x.record();
  assert.equal(x.phase(), 'transcribing');
  await tick();
  assert.deepEqual(x.sent, ['Automatically submitted']);
  x.speak('one', 'First fixture sentence!', 'complete');
  assert.equal(x.phase(), 'listening');
  assert.deepEqual(x.spoken, []);
});

test('Output alone streams an initial segment before a completed reply and leaves the microphone off', async t => {
  const x = fixture(t, { inputEnabled: false, enabled: true });
  x.record();
  x.speak('one', 'First fixture sentence! Follow', 'running');
  await tick();
  assert.equal(x.phase(), 'playing');
  assert.deepEqual(x.spoken, [['one', 'First fixture sentence!']]);
  x.speak('one', 'First fixture sentence! Follow through.', 'complete');
  x.live.played('chat', 'device', 'one', 1);
  await tick();
  assert.deepEqual(x.spoken.at(-1), ['one', 'Follow through.']);
  x.live.played('chat', 'device', 'one', 2);
  await tick();
  assert.equal(x.phase(), 'ready');
  assert.deepEqual(x.sent, []);
});

test('Both switches suspend capture until the final role segment finishes playing', async t => {
  const x = fixture(t, { inputEnabled: true, enabled: true });
  x.record(); await tick();
  assert.equal(x.phase(), 'waiting');
  x.speak('one', 'First fixture sentence! Another sentence from the same role!', 'complete');
  x.speak('two', 'Second fixture sentence!', 'complete');
  let finished = false;
  const playbackIdle = x.live.whenPlaybackIdle().then(() => { finished = true; });
  x.idle(); x.record(); await tick();
  assert.equal(x.phase(), 'playing');
  x.live.played('chat', 'wrong-device', 'one', 1);
  await tick();
  assert.equal(x.spoken.length, 1);
  x.live.played('chat', 'device', 'one', 1);
  await tick();
  assert.deepEqual(x.spoken.map(item => item[0]), ['one', 'one']);
  x.live.played('chat', 'device', 'one', 2);
  await tick();
  assert.equal(x.phase(), 'playing');
  assert.equal(finished, false);
  x.live.played('chat', 'device', 'two', 1);
  await playbackIdle;
  assert.equal(x.phase(), 'listening');
  assert.equal(x.sent.length, 1);
  assert.deepEqual(x.spoken.map(item => item[0]), ['one', 'one', 'two']);
});

test('A missing playback acknowledgement does not start the next role', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const x = fixture(t, { inputEnabled: false, enabled: true });
  x.speak('one', 'First fixture sentence!', 'complete');
  x.speak('two', 'Second fixture sentence!', 'complete');
  await tick();
  t.mock.timers.tick(90000);
  await tick();
  assert.equal(x.events.filter(event => event.kind === 'error').length, 1);
  assert.deepEqual(x.events.filter(event => event.kind === 'audio').map(event => event.roleId), ['one']);
  x.live.played('chat', 'device', 'one', 1);
  await tick();
  assert.deepEqual(x.events.filter(event => event.kind === 'audio').map(event => event.roleId), ['one', 'two']);
});

test('Streaming skips fenced content and buffers an incomplete final phrase', () => {
  const tick = String.fromCharCode(96).repeat(3);
  const partial = ['Spoken first!', tick + 'js', 'hiddenCode();'].join('\n');
  assert.equal(visiblePrefix(partial, false), 'Spoken first!\n');
  assert.deepEqual(takePhrases(visiblePrefix(partial + '\n' + tick + '\nTrailing clause', false), false).phrases,
    ['Spoken first!']);
});
