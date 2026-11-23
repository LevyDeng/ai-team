const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const script = require('./script-data.js');

const audioDir = path.join(__dirname, 'audio');
fs.mkdirSync(audioDir, { recursive: true });

function probeDuration(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8' }).trim();
  const value = Number.parseFloat(out);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid duration for ' + filePath);
  return value;
}

async function synthesize(text, outFile, voice, rate) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text, { rate });
  const chunks = [];
  for await (const chunk of audioStream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 1000) throw new Error('Audio output unexpectedly small for ' + outFile);
  fs.writeFileSync(outFile, buffer);
}

async function main() {
  const manifest = {
    meta: script.meta,
    totalDuration: 0,
    slides: [],
  };

  let cursor = 0;
  for (const slide of script.slides) {
    const outFile = path.join(audioDir, `${slide.id}.mp3`);
    console.log(`Synthesizing ${slide.id}...`);
    await synthesize(slide.narration, outFile, script.meta.voice, script.meta.rate);
    const voiceDuration = probeDuration(outFile);
    const leadIn = slide.id === 'slide-01' ? 0.65 : script.meta.leadIn;
    const tailOut = slide.id === 'slide-08' ? 1.4 : script.meta.tailOut;
    const duration = Number((leadIn + voiceDuration + tailOut).toFixed(3));
    const entry = {
      id: slide.id,
      audioFile: `audio/${slide.id}.mp3`,
      start: Number(cursor.toFixed(3)),
      duration,
      voiceStart: Number((cursor + leadIn).toFixed(3)),
      voiceDuration: Number(voiceDuration.toFixed(3)),
      leadIn,
      tailOut,
    };
    manifest.slides.push(entry);
    cursor += duration;
    console.log(`  -> ${slide.id}: voice=${voiceDuration.toFixed(2)}s, total=${duration.toFixed(2)}s`);
  }

  manifest.totalDuration = Number(cursor.toFixed(3));
  fs.writeFileSync(path.join(audioDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Done! Total video duration: ${manifest.totalDuration.toFixed(2)}s`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
