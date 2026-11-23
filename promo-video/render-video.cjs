// Supports:
//   --preview-keyframes                      Render representative 1080p PNGs for every slide
//   --chunk=IDX/TOTAL                        Render frame slice IDX of TOTAL into dist/chunk-IDX.mp4
//   (no flags)                               Run 4 parallel chunk workers, concat, mix audio -> dist/ai-team-promo.mp4
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const script = require('./script-data.js');

const distDir = path.join(__dirname, 'dist');
const previewDir = path.join(__dirname, 'previews');
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(previewDir, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'audio/manifest.json'), 'utf8'));

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

  execFileSync('ffmpeg', [
    '-y',
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[aout]',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    audioOutPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

const chunkArg = process.argv.find(a => a.startsWith('--chunk='));
const previewOnly = process.argv.includes('--preview-keyframes');

// Orchestrator mode (plain node or electron without --chunk / --preview-keyframes)
if (!chunkArg && !previewOnly && !process.versions.electron) {
  const WORKERS = 4;
  const electronBin = path.resolve(__dirname, '../desktop/node_modules/electron/dist/electron.exe');
  const startMs = Date.now();
  const mixedAudioPath = path.join(distDir, 'audio-mix.m4a');
  const concatListPath = path.join(distDir, 'chunks.txt');
  const videoOnlyPath = path.join(distDir, 'video-only.mp4');
  const finalOutPath = path.join(distDir, 'ai-team-promo.mp4');

  console.log('1/3 Mixing Chinese voiceover + UI SFX...');
  buildMixedAudio(mixedAudioPath);

  console.log(`2/3 Launching ${WORKERS} parallel Electron render workers...`);
  const chunkFiles = [];
  const jobs = [];
  for (let w = 0; w < WORKERS; w++) {
    const outChunk = path.join(distDir, `chunk-${w}.mp4`);
    chunkFiles.push(outChunk);
    jobs.push(new Promise((resolve, reject) => {
      const child = spawn(electronBin, [__filename, `--chunk=${w}/${WORKERS}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', d => process.stdout.write(`[W${w}] ${d}`));
      let errBuf = '';
      child.stderr.on('data', d => { errBuf += d.toString(); });
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`Worker ${w} exited ${code}: ${errBuf.slice(-800)}`));
      });
    }));
  }

  Promise.all(jobs).then(() => {
    console.log('3/3 Concatenating chunks & muxing final MP4...');
    fs.writeFileSync(concatListPath, chunkFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath,
      '-c', 'copy', videoOnlyPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    execFileSync('ffmpeg', [
      '-y', '-i', videoOnlyPath, '-i', mixedAudioPath,
      '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart',
      finalOutPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    for (const f of [...chunkFiles, concatListPath, videoOnlyPath, mixedAudioPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`SUCCESS! ${finalOutPath} rendered in ${elapsed}s`);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else {
  // Electron worker mode (--preview-keyframes or --chunk=IDX/TOTAL)
  const { app, BrowserWindow } = require('electron');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const tag = chunkArg ? chunkArg.replace(/[^0-9]/g, '-') : 'preview';
  app.setPath('userData', path.join(__dirname, `.tmp-render-${tag}`));

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      width: 1920,
      height: 1080,
      useContentSize: true,
      show: false,
      backgroundColor: '#efe7dc',
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

    await win.loadFile(path.join(__dirname, 'deck.html'));
    const info = await win.webContents.executeJavaScript('window.__ready');
    await wait(200);

    if (previewOnly) {
      const s = manifest.slides;
      const samples = [
        { name: 'latte-01-hero.png', t: s[0].start + 4.0 },
        { name: 'latte-02a-mention.png', t: s[1].start + 5.5 },
        { name: 'latte-02b-queue.png', t: s[1].start + s[1].duration * 0.56 },
        { name: 'latte-02c-settings.png', t: s[1].start + s[1].duration * 0.84 },
        { name: 'latte-03a-workflow.png', t: s[2].start + 4.0 },
        { name: 'latte-03b-priority.png', t: s[2].start + s[2].duration * 0.72 },
        { name: 'latte-04-accounts.png', t: s[3].start + s[3].duration * 0.72 },
        { name: 'latte-05-quota.png', t: s[4].start + 4.0 },
        { name: 'latte-06-tools-wipe.png', t: s[5].start + s[5].duration * 0.50 },
        { name: 'latte-07-steps.png', t: s[6].start + 6.0 },
        { name: 'latte-08-outro.png', t: s[7].start + 4.0 },
      ];
      for (const sample of samples) {
        const buf = await renderFrame(sample.t, 'png');
        fs.writeFileSync(path.join(previewDir, sample.name), buf);
        console.log('Preview saved:', sample.name, buf.length, 'bytes');
      }
      app.exit(0);
      return;
    }

    const [idxStr, totalStr] = chunkArg.slice('--chunk='.length).split('/');
    const chunkIdx = Number(idxStr);
    const totalChunks = Number(totalStr);
    const fps = script.meta.fps;
    const totalFrames = Math.ceil(info.totalDuration * fps);
    const perChunk = Math.ceil(totalFrames / totalChunks);
    const startFrame = chunkIdx * perChunk;
    const endFrame = Math.min(totalFrames, startFrame + perChunk);
    const outChunk = path.join(distDir, `chunk-${chunkIdx}.mp4`);

    console.log(`Rendering frames ${startFrame}..${endFrame - 1} (${endFrame - startFrame} frames)`);
    const ff = spawn('ffmpeg', [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-framerate', String(fps),
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      outChunk,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let ffErr = '';
    ff.stderr.on('data', d => { ffErr += d.toString(); });

    const t0 = Date.now();
    for (let frame = startFrame; frame < endFrame; frame++) {
      const buf = await renderFrame(frame / fps, 'jpeg');
      if (!ff.stdin.write(buf)) {
        await new Promise(resolve => ff.stdin.once('drain', resolve));
      }
      const done = frame - startFrame + 1;
      if (done % 250 === 0 || frame === endFrame - 1) {
        const el = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  ${done}/${endFrame - startFrame} frames (${el}s)`);
      }
    }
    ff.stdin.end();
    const code = await new Promise(resolve => ff.on('close', resolve));
    if (code !== 0) {
      console.error('ffmpeg chunk failed:', ffErr.slice(-1000));
      app.exit(1);
      return;
    }
    app.exit(0);
  }).catch(err => {
    console.error(err);
    app.exit(1);
  });
}
