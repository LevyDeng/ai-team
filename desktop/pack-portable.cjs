const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Run this command on Windows x64.');
if (!process.env.npm_execpath) throw new Error('Run npm run pack:windows.');

const root = path.resolve(__dirname, '..');
const releaseDir = path.resolve(process.argv[2] || path.join(root, '.runtime', 'release'));
const packageJson = JSON.parse(execFileSync('git', ['show', 'HEAD:desktop/package.json'], { cwd: root, encoding: 'utf8' }));
const name = `ai-team-${packageJson.version}-win-x64`;
if (!/^ai-team-\d+\.\d+\.\d+-win-x64$/.test(name)) throw new Error('The package must have a stable numeric version.');
const electron = path.dirname(require('electron'));
if (fs.readFileSync(path.join(electron, 'version'), 'utf8').trim() !== packageJson.devDependencies.electron) {
  throw new Error('Run npm ci to install the Electron version specified by HEAD.');
}

const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
const output = path.join(releaseDir, name + '.zip');
if (fs.existsSync(output)) throw new Error(`Release already exists: ${output}`);
fs.mkdirSync(releaseDir, { recursive: true });
const stage = fs.mkdtempSync(path.join(releaseDir, 'pack-'));
const bundle = path.join(stage, name);
const app = path.join(bundle, 'resources', 'app');
const payload = path.join(stage, 'source.tar');
const zip = path.join(stage, name + '.zip');
try {
  // Package a committed tree so workstation state, credentials and untracked media never enter a release.
  const paths = ['.env.example', 'ai-team.cmd', 'antigravity-login.cmd', 'claude-desk.cmd', 'codebuddy-login.cmd',
    'Create-DesktopShortcut.ps1', 'Env.ps1', 'Export-RelayDesk.ps1', 'Install-CodeBuddyCommand.ps1', 'Keep-Awake.ps1',
    'New-Secret.ps1', 'Ports.ps1', 'ProcessLifetime.ps1', 'README.md', 'relay-desk.vbs', 'setup-relay-desk.cmd',
    'Setup-RelayDesk.ps1', 'setup-ssh.cmd', 'Setup-Ssh.ps1', 'start-win-mcp-svr.cmd', 'Start-WindowsMcp.ps1',
    'bin', 'desktop', 'docs', 'server', 'android', ':(exclude)desktop/test'];
  execFileSync('git', ['archive', '--format=tar', '--output', payload, 'HEAD', '--', ...paths], { cwd: root, stdio: 'inherit' });
  fs.cpSync(electron, bundle, { recursive: true });
  fs.renameSync(path.join(bundle, 'electron.exe'), path.join(bundle, 'ai-team.exe'));
  fs.renameSync(path.join(bundle, 'electron_wer.dll'), path.join(bundle, 'ai-team_wer.dll'));
  fs.rmSync(path.join(bundle, 'resources', 'default_app.asar'), { force: true });
  fs.mkdirSync(app, { recursive: true });
  execFileSync(tar, ['-xf', payload, '-C', app], { stdio: 'inherit' });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
    name: 'ai-team', productName: 'AI Team', version: packageJson.version, main: 'desktop/workbench/main.cjs',
  }));
  execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'],
    { cwd: path.join(app, 'desktop'), stdio: 'inherit' });
  execFileSync(tar, ['-a', '-cf', zip, '-C', stage, name], { stdio: 'inherit' });
  fs.copyFileSync(zip, output, fs.constants.COPYFILE_EXCL);
  console.log(output);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
