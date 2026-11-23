// Synthesizes clean, subtle UI sound effects (WAV PCM 48kHz stereo) with zero external downloads.
const fs = require('node:fs');
const path = require('node:path');

const sfxDir = path.join(__dirname, 'sfx');
fs.mkdirSync(sfxDir, { recursive: true });

const SAMPLE_RATE = 48000;

function writeWav(filePath, samplesLeft, samplesRight = samplesLeft) {
  const numFrames = samplesLeft.length;
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, samplesLeft[i]));
    const r = Math.max(-1, Math.min(1, samplesRight[i]));
    buf.writeInt16LE(Math.round(l * 32767), offset);
    buf.writeInt16LE(Math.round(r * 32767), offset + 2);
    offset += 4;
  }
  fs.writeFileSync(filePath, buf);
}

// 1. Soft air-sweep whoosh for slide transitions (0.42s)
function makeWhoosh() {
  const dur = 0.42;
  const n = Math.floor(SAMPLE_RATE * dur);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let lp1 = 0, lp2 = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const env = Math.sin(Math.PI * Math.pow(p, 0.82)) * Math.exp(-1.2 * p);
    // Deterministic pseudo-noise smoothed into warm filtered air
    const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const raw = (noise * 2 - 1) * 0.55;
    const cutoff = 0.035 + 0.11 * Math.sin(Math.PI * p);
    lp1 += cutoff * (raw - lp1);
    lp2 += cutoff * (lp1 - lp2);
    // Subtle warm sine body rising slightly
    const freq = 180 + 160 * p;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const body = Math.sin(phase) * 0.14;
    const sig = (lp2 * 1.45 + body) * env;
    left[i] = sig * (0.95 - 0.12 * p);
    right[i] = sig * (0.83 + 0.12 * p);
  }
  writeWav(path.join(sfxDir, 'whoosh.wav'), left, right);
}

// 2. Crisp, muted wooden/glass UI pop for focus points & cards (0.14s)
function makePop() {
  const dur = 0.14;
  const n = Math.floor(SAMPLE_RATE * dur);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const attack = Math.min(1, t / 0.004);
    const decay = Math.exp(-34 * t);
    const f1 = 620 * Math.exp(-5.5 * t) + 390;
    const f2 = 1240 * Math.exp(-8 * t) + 780;
    p1 += (2 * Math.PI * f1) / SAMPLE_RATE;
    p2 += (2 * Math.PI * f2) / SAMPLE_RATE;
    const sig = (Math.sin(p1) * 0.65 + Math.sin(p2) * 0.22) * attack * decay * 0.85;
    left[i] = sig;
    right[i] = sig * 0.96;
  }
  writeWav(path.join(sfxDir, 'pop.wav'), left, right);
}

// 3. Warm minimal emerald harmonic chime for intro & outro (1.25s)
function makeChime() {
  const dur = 1.25;
  const n = Math.floor(SAMPLE_RATE * dur);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  // C5, E5, G5, D6 gentle staggered arpeggio
  const notes = [
    { f: 523.25, start: 0.00, gain: 0.34, pan: -0.2 },
    { f: 659.25, start: 0.07, gain: 0.28, pan: 0.15 },
    { f: 783.99, start: 0.14, gain: 0.25, pan: -0.1 },
    { f: 1174.66, start: 0.21, gain: 0.16, pan: 0.22 },
  ];
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let l = 0, r = 0;
    for (const note of notes) {
      const dt = t - note.start;
      if (dt < 0) continue;
      const attack = Math.min(1, dt / 0.012);
      const decay = Math.exp(-3.4 * dt);
      const tone = Math.sin(2 * Math.PI * note.f * dt) + 0.18 * Math.sin(2 * Math.PI * note.f * 2 * dt) * Math.exp(-6 * dt);
      const v = tone * attack * decay * note.gain;
      l += v * (1 - Math.max(0, note.pan));
      r += v * (1 - Math.max(0, -note.pan));
    }
    left[i] = l;
    right[i] = r;
  }
  writeWav(path.join(sfxDir, 'chime.wav'), left, right);
}

makeWhoosh();
makePop();
makeChime();
console.log('Generated SFX: whoosh.wav, pop.wav, chime.wav');
