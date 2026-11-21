const path = require('node:path');
const crypto = require('node:crypto');
const { shellQuote } = require('../config.cjs');
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : '';
function normalize(value) {
  if (!value || !['idle', 'running', 'complete', 'failed'].includes(value.state)) throw new Error('Unexpected updater response.');
  return { state: value.state, phase: String(value.phase || 'idle').slice(0, 60), reason: String(value.reason || '').slice(0, 100),
    installed: version(value.installed), latest: version(value.latest), target: version(value.target), preparedVersion: version(value.preparedVersion),
    canRollback: value.canRollback === true, available: value.available === true,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : null, checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : null };
}
class ClaudeUpdater {
  constructor(root, store, backend, locations, changed) {
    Object.assign(this, { root, store, backend, locations, changed });
    this.state = { state: 'idle', phase: 'idle', installed: '', latest: '', canRollback: false };
    this.busy = false; this.closed = false; this.timer = null;
  }
  snapshot() { return { ...this.state, busy: this.busy, enabled: this.store.state.locations.some(location => location.managed) }; }
  publish(value) { this.state = normalize(value); this.changed(); return this.snapshot(); }
  async upload() {
    const client = this.backend.client;
    const sftp = await new Promise((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)));
    try {
      for (const name of ['manage-claude-version.py', 'read-usage.py']) {
        const destination = this.backend.remoteDir + '/' + name;
        const temporary = destination + '.' + crypto.randomUUID();
        await new Promise((resolve, reject) => sftp.fastPut(path.join(this.root, 'server', name), temporary, { mode: 0o700 }, error => error ? reject(error) : resolve()));
        await this.backend.exec('mv -f -- ' + shellQuote(temporary) + ' ' + shellQuote(destination));
      }
    } finally { sftp.end(); }
  }
  async call(action) {
    const raw = await this.backend.exec('python3 ' + shellQuote(this.backend.remoteDir + '/manage-claude-version.py') + ' ' + action, 40000);
    return JSON.parse(raw);
  }
  async request(action) {
    if (!['check', 'update', 'rollback'].includes(action)) throw new Error('Invalid updater operation.');
    if (this.busy) throw new Error('A Claude version operation is already in progress.');
    const location = this.store.state.locations.find(item => item.managed);
    if (!location) throw new Error('No managed Relay VPS is configured.');
    this.busy = true; this.changed();
    try {
      await this.locations.connect(location.id);
      await this.upload();
      this.publish(await this.call(action));
      if (this.state.state === 'running') this.poll();
      return this.snapshot();
    } finally { this.busy = false; this.changed(); }
  }
  poll() {
    clearTimeout(this.timer);
    if (this.closed || this.state.state !== 'running') return;
    this.timer = setTimeout(async () => {
      if (this.closed) return;
      if (!this.backend.client || this.backend.status.ssh !== 'ready') {
        this.state = { ...this.state, reason: 'connection_lost' }; this.changed(); return;
      }
      try { this.publish(await this.call('status')); }
      catch { this.state = { ...this.state, reason: 'connection_lost' }; this.changed(); }
      if (this.state.reason !== 'connection_lost') this.poll();
    }, 2500);
    this.timer.unref();
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
module.exports = { ClaudeUpdater, normalize };
