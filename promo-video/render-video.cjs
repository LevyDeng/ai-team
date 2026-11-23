const { app, BrowserWindow } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const script = require('./script-data.js');

// Force 1:1 device scale factor so 1920x1080 captures at exact 1920x1080 pixels
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(__dirname, '.tmp-render-userdata'));

const previewOnly = process.argv.includes('--preview-keyframes');
const distDir = path.join(__dirname, 'dist');
const previewDir = path.join(__dirname, 'previews');
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(previewDir, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'audio/manifest.json'), 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildMixedAudio(audioOutPath) {
  const inputs = [];
  const filterParts = [];
  const mixLabels = [];
  let idx = 0;

  for (const s of manifest.slides) {
    inputs.push('-i', path.join(__dirname, s.audioFile));
    const delayMs = Math.round(s.voiceStart * 1000);
    const label = `v${idx}`;
    filterParts.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.18,adelay=${delayMs}|${delayMs}[${label}]`);
    mixLabels.push(`[${label}]`);
    idx++;
  }

  for (let i = 0; i < manifest.slides.length; i++) {
    const m = manifest.slides[i];
    const def = script.slides[i];
    for (const cue of def.sfx || []) {
      const sfxFile = path.join(__dirname, 'sfx', `${cue.type}.wav`);
      if (!fs.existsSync(sfxFile)) continue;
      inputs.push('-i', sfxFile);
      const delayMs = Math.max(0, Math.round((m.start + cue.at) * 1000));
      const label = `s${idx}`;
      filterParts.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${cue.volume},adelay=${delayMs}|${delayMs}[${label}]`);
      mixLabels.push(`[${label}]`);
      idx++;
    }
  }

  const totalDur = manifest.totalDuration.toFixed(3);
  filterParts.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,` +
    `alimiter=limit=0.95,atrim=0:${totalDur},afade=t=out:st=${Math.max(0, manifest.totalDuration - 0.45).toFixed(3)}:d=0.45[aout]`
  );

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[aout]',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    audioOutPath,
  ];
  console.log('Mixing voiceover + UI SFX tracks...');
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log('Mixed audio written to', audioOutPath);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true,
    show: false,
    backgroundColor: '#0f1318',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setFrameRate(60);

  win.webContents.debugger.attach('1.3');

  async function renderFrame(t, format = 'jpeg') {
    await win.webContents.executeJavaScript(`window.__renderAt(${t.toFixed(4)}); new Promise(r => requestAnimationFrame(r))`);
    const params = format === 'png' ? { format: 'png' } : { format: 'jpeg', quality: 92 };
    const { data } = await win.webContents.debugger.sendCommand('Page.captureScreenshot', params);
    return Buffer.from(data, 'base64');
  }

  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });

  await win.loadFile(path.join(__dirname, 'deck.html'));
  const info = await win.webContents.executeJavaScript('window.__ready');
  await wait(250);
  console.log('Deck ready:', info);

  if (previewOnly) {
    const samples = [
      { name: '01-hero.png', t: manifest.slides[0].start + 4.5 },
      { name: '02-group-chat.png', t: manifest.slides[1].start + 6.0 },
      { name: '03a-workflow.png', t: manifest.slides[2].start + 4.0 },
      { name: '03b-priority.png', t: manifest.slides[2].start + manifest.slides[2].duration * 0.72 },
      { name: '04-accounts.png', t: manifest.slides[3].start + 5.0 },
      { name: '05-quota.png', t: manifest.slides[4].start + 5.0 },
      { name: '06-tools-wipe.png', t: manifest.slides[5].start + 5.6 },
      { name: '07-steps.png', t: manifest.slides[6].start + 6.0 },
      { name: '08-outro.png', t: manifest.slides[7].start + 4.0 },
    ];
    for (const s of samples) {
      const buf = await renderFrame(s.t, 'png');
      fs.writeFileSync(path.join(previewDir, s.name), buf);
      console.log('Preview saved:', s.name, buf.length, 'bytes');
    }
    if (errors.length) console.warn('Errors:', errors);
    app.exit(0);
    return;
  }

  // Full video render
  const fps = script.meta.fps;
  const totalFrames = Math.ceil(manifest.totalDuration * fps);
  const videoOnlyPath = path.join(distDir, 'video-only.mp4');
  const mixedAudioPath = path.join(distDir, 'audio-mix.m4a');
  const finalOutPath = path.join(distDir, 'ai-team-promo.mp4');

  buildMixedAudio(mixedAudioPath);

  console.log(`Rendering ${totalFrames} frames (${manifest.totalDuration.toFixed(2)}s @ ${fps}fps)...`);
  const ff = spawn('ffmpeg', [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    videoOnlyPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  let ffStderr = '';
  ff.stderr.on('data', chunk => { ffStderr += chunk.toString(); });

  const startMs = Date.now();
  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    const buf = await renderFrame(t, 'jpeg');
    if (!ff.stdin.write(buf)) {
      await new Promise(resolve => ff.stdin.once('drain', resolve));
    }
    if (frame > 0 && frame % 300 === 0) {
      const elapsed = (Date.now() - startMs) / 1000;
      const pct = ((frame / totalFrames) * 100).toFixed(1);
      console.log(`  Frame ${frame}/${totalFrames} (${pct}%) - ${elapsed.toFixed(1)}s elapsed`);
    }
  }
  ff.stdin.end();
  const code = await new Promise(resolve => ff.on('close', resolve));
  if (code !== 0) {
    console.error('ffmpeg video encode failed:', ffStderr.slice(-1500));
    app.exit(1);
    return;
  }

  console.log('Muxing final MP4 with audio...');
  execFileSync('ffmpeg', [
    '-y',
    '-i', videoOnlyPath,
    '-i', mixedAudioPath,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-shortest',
    '-movflags', '+faststart',
    finalOutPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  try { fs.unlinkSync(videoOnlyPath); } catch {}
  try { fs.unlinkSync(mixedAudioPath); } catch {}

  const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`SUCCESS! Final video: ${finalOutPath} (rendered in ${totalSec}s)`);
  if (errors.length) console.warn('Renderer errors:', errors);
  app.exit(0);
}).catch(err => {
  console.error(err);
  app.exit(1);
});
