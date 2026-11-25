const { hasUpdate, stableVersion } = require('./cli-release.cjs');
const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');

const repository = 'LevyDeng/ai-team';
const latestUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const releaseBase = `https://github.com/${repository}/releases/download/`;
const packageName = /^ai-team-(\d+\.\d+\.\d+)-win-x64\.zip$/;
const releaseTag = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const maxZipSize = 1024 ** 3;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const updateDirectory = '.ai-team-update';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function portableRoot(root, app) {
  if (!app.isPackaged || process.platform !== 'win32' || process.arch !== 'x64') return;
  const directory = path.dirname(process.execPath);
  if (path.basename(process.execPath).toLowerCase() === 'ai-team.exe' &&
      path.relative(directory, root).toLowerCase() === path.join('resources', 'app')) return directory;
}

function latestPackage(release) {
  if (!release || typeof release.tag_name !== 'string' || !releaseTag.test(release.tag_name) ||
      release.draft || release.prerelease || !Array.isArray(release.assets)) return undefined;

  let latest;
  for (const asset of release.assets) {
    if (asset?.state !== 'uploaded' || typeof asset.name !== 'string') continue;
    const version = packageName.exec(asset.name)?.[1];
    if (!version || !stableVersion.test(version)) continue;
    const url = releaseBase + release.tag_name + '/' + asset.name;
    if (asset.browser_download_url !== url) continue;
    const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest)?.[1];
    const size = Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maxZipSize ? asset.size : undefined;
    if (!latest || hasUpdate(latest.version, version)) latest = { version, url, name: asset.name, digest, size };
  }
  return latest;
}

class AppReleaseUpdate {
  constructor({ version, request, open, directory }) {
    this.version = version;
    this.request = request;
    this.open = open;
    this.directory = directory;
  }

  check() {
    if (this.staging || this.handingOff) throw new Error('应用更新正在准备，请稍候。');
    if (!this.pending) {
      this.available = undefined;
      this.pending = this.read().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  async read() {
    let response;
    try {
      response = await this.request(latestUrl, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15000), redirect: 'error', cache: 'no-store',
      });
    } catch {
      throw new Error('无法连接 GitHub，请检查网络后重试。');
    }
    if (response.status === 404) return { status: 'no-release' };
    if (!response.ok) throw new Error('GitHub 暂时无法提供版本信息，请稍后重试。');
    let release;
    try { release = await response.json(); }
    catch { throw new Error('GitHub 返回的版本信息无法读取，请稍后重试。'); }

    const target = latestPackage(release);
    if (!target) return { status: 'no-package' };
    if (!hasUpdate(this.version, target.version)) return { status: 'current', version: target.version };
    const alreadyStaged = this.prepared?.target;
    this.available = alreadyStaged?.url === target.url && alreadyStaged.digest === target.digest && alreadyStaged.size === target.size ? alreadyStaged : target;
    return { status: 'available', version: target.version, direct: Boolean(this.directory && target.digest && target.size) };
  }

  async download() {
    if (!this.available) throw new Error('请先检查应用更新。');
    try { await this.open(this.available.url); }
    catch { throw new Error('无法在浏览器中打开下载链接，请稍后重试。'); }
  }

  status() {
    if (!this.directory) return {};
    const result = readJson(path.join(this.directory, updateDirectory, 'result.json'));
    // Recovery details stay local and may contain paths or native diagnostics.
    return { result: result?.status, version: result?.version };
  }

  async prepare() {
    const target = this.available;
    if (!this.directory || !target?.digest || !target.size) throw new Error('请先检查更新，或手动下载新版 ZIP。');
    if (this.handingOff) throw new Error('应用即将重启，请稍候。');
    if (this.prepared?.target === target) return;
    if (this.staging) return this.staging;
    this.downloadAbort = new AbortController();
    this.staging = this.stage(target, this.downloadAbort.signal).finally(() => {
      this.staging = undefined;
      this.downloadAbort = undefined;
    });
    return this.staging;
  }

  async stage(target, signal) {
    const base = path.join(this.directory, updateDirectory);
    const job = path.join(base, randomUUID());
    try {
      await files.mkdir(job, { recursive: true });
      await this.fetchPackage(target, path.join(job, 'release.zip'), signal);
      await files.copyFile(path.join(__dirname, 'portable-update.ps1'), path.join(job, 'portable-update.ps1'));
      await files.writeFile(path.join(job, 'job.json'), JSON.stringify({ version: target.version, parentPid: process.pid }));
      await files.writeFile(path.join(job, 'Recover update.cmd'),
        '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0portable-update.ps1" -Mode Recover\r\nif errorlevel 1 pause\r\n');
      signal.throwIfAborted();
      const processHandle = this.worker(job, 'Stage');
      const stop = () => processHandle.kill();
      signal.addEventListener('abort', stop, { once: true });
      try {
        const [code] = await once(processHandle, 'exit');
        signal.throwIfAborted();
        if (code !== 0) throw new Error(await files.readFile(path.join(job, 'worker.log'), 'utf8'));
      } finally { signal.removeEventListener('abort', stop); }
      if (this.prepared) await files.rm(this.prepared.job, { recursive: true, force: true });
      this.prepared = { job, target };
    } catch (error) {
      if (!signal.aborted) console.error('Could not prepare the app update:', error);
      await files.rm(job, { recursive: true, force: true }).catch(() => {});
      throw new Error('无法准备应用更新。请检查网络、磁盘空间和应用目录权限后重试。');
    }
  }

  async fetchPackage(target, file, cancellation) {
    const timeout = AbortSignal.timeout(20 * 60_000);
    const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
    let url = new URL(target.url);
    let response;
    // Release downloads redirect to GitHub's asset CDN. Keep that redirect within GitHub.
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await this.request(url.href, { redirect: 'manual', signal, cache: 'no-store' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Missing GitHub release redirect.');
      url = new URL(location, url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
        throw new Error('Unexpected GitHub release redirect.');
      }
    }
    if (response.status !== 200 || !response.body) throw new Error('Could not download the release asset.');
    const hash = createHash('sha256');
    let length = 0;
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        length += chunk.length;
        if (length > target.size) return callback(new Error('The release asset exceeds its expected size.'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(file, { flags: 'wx' }), { signal });
    if (length !== target.size || hash.digest('hex') !== target.digest) throw new Error('The release asset failed verification.');
  }

  worker(job, mode) {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const log = fs.openSync(path.join(job, 'worker.log'), 'a');
    try {
      return spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(job, 'portable-update.ps1'), '-Mode', mode], {
        cwd: this.directory, windowsHide: true, stdio: ['ignore', log, log],
      });
    } finally { fs.closeSync(log); }
  }

  async handOff() {
    if (!this.prepared || this.handingOff || this.prepared.target !== this.available) {
      throw new Error('更新包尚未准备好，请重新检查更新。');
    }
    this.handingOff = true;
    try {
      const { job } = this.prepared;
      if (fs.existsSync(path.join(this.directory, updateDirectory, 'active.json'))) {
        throw new Error('There is an unfinished portable update.');
      }
      await files.rm(path.join(job, 'waiting'), { force: true });
      const worker = this.worker(job, 'Launch');
      let failed = false;
      worker.once('exit', code => { failed = code !== 0; });
      await once(worker, 'spawn');
      const deadline = Date.now() + 12000;
      while (!failed && Date.now() < deadline) {
        if (fs.existsSync(path.join(job, 'waiting'))) return;
        await delay(100);
      }
      const log = await files.readFile(path.join(job, 'worker.log'), 'utf8');
      throw new Error(log.trim() || 'The portable updater did not accept the handoff.');
    } catch (error) {
      this.handingOff = false;
      console.error('The app update handoff failed:', error);
      throw new Error('无法启动更新程序，当前版本仍可使用。请稍后重试。');
    }
  }

  async close() {
    if (this.handingOff) return;
    this.downloadAbort?.abort();
    await this.staging?.catch(() => {});
    if (this.prepared) await files.rm(this.prepared.job, { recursive: true, force: true });
  }
}

function portableBoot(directory, args = process.argv) {
  if (!directory) return {};
  const base = path.join(directory, updateDirectory);
  const active = readJson(path.join(base, 'active.json'))?.id;
  if (!uuid.test(active || '')) return {};
  const job = path.join(base, active);
  const updateArg = args.includes('--portable-update=' + active);
  if (updateArg) return { job, accepted: () => {
    if (fs.existsSync(path.join(job, 'accepted'))) return true;
    const result = readJson(path.join(base, 'result.json'));
    return result?.status === 'installed' && result.id === active;
  } };
  return { recovery: path.join(job, 'Recover update.cmd'), job };
}

module.exports = { AppReleaseUpdate, portableRoot, portableBoot };
