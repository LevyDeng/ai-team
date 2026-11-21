const { powerMonitor, powerSaveBlocker } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');

class KeepAwake {
  constructor(root, { enabled, disabled = false, changed, log }) {
    this.root = root;
    this.enabled = enabled;
    this.available = process.platform === 'win32' && !disabled;
    this.changed = changed;
    this.log = log;
    this.blocker = null;
    this.helper = null;
    this.ready = false;
    this.locked = false;
    this.suspended = false;
    this.closed = false;
    this.error = '';
  }
  snapshot() {
    return { enabled: this.enabled, available: this.available, active: this.blocker !== null && this.ready, starting: Boolean(this.helper && !this.ready && !this.error), locked: this.locked, suspended: this.suspended, error: this.error };
  }
  start() {
    powerMonitor.on('lock-screen', () => { this.locked = true; this.update(); });
    powerMonitor.on('unlock-screen', () => { this.locked = false; this.update(); });
    powerMonitor.on('suspend', () => { this.suspended = true; this.update(); });
    powerMonitor.on('resume', () => { this.suspended = false; this.update(); });
    this.update();
  }
  setEnabled(enabled) {
    this.enabled = enabled;
    this.error = '';
    if (!enabled) this.stopHelper();
    this.update();
  }
  update() {
    if (this.closed) return;
    const active = this.available && this.enabled && !this.locked && !this.suspended && !this.error;
    if (!active) this.stopHelper();
    if (active && !this.helper) this.startHelper();
    if (active && this.blocker === null) {
      try { this.blocker = powerSaveBlocker.start('prevent-display-sleep'); }
      catch (error) { this.error = error.message; this.stopHelper(); this.log(`Keep-awake failed: ${error.message}`); }
    }
    if ((!active || this.error) && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker);
      this.blocker = null;
    }
    this.changed(this.snapshot());
  }
  startHelper() {
    const helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.root, 'Keep-Awake.ps1'), '-ParentProcessId', String(process.pid)], { cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.helper = helper;
    this.ready = false;
    let output = '';
    helper.stdin.on('error', () => {});
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-2000);
      if (this.helper === helper && !this.ready && output.includes('KEEP_AWAKE_READY')) { this.ready = true; this.update(); }
    });
    helper.stderr.setEncoding('utf8');
    helper.stderr.on('data', (text) => {
      if (this.helper !== helper) return;
      this.error = String(text).trim().slice(-1000) || 'The idle helper failed.';
      this.log(`Keep-awake: ${this.error}`);
      this.stopHelper();
      this.update();
    });
    helper.on('error', (error) => {
      if (this.helper !== helper) return;
      this.error = error.message;
      this.log(`Keep-awake: ${error.message}`);
      this.stopHelper();
      this.update();
    });
    helper.on('exit', (code) => {
      if (this.helper !== helper) return;
      this.helper = null;
      this.ready = false;
      this.error ||= `The idle helper stopped (${code}).`;
      this.log(this.error);
      this.update();
    });
  }
  stopHelper() {
    const helper = this.helper;
    this.helper = null;
    this.ready = false;
    if (!helper) return;
    helper.stdin.end();
    const timer = setTimeout(() => { if (helper.exitCode === null) helper.kill(); }, 1500);
    timer.unref();
  }
  dispose() {
    this.closed = true;
    this.stopHelper();
    if (this.blocker !== null) { powerSaveBlocker.stop(this.blocker); this.blocker = null; }
  }
}

module.exports = { KeepAwake };
