const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const catalog = {
  antigravity: { label:'Antigravity', docs:'https://antigravity.google/docs/cli/acp/', names:['agy.exe','agy'], folder:'.gemini', config:'', effort:true },
  kimi: { label:'Kimi Code', docs:'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started', names:['kimi.exe','kimi','kimi-code.exe'], folder:'.kimi-code', config:'KIMI_CODE_HOME', effort:false },
  cursor: { label:'Cursor Agent', docs:'https://cursor.com/docs/cli/installation', names:['cursor-agent.exe','cursor-agent'], folder:'.cursor', config:'CURSOR_CONFIG_DIR', effort:false },
  workbuddy: { label:'WorkBuddy', docs:'https://www.codebuddy.cn/workbuddy/', names:[], folder:'.workbuddy', config:'WORKBUDDY_CONFIG_DIR', effort:true },
  codebuddy: { label:'CodeBuddy Code', docs:'https://www.codebuddy.ai/docs/cli/installation', names:['codebuddy.exe','codebuddy'], folder:'.codebuddy', config:'CODEBUDDY_CONFIG_DIR', effort:true },
};
function isVendor(engine) { return Object.hasOwn(catalog,engine); }
const packages={kimi:'@moonshot-ai/kimi-code',codebuddy:'@tencent-ai/codebuddy-code'};
const managedRoot=path.resolve(__dirname,'../../.runtime/workbench/agents');
function packageBin(root) {
  try {const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.kimi || pkg.bin?.codebuddy || Object.values(pkg.bin || {})[0];const file=typeof bin==='string'?path.resolve(root,bin):'';return file.startsWith(root+path.sep)&&validEntry(file)?file:'';}catch{return '';}
}
function validEntry(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  if (/\.cmd$|\.ps1$/i.test(file)) return false;
  // Desktop window launchers do not accept the headless/ACP protocol.
  if (/^(?:cursor|kimi|workbuddyai)\.exe$/i.test(path.basename(file)) && fs.existsSync(path.join(path.dirname(file),'resources','app.asar'))) return false;
  return true;
}
function find(role, { home = os.homedir(), local = process.env.LOCALAPPDATA || '', programFiles = process.env.ProgramFiles || 'C:/Program Files', searchPath = process.env.PATH || '' } = {}) {
  if (!isVendor(role.engine)) return '';
  if (role.executable) {
    if (!validEntry(role.executable)) throw new Error('Choose the official agent runtime, not a desktop window launcher or shell shim.');
    return role.executable;
  }
  const candidates = [];
  if(role.engine==='antigravity')candidates.push(require('./antigravity.cjs').executable,path.join(local,'agy','bin','agy.exe'));
  if (role.engine === 'workbuddy') for (const root of [path.join(programFiles,'WorkBuddyAI'),path.join(local,'Programs','WorkBuddyAI')]) candidates.push(path.join(root,'resources','app.asar.unpacked','cli','dist','codebuddy-lite-wb.mjs'));
  if (role.engine === 'kimi') for (const root of [path.join(local,'Programs','Kimi Code'),path.join(local,'Programs','kimi-code')]) candidates.push(path.join(root,'resources','app.asar.unpacked','node_modules','@moonshot-ai','kimi-code','dist','index.js'));
  if(packages[role.engine])for(const root of [path.join(managedRoot,role.engine,'node_modules'),path.join(process.env.APPDATA || home,'npm','node_modules'),...searchPath.split(path.delimiter).map(p=>path.join(p,'node_modules'))]){const file=packageBin(path.join(root,packages[role.engine]));if(file)candidates.push(file);}
  if(role.engine==='cursor')for(const root of [path.join(local,'cursor-agent'),path.join(home,'.local','share','cursor-agent')]){
    try{for(const version of fs.readdirSync(path.join(root,'versions')).sort().reverse())for(const name of ['index.js','index.mjs','agent.exe','cursor-agent.exe'])candidates.push(path.join(root,'versions',version,name));}catch{}
  }
  const directories = [path.join(home,'.local','bin'),...(role.engine==='codebuddy'?[path.join(local,'codebuddy','bin')]:[]),path.join(local,'cursor-agent'),...searchPath.split(path.delimiter)];
  for (const directory of directories) for (const name of catalog[role.engine].names) candidates.push(path.join(directory,name));
  return candidates.find(validEntry) || '';
}
function launch(entry, args, env) {
  let script=/\.(?:mjs|cjs|js)$/i.test(entry);
  if(!path.extname(entry)){try{const fd=fs.openSync(entry,'r'),header=Buffer.alloc(150);try{fs.readSync(fd,header);}finally{fs.closeSync(fd);}script=/^#![^\r\n]*\bnode\b/.test(header.toString());}catch{}}
  if (script) return { command:process.execPath,args:[entry,...args],env:{...env,ELECTRON_RUN_AS_NODE:'1'} };
  return { command:entry,args,env };
}
function environment(role, env) {
  if (!isVendor(role.engine)) return env;
  if(role.engine==='antigravity'){
    const result={...env};
    for(const name of Object.keys(result))if(/^(?:AGY_|ANTIGRAVITY_|GOOGLE_CLOUD_|GCLOUD_|GOOGLE_APPLICATION_CREDENTIALS$)/i.test(name))delete result[name];
    for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME']){if(process.env[name])result[name]=process.env[name];else delete result[name];}
    return result;
  }
  const config=catalog[role.engine],directory=process.env[config.config] || path.join(os.homedir(),config.folder);
  const result={...env,[config.config]:directory};
  if(role.engine==='workbuddy') Object.assign(result,{CODEBUDDY_CONFIG_DIR:directory,CODEBUDDY_DISABLE_IDE:'1',SERVER__HOST:'127.0.0.1',SERVER__PORT:'0',DISABLE_GALILEO:'1'});
  return result;
}
function args(role) {
  if (!isVendor(role.engine)) throw new Error('Unsupported native agent.');
  if(role.engine==='antigravity')return ['acp','--process-per-session',...(role.permission==='danger-full-access'?['--dangerously-skip-permissions']:[])];
  const result=[];
  if(role.model)result.push('--model',role.model);
  if(role.effort && catalog[role.engine].effort)result.push('--effort',role.effort);
  if(role.engine==='kimi') {
    if(role.permission==='read-only')result.push('--plan');
    else if(role.permission==='danger-full-access')result.push('--auto');
    return [...result,'acp'];
  }
  if(role.engine==='cursor') {
    if(role.permission==='read-only')result.push('--mode','ask');
    else if(role.permission==='danger-full-access')result.push('--force');
    return [...result,'acp'];
  }
  result.push('--permission-mode',role.permission==='read-only'?'plan':role.permission==='danger-full-access'?'bypassPermissions':'acceptEdits');
  if(role.engine==='workbuddy')result.unshift('--serve','--host','127.0.0.1');
  return [...result,'--acp'];
}
function loginArgs(engine) { return engine==='antigravity'?['acp','--login']:engine==='kimi'?['login']:engine==='cursor'?['login']:[]; }
async function stop(child,cancel=()=>child.kill()) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise(resolve=>{const done=()=>{clearTimeout(timer);child.removeListener('exit',done);resolve();};const timer=setTimeout(done,1500);child.once('exit',done);cancel();});
}
function info(role) { let executable='',error='';try{executable=find(role);}catch(e){error=e.message;}return { ...catalog[role.engine],installed:Boolean(executable),executable,error,installable:Boolean(packages[role.engine])||role.engine==='antigravity',experimental:role.engine==='workbuddy',source:role.engine==='workbuddy'?'desktop-engine':'official-account-cli' }; }
module.exports={catalog,isVendor,find,validEntry,launch,environment,args,loginArgs,info,packages,managedRoot,packageBin,stop};
