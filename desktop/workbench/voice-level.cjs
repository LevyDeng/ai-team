const pcmMaximum = 32768;
const targetRms = pcmMaximum * 0.1;
const silenceFloor = pcmMaximum * 0.005;
const gainLimit = 4;
const softLimit = pcmMaximum * 0.8;
const headroom = pcmMaximum * 0.15;

function pcm16Data(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return;
  const end = wav.readUInt32LE(4) + 8;
  if (end < 12 || end > wav.length) return;
  let format, data;
  for (let offset = 12; offset + 8 <= end;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > end) return;
    if (tag === 'fmt ' && size >= 16) {
      const encoding = wav.readUInt16LE(start), channels = wav.readUInt16LE(start + 2);
      const rate = wav.readUInt32LE(start + 4), align = wav.readUInt16LE(start + 12);
      const bits = wav.readUInt16LE(start + 14);
      if (encoding !== 1 || bits !== 16 || channels < 1 || channels > 8 || align !== channels * 2 ||
          rate < 8000 || rate > 192000) return;
      format = { channels, rate, align };
    } else if (tag === 'data') data = wav.subarray(start, start + size);
    if (format && data) return data.length % format.align === 0 ? { ...format, data } : undefined;
    offset = start + size + size % 2;
  }
}

// Change gain once per clip so pauses and syllables never move the volume control.
function levelVoiceWav(wav) {
  const clip = pcm16Data(wav);
  if (!clip?.data.length) return wav;
  const { data, channels, rate } = clip;
  const blockBytes = Math.round(rate * 0.04) * channels * 2;
  const blocks = [];
  let highestRms = 0;
  for (let start = 0; start < data.length; start += blockBytes) {
    const end = Math.min(start + blockBytes, data.length);
    let energy = 0;
    for (let i = start; i < end; i += 2) energy += data.readInt16LE(i) ** 2;
    const samples = (end - start) / 2, rms = Math.sqrt(energy / samples);
    highestRms = Math.max(highestRms, rms);
    blocks.push({ rms, energy, samples });
  }

  const speechFloor = Math.max(silenceFloor, highestRms * 0.2);
  let energy = 0, samples = 0;
  for (const block of blocks) {
    if (block.rms < speechFloor) continue;
    energy += block.energy;
    samples += block.samples;
  }
  if (!samples) return wav;
  const gain = Math.min(gainLimit, targetRms / Math.sqrt(energy / samples));
  for (let i = 0; i < data.length; i += 2) {
    const scaled = data.readInt16LE(i) * gain;
    const excess = Math.abs(scaled) - softLimit;
    const limited = excess > 0 ? Math.sign(scaled) * (softLimit + headroom * excess / (excess + headroom)) : scaled;
    data.writeInt16LE(Math.round(limited), i);
  }
  return wav;
}

module.exports = { levelVoiceWav };
