const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

function npmNode(minimum) {
  const nodes = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  const node = nodes.find(file => fs.existsSync(path.join(path.dirname(file), 'node_modules/npm/bin/npm-cli.js')));
  if (!node) throw new Error('Install Node.js with npm first.');
  if (minimum) {
    const [major, minor] = execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim().slice(1).split('.').map(Number);
    if (major < minimum[0] || (major === minimum[0] && minor < minimum[1])) {
      throw new Error('Node.js ' + minimum.join('.') + ' or newer is required.');
    }
  }
  return node;
}

function npmInstall({ directory, cache, pkg, env, minimum }) {
  const node = npmNode(minimum);
  const installEnv = { ...env };
  delete installEnv.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const npm = path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js');
    const args = [npm, 'install', '--prefix', directory, '--cache', cache, '--registry', 'https://registry.npmjs.org',
      '--no-audit', '--no-fund', '--save-exact', pkg];
    const child = spawn(node, args, { windowsHide: true, env: installEnv, stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 600000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (!timedOut && code === 0) resolve();
      else reject(new Error(timedOut ? 'CLI installation timed out.' : 'npm installation failed.'));
    });
  });
}

async function remove(directory) {
  try { await fs.promises.rm(directory, { recursive: true, force: true }); }
  catch (error) { console.warn('Could not remove temporary CLI directory %s: %s', directory, error.message); }
}

async function replacePackage({ target, cache, name, version, minimum, env, verify, publish }, install = npmInstall) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, path.basename(target) + '-staging-'));
  const backup = target + '-previous-' + randomUUID();
  try {
    await install({ directory: staging, cache, pkg: name + '@' + version, env, minimum });
    const relative = path.relative(staging, await verify(staging));
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Installed CLI executable is outside the package directory.');
    }
    const executable = path.join(target, relative);
    const hadTarget = fs.existsSync(target);
    if (hadTarget) fs.renameSync(target, backup);
    let replaced = false;
    try {
      fs.renameSync(staging, target);
      replaced = true;
      publish?.(executable);
    } catch (error) {
      if (replaced) fs.renameSync(target, staging);
      if (hadTarget) fs.renameSync(backup, target);
      throw error;
    }
    if (hadTarget) await remove(backup);
    return executable;
  } finally { await remove(staging); }
}

module.exports = { replacePackage };
