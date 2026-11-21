const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const binary = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(binary) || ['node-pty', 'yaml', '@langchain/langgraph'].some(name => !fs.existsSync(path.join(__dirname, 'node_modules', name, 'package.json')))) {
  console.log('Preparing Relay Desk for first use...');
  const cache = path.join(root, '.runtime', 'npm-cache');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const install = spawnSync(process.execPath, [npmCli, 'ci', '--cache', cache, '--no-audit', '--no-fund', '--omit=optional'], { cwd: __dirname, stdio: 'inherit', windowsHide: true });
  if (install.error || install.status !== 0) { console.error(install.error?.message || 'Dependency installation failed.'); process.exit(install.status || 1); }
  const runtime = spawnSync(process.execPath, [path.join(__dirname, 'node_modules', 'electron', 'install.js')], { cwd: __dirname, stdio: 'inherit', windowsHide: true, env: { ...process.env, electron_config_cache: path.join(root, '.runtime', 'electron-cache') } });
  if (runtime.error || runtime.status !== 0) { console.error(runtime.error?.message || 'Electron installation failed.'); process.exit(runtime.status || 1); }
}
if (process.argv.includes('--prepare-only')) {
  const check = spawnSync(binary, ['-e', "require('node-pty'); require('ssh2'); require('yaml');"], {
    cwd: __dirname, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (check.error || check.status !== 0) {
    console.error(check.error?.message || 'Electron dependency loading failed.');
    process.exit(check.status || 1);
  }
  console.log('Relay Desk runtime is ready.');
  process.exit(0);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, [__dirname, ...process.argv.slice(2)], { cwd: root, detached: true, windowsHide: false, stdio: 'ignore', env });
child.unref();
