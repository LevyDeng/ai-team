const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { atomic } = require('./store.cjs');
const directory = path.resolve(__dirname, '../../.runtime/workbench/cli');
function managed() {
  try { const value = JSON.parse(fs.readFileSync(path.join(directory,'ready.json'),'utf8')); const file = path.resolve(directory,value.executable); if (file.startsWith(directory + path.sep) && fs.existsSync(file)) return file; } catch {} return '';
}
async function check() {
  const response = await fetch('https://registry.npmjs.org/@openai%2fcodex/latest',{ signal:AbortSignal.timeout(20000),redirect:'error' });
  if (!response.ok) throw new Error('Could not query the official npm registry.');
  const value = await response.json(); if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version)) throw new Error('Unexpected package version.');
  let installed='';try { installed=JSON.parse(fs.readFileSync(path.join(directory,'ready.json'),'utf8')).version; } catch {}
  return { latest:value.version,installed,message:`托管版本：${installed || '未安装'}；最新版本：${value.version}` };
}
let updating = false;
async function install() {
  if (updating) throw new Error('CLI update is already in progress.'); updating=true;
  try {
    const {latest}=await check();
    const nodes=execFileSync('where.exe',['node.exe'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/);
    const node=nodes.find(n=>fs.existsSync(path.join(path.dirname(n),'node_modules/npm/bin/npm-cli.js')));
    if (!node) throw new Error('Install Node.js with npm before updating.');
    const target=path.join(directory,'runtime'); fs.mkdirSync(target,{recursive:true});
    await new Promise((resolve,reject)=> {
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(node,[path.join(path.dirname(node),'node_modules/npm/bin/npm-cli.js'),'install','--prefix',target,'--cache',path.join(directory,'cache'),'--registry','https://registry.npmjs.org','--no-audit','--no-fund','--save-exact','@openai/codex@'+latest],{windowsHide:true,env,stdio:'ignore'});
      const timer=setTimeout(()=>{child.kill();reject(new Error('CLI update timed out.'));},600000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('npm installation failed.'));});
    });
    function search(folder,depth) { if (!depth)return '';for(const e of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,e.name);if(e.isFile()&&e.name==='codex.exe')return file;if(e.isDirectory()){const found=search(file,depth-1);if(found)return found;}}return ''; }
    const executable=search(path.join(target,'node_modules/@openai'),8);if(!executable)throw new Error('Installed CLI binary not found.');
    const version=execFileSync(executable,['--version'],{encoding:'utf8',windowsHide:true,timeout:15000});if(!version.includes(latest))throw new Error('Installed CLI version verification failed.');
    atomic(path.join(directory,'ready.json'),{version:latest,executable:path.relative(directory,executable)});return {message:'已安装托管 Codex CLI '+latest+'，下次启动 Agent 生效。'};
  } finally { updating=false; }
}
module.exports={managed,check,install};
