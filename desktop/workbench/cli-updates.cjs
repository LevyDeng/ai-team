const fs = require('node:fs');
const path = require('node:path');
const { atomic } = require('./store.cjs');
const { hasUpdate, packageVersion, stableVersion } = require('./cli-release.cjs');
const codex = require('./runtime.cjs');
const vendors = require('./vendor-install.cjs');

const cooldown = 12 * 60 * 60 * 1000;
const localUpdates = {
  codex,
  ...Object.fromEntries(['antigravity', 'kimi', 'codebuddy'].map(engine => [engine, {
    managed: () => vendors.managed(engine),
    installed: () => vendors.installed(engine),
    latest: request => vendors.latest(engine, request),
    install: options => vendors.install(engine, options),
  }])),
};

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? [file, stat.size, stat.mtimeMs].join('|') : '';
  } catch { return ''; }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}

class CliUpdates {
  constructor({ store, file, resolveExecutable, busyRoles, fetchLocal, npmEnvironment, remote, changed, local = localUpdates }) {
    Object.assign(this, { store, file, resolveExecutable, busyRoles, fetchLocal, npmEnvironment, remote, changed, local });
    this.pending = new Map();
    this.results = new Map();
    this.batch = '';
    this.batchResult = null;
    this.closed = false;
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.saved = Object.fromEntries(Object.keys(local).flatMap(engine => {
      const value = saved?.[engine];
      return value && typeof value.installed === 'string' && packageVersion.test(value.installed) &&
        typeof value.latest === 'string' && stableVersion.test(value.latest) &&
        typeof value.stamp === 'string' && Number.isFinite(value.checkedAt) ? [[engine, value]] : [];
    }));
  }

  preferences() {
    const value = this.store.state.settings.cliUpdates;
    return { autoCheck: value?.autoCheck !== false, reminders: value?.reminders !== false };
  }

  savePreference(key, value) {
    if (!['autoCheck', 'reminders'].includes(key) || typeof value !== 'boolean') throw new Error('无法保存更新偏好。');
    const settings = this.store.state.settings;
    const previous = settings.cliUpdates;
    settings.cliUpdates = { ...this.preferences(), [key]: value };
    try { this.store.save(); }
    catch { settings.cliUpdates = previous; throw new Error('无法保存更新偏好，请稍后重试。'); }
    this.changed();
  }

  row(engine, resolve = this.resolveExecutable) {
    const managed = this.local[engine].managed();
    const stamp = managed && fileStamp(managed);
    const saved = this.saved[engine];
    const cached = saved?.stamp === stamp ? saved : undefined;
    const result = this.results.get(engine);
    const current = result?.stamp === stamp ? result : cached;
    const roles = this.store.state.roles.filter(role => role.engine === engine && role.locationId === 'local' && role.enabled !== false);
    let usingManaged = 0, external = 0;
    for (const role of roles) {
      const executable = resolve(role);
      if (samePath(executable, managed)) usingManaged++;
      else if (executable || role.executable) external++;
    }
    const installed = current?.installed || cached?.installed || '';
    const latest = current?.latest || cached?.latest || '';
    return { engine, managed, stamp, installed, latest, checkedAt: cached?.checkedAt || null,
      roleCount: roles.length, usingManaged, external, available: Boolean(managed && hasUpdate(installed, latest)),
      pending: this.pending.get(engine) || '', status: current?.status || '', blockers: this.busyRoles(engine) };
  }

  remoteState() {
    const location = this.store.state.locations.find(item => item.managed);
    const inUse = Boolean(location && this.store.state.roles.some(role =>
      role.engine === 'claude' && role.locationId === location.id && role.enabled !== false));
    return { ...this.remote.snapshot(), inUse };
  }

  snapshot(executables) {
    const rows = Object.keys(this.local).map(engine => {
      const { stamp, ...row } = this.row(engine, executables && (role => executables.get(role.id) || ''));
      return row;
    });
    const remote = this.remoteState();
    const count = rows.filter(row => row.usingManaged && row.available).length +
      Number(remote.inUse && remote.available);
    return { ...this.preferences(), rows, count, canCheckAll: remote.inUse || rows.some(row => row.usingManaged),
      batch: this.batch, batchResult: this.batchResult };
  }

  note(engine, row, values) {
    const result = { stamp: row.stamp, ...values };
    this.results.set(engine, result);
    if (this.closed || !result.stamp || !packageVersion.test(result.installed) || !stableVersion.test(result.latest)) return;
    this.saved[engine] = { stamp: result.stamp, installed: result.installed, latest: result.latest, checkedAt: Date.now() };
    if (!this.file) return;
    try { atomic(this.file, this.saved); }
    catch (error) { console.warn('Could not save CLI update metadata:', error.message); }
  }

  async check(engine) {
    if (!Object.hasOwn(this.local, engine) || this.closed) return 'skipped';
    if (this.pending.has(engine)) return 'skipped';
    const entry = this.local[engine];
    const row = this.row(engine);
    this.pending.set(engine, 'checking');
    this.changed();
    try {
      const request = await this.fetchLocal();
      const [installed, latest] = await Promise.all([entry.installed(), entry.latest(request)]);
      if (typeof latest !== 'string' || !stableVersion.test(latest) ||
          (row.managed && (typeof installed !== 'string' || !packageVersion.test(installed)))) {
        throw new Error('Could not verify a stable CLI release or the installed version.');
      }
      this.note(engine, row, { installed, latest, status: 'checked' });
      return 'checked';
    } catch (error) {
      this.results.set(engine, { stamp: row.stamp, status: 'check_failed' });
      console.warn('CLI update check failed for %s: %s', engine, error.message);
      return 'failed';
    } finally {
      this.pending.delete(engine);
      if (!this.closed) this.changed();
    }
  }

  async startup() {
    if (!this.preferences().autoCheck || this.closed) return;
    await Promise.all(Object.keys(this.local).filter(engine => {
      const { usingManaged, checkedAt } = this.row(engine);
      return usingManaged && (!checkedAt || checkedAt > Date.now() || Date.now() - checkedAt >= cooldown);
    }).map(engine => this.check(engine)));
  }

  async install(engine, { bulk = false, roleEditor = false } = {}) {
    if (!Object.hasOwn(this.local, engine) || this.closed) return { status: 'skipped' };
    const { pending, blockers, usingManaged, available, managed, latest } = this.row(engine);
    if (pending || blockers.length || (bulk && !usingManaged)) return { status: 'skipped' };
    if (!roleEditor && (managed ? !available : !stableVersion.test(latest))) return { status: 'skipped' };
    this.pending.set(engine, 'installing');
    this.changed();
    try {
      const request = await this.fetchLocal();
      const env = engine === 'antigravity' ? undefined : await this.npmEnvironment();
      const entry = this.local[engine];
      const expected = roleEditor ? await entry.latest(request) : latest;
      if (!stableVersion.test(expected)) throw new Error('Could not verify a stable CLI version.');
      const current = await entry.installed();
      if (managed && current && !hasUpdate(current, expected)) {
        this.note(engine, this.row(engine), { installed: current, latest: expected, status: 'checked' });
        return { status: 'current', version: current, executable: managed };
      }
      const result = await entry.install({ request, env, expected });
      this.note(engine, this.row(engine), { installed: result.version, latest: expected, status: 'installed' });
      return { ...result, status: 'installed' };
    } catch (error) {
      this.results.set(engine, { stamp: this.row(engine).stamp, status: 'install_failed' });
      console.warn('CLI installation failed for %s: %s', engine, error.message);
      return { status: 'failed' };
    } finally {
      this.pending.delete(engine);
      if (!this.closed) this.changed();
    }
  }

  async runBatch(operation) {
    if (this.batch || this.closed) return;
    this.batch = operation;
    this.batchResult = null;
    this.changed();
    const summary = { operation, checked: 0, installed: 0, started: 0, failed: 0, skipped: 0 };
    try {
      const engines = Object.keys(this.local).filter(engine => {
        const row = this.row(engine);
        return row.usingManaged && (operation === 'check' || row.available);
      });
      const remote = this.remoteState();
      const includeRemote = remote.inUse && (operation === 'check' || remote.available);
      if (operation === 'check') {
        const checks = engines.map(engine => this.check(engine));
        if (includeRemote) {
          if (remote.busy) summary.skipped++;
          else checks.push(this.remote.request('check').then(result => {
            if (result.state === 'running') return 'skipped';
            return result.state === 'failed' && result.checkedAt === remote.checkedAt ? 'failed' : 'checked';
          }, () => 'failed'));
        }
        for (const status of await Promise.all(checks)) summary[status]++;
      } else {
        for (const engine of engines) {
          const { status } = await this.install(engine, { bulk: true });
          summary[status === 'current' ? 'skipped' : status]++;
        }
        if (includeRemote && !this.closed) {
          const current = this.remoteState();
          if (!current.inUse || !current.available || current.busy || current.state === 'running') summary.skipped++;
          else {
            try {
              const result = await this.remote.request('update');
              summary[result.state === 'running' ? 'started' : result.state === 'failed' ? 'failed' :
                result.reason === 'updated' ? 'installed' : 'skipped']++;
            } catch { summary.failed++; }
          }
        }
      }
    } finally {
      this.batch = '';
      this.batchResult = summary;
      if (!this.closed) this.changed();
    }
  }

  isInstalling(role) {
    return role?.locationId === 'local' && this.pending.get(role.engine) === 'installing';
  }

  installing() {
    return this.batch === 'install' || [...this.pending.values()].includes('installing');
  }

  close() { this.closed = true; }
}

module.exports = { CliUpdates };
