const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { atomic } = require('./store.cjs');
const { npmLatest, versionFromOutput } = require('./cli-release.cjs');
const { replacePackage } = require('./managed-npm.cjs');
const run = promisify(execFile);
const directory = path.resolve(__dirname, '../../.runtime/workbench/cli');
const packageName = '@openai/codex';
function managedExecutable(root, manifest, installRoot = root) {
  try {
    const { executable } = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'));
    const file = path.resolve(root, executable);
    if (file.startsWith(installRoot + path.sep) && fs.statSync(file).isFile()) return file;
  } catch {}
  return '';
}
function managed() {
  return managedExecutable(directory, 'ready.json');
}
function apiDeskManaged() {
  const root = path.resolve(process.env.API_DESK_DATA_DIR || path.join(__dirname, '../../../codex-api-desk/.local'));
  return managedExecutable(root, 'runtime-ready.json', path.join(root, 'runtime'));
}
function installed() {
  if (!managed()) return '';
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'ready.json'), 'utf8')).version || ''; }
  catch { return ''; }
}
let updating = false;
async function install({ request, env: installEnv = process.env, expected } = {}) {
  if (updating) throw new Error('CLI update is already in progress.'); updating=true;
  try {
    const latest = await npmLatest(packageName, request);
    if (expected && latest !== expected) throw new Error('The published version changed. Check for updates again.');
    function search(folder,depth) { if (!depth)return '';for(const e of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,e.name);if(e.isFile()&&e.name==='codex.exe')return file;if(e.isDirectory()){const found=search(file,depth-1);if(found)return found;}}return ''; }
    const executable = await replacePackage({
      target: path.join(directory,'runtime'), cache: path.join(directory,'cache'),
      name: packageName, version: latest, env: installEnv,
      async verify(staging) {
        const file = search(path.join(staging,'node_modules/@openai'),8);
        if (!file) throw new Error('Installed CLI binary not found.');
        const { stdout } = await run(file, ['--version'], { encoding:'utf8', windowsHide:true, timeout:15000 });
        if (versionFromOutput(stdout) !== latest) throw new Error('Installed CLI version verification failed.');
        return file;
      },
      publish: file => atomic(path.join(directory,'ready.json'), { version:latest, executable:path.relative(directory,file) }),
    });
    return {version:latest,executable};
  } finally { updating=false; }
}
module.exports={managed,apiDeskManaged,installed,latest:request=>npmLatest(packageName,request),install};
