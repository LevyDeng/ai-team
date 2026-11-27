const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const catalog = {
  antigravity: { label:'Antigravity', docs:'https://antigravity.google/docs/cli/acp/', names:['agy.exe','agy'], folder:'.gemini', config:'', effort:true },
  kimi: { label:'Kimi Code', docs:'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started', names:['kimi.exe','kimi','kimi-code.exe'], folder:'.kimi-code', config:'KIMI_CODE_HOME', effort:false },
  cursor: { label:'Cursor Agent', docs:'https://cursor.com/docs/cli/installation', names:['cursor-agent.exe','cursor-agent'], folder:'.cursor', config:'CURSOR_CONFIG_DIR', effort:false },
  workbuddy: { label:'WorkBuddy', docs:'https://www.codebuddy.cn/workbuddy/', names:[], folder:'.workbuddy', config:'WORKBUDDY_CONFIG_DIR', effort:true },
  codebuddy: { label:'CodeBuddy Code', docs:'https://www.codebuddy.ai/docs/cli/installation', names:['codebuddy.exe','codebuddy'], folder:'.codebuddy', config:'CODEBUDDY_CONFIG_DIR', effort:true },
  zcode: { label:'ZCode', docs:'https://zcode.z.ai/cn/docs/install', names:['zcode.exe','zcode'], effort:false },
  'custom-acp': { label:'自定义 ACP', effort:false },
};
function isVendor(engine) { return Object.hasOwn(catalog,engine); }
function usesAcp(engine) { return isVendor(engine) && engine !== 'zcode'; }
function supportsRemote(engine, location) {
  return engine === 'antigravity' && location.type === 'ssh' && location.os === 'linux' && location.control === 'ssh';
}
const packages={kimi:'@moonshot-ai/kimi-code',codebuddy:'@tencent-ai/codebuddy-code'};
const managedRoot=path.resolve(__dirname,'../../.runtime/workbench/agents');
function packageBin(root) {
  try {const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.kimi || pkg.bin?.codebuddy || Object.values(pkg.bin || {})[0];const file=typeof bin==='string'?path.resolve(root,bin):'';return file.startsWith(root+path.sep)&&validEntry(file)?file:'';}catch{return '';}
}
function validEntry(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  if (/\.cmd$|\.ps1$/i.test(file)) return false;
  // Desktop window launchers do not accept the headless/ACP protocol.
  if (/^(?:cursor|kimi|workbuddyai|zcode)\.exe$/i.test(path.basename(file)) && fs.existsSync(path.join(path.dirname(file),'resources','app.asar'))) return false;
  return true;
}
function customSettings(role) {
  const { acpArgs: args = [], acpEnv: env = {} } = role;
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0'))) {
    throw new Error('ACP 启动参数须为 JSON 字符串数组，最多 64 项。');
  }
  if (!env || typeof env !== 'object' || Object.getPrototypeOf(env) !== Object.prototype || Object.keys(env).length > 64 ||
      Object.entries(env).some(([name, value]) => !/^[a-z_][a-z0-9_]*$/i.test(name) ||
        typeof value !== 'string' || value.length > 4000 || value.includes('\0'))) {
    throw new Error('ACP 环境变量须为 JSON 对象，变量名须有效且值须为字符串，最多 64 项。');
  }
  return { acpArgs: args, acpEnv: env };
}
function findCustom(command, directories, {home, local}) {
  command = String(command || '').trim();
  if (/\.bat$/i.test(command)) return '';
  if (path.isAbsolute(command)) return validEntry(command) ? command : '';
  if (!/^[a-z0-9_.-]+$/i.test(command)) return '';
  if (command === 'hermes') {
    const managed = path.join(managedRoot, 'hermes', ...(process.platform === 'win32' ? ['Scripts', 'hermes.exe'] : ['bin', 'hermes']));
    const official = local && path.join(local, 'hermes', 'bin', 'hermes.exe');
    if (validEntry(managed)) return managed;
    if (validEntry(official)) return official;
  }
  if (command === 'pi-acp') {
    const managed = packageBin(path.join(managedRoot, 'pi', 'node_modules', 'pi-acp'));
    if (managed) return managed;
  }
  const npmPackage = command === 'dsh' ? '@deepseek-ai/dsh' : command === 'pi-acp' ? 'pi-acp' : '';
  if (command === 'dsh') {
    const managed = packageBin(path.join(managedRoot, 'dsh', 'node_modules', npmPackage));
    if (managed) return managed;
  }
  for (const directory of directories.filter(path.isAbsolute)) {
    for (const name of [command, ...(process.platform === 'win32' && !path.extname(command) ? [command + '.exe'] : [])]) {
      const file = path.join(directory, name);
      if (validEntry(file)) return file;
    }
    if (npmPackage) {
      const entry = packageBin(path.join(directory, 'node_modules', npmPackage));
      if (entry) return entry;
    }
  }
  if (command === 'dsh') {
    const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
    if (path.isAbsolute(dshHome)) return packageBin(path.join(dshHome, 'profiles', 'web', 'node_modules', npmPackage));
  }
  return '';
}
function find(role, { home = os.homedir(), local = process.env.LOCALAPPDATA || '', programFiles = process.env.ProgramFiles || 'C:/Program Files', searchPath = process.env.PATH || '' } = {}) {
  if (!isVendor(role.engine)) return '';
  if (role.engine === 'custom-acp') {
    return findCustom(role.executable, [...searchPath.split(path.delimiter), path.join(process.env.APPDATA || home, 'npm'), path.join(home, '.local', 'bin')], {home, local});
  }
  if (role.executable) {
    if (role.engine === 'zcode' && (!path.isAbsolute(role.executable) || !validEntry(role.executable) || /\.bat$/i.test(role.executable))) {
      throw new Error('请选择 ZCode CLI 可执行文件或 ZCode 安装目录里的 resources/glm/zcode.cjs。');
    }
    if (!validEntry(role.executable)) throw new Error('Choose the official agent runtime, not a desktop window launcher or shell shim.');
    return role.executable;
  }
  const candidates = [];
  if (role.engine === 'zcode') {
    for (const root of [path.join(managedRoot,'zcode'), path.join(local,'Programs','ZCode'), path.join(programFiles,'ZCode')]) {
      candidates.push(path.join(root,'resources','glm','zcode.cjs'));
    }
  }
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
  if (script && path.basename(entry).toLowerCase() === 'zcode.cjs') {
    const node = find({engine:'custom-acp', executable:'node'});
    if (!node) throw new Error('ZCode CLI 脚本需要 Node.js 24，请安装 Node.js 并确认 node 已加入 PATH。');
    const config = path.resolve(path.dirname(entry),'../config/provider/zcode-builtin.json');
    const launchEnv = {...env};
    if (!launchEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && fs.existsSync(config)) launchEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config;
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    return {command:node,args:[entry,...args],env:launchEnv};
  }
  // DSH native addons distinguish Node.js from Electron even in RunAsNode mode.
  if (script && /[\\/]@deepseek-ai[\\/]dsh[\\/]/i.test(entry)) {
    const node = find({engine:'custom-acp', executable:'node'});
    if (!node) throw new Error('DeepSeek Harness 需要 Node.js。请安装 Node.js 并确认 node 已加入 PATH。');
    const launchEnv = {...env};
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    return {command:node, args:[entry,...args], env:launchEnv};
  }
  if (script) return { command:process.execPath,args:[entry,...args],env:{...env,ELECTRON_RUN_AS_NODE:'1'} };
  return { command:entry,args,env };
}
function environment(role, env) {
  if (!isVendor(role.engine)) return env;
  if(role.engine==='antigravity' || role.engine==='custom-acp' || role.engine==='zcode'){
    const result={...env};
    if (role.engine==='antigravity') for(const name of Object.keys(result))if(/^(?:AGY_|ANTIGRAVITY_|GOOGLE_CLOUD_|GCLOUD_|GOOGLE_APPLICATION_CREDENTIALS$)/i.test(name))delete result[name];
    for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME']){if(process.env[name])result[name]=process.env[name];else delete result[name];}
    return result;
  }
  const config=catalog[role.engine],directory=process.env[config.config] || path.join(os.homedir(),config.folder);
  const result={...env,[config.config]:directory};
  if(role.engine==='workbuddy') Object.assign(result,{CODEBUDDY_CONFIG_DIR:directory,CODEBUDDY_DISABLE_IDE:'1',SERVER__HOST:'127.0.0.1',SERVER__PORT:'0',DISABLE_GALILEO:'1'});
  return result;
}
function customEnvironment(role) {
  if (role.engine !== 'custom-acp') return { env: {}, secrets: [] };
  const { acpEnv } = customSettings(role);
  const secrets = [];
  const env = Object.fromEntries(Object.entries(acpEnv).map(([name, value]) => {
    const reference = /^\$\{([a-z_][a-z0-9_]*)\}$/i.exec(value);
    if (!reference) return [name, value];
    const resolved = process.env[reference[1]];
    if (resolved === undefined) throw new Error('未找到 ACP 引用的本机环境变量：' + reference[1]);
    if (resolved) secrets.push(resolved);
    return [name, resolved];
  }));
  if (role.executable?.trim() === 'pi-acp' && env.PI_ACP_PI_COMMAND === undefined && !process.env.PI_ACP_PI_COMMAND) {
    const managedPi = path.join(managedRoot, 'pi', 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi');
    if (fs.existsSync(managedPi)) env.PI_ACP_PI_COMMAND = managedPi;
  }
  return { env, secrets };
}
function args(role) {
  if (!usesAcp(role.engine)) throw new Error('Unsupported ACP agent.');
  if (role.engine === 'custom-acp') return customSettings(role).acpArgs;
  if(role.engine==='antigravity')return ['acp','--process-per-session',...(role.permission==='danger-full-access'?['--dangerously-skip-permissions']:[])];
  const result=[];
  // Cursor ask mode rejects parameterized model IDs at startup; ACP applies the parameters after the session opens.
  if(role.model)result.push('--model',role.engine==='cursor'&&role.permission==='read-only'?require('./chat-settings.js').parseCursorModel(role.model).id:role.model);
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
function loginArgs(engine) { if (engine==='zcode') return ['login','bigmodel']; return engine==='antigravity'?['acp','--login']:engine==='kimi'?['login']:engine==='cursor'?['login']:[]; }
async function stop(child,cancel=()=>child.kill(),{graceful=false}={}) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise(resolve => {
    let force;
    const done = () => {
      clearTimeout(deadline);
      clearTimeout(force);
      child.removeListener('exit', done);
      resolve();
    };
    const grace = graceful ? 500 : 0;
    const deadline = setTimeout(done, 1500 + grace);
    child.once('exit', done);
    if (graceful) {
      child.stdin.end();
      force = setTimeout(cancel, grace);
    } else cancel();
  });
}
function info(role) { let executable='',error='';try{executable=find(role);}catch(e){error=e.message;}return { ...catalog[role.engine],installed:Boolean(executable),executable,error,installable:Boolean(packages[role.engine])||role.engine==='antigravity',experimental:role.engine==='workbuddy',source:role.engine==='workbuddy'?'desktop-engine':role.engine==='custom-acp'?'custom-acp':'official-account-cli' }; }
module.exports={catalog,isVendor,usesAcp,supportsRemote,find,validEntry,launch,environment,customSettings,customEnvironment,args,loginArgs,info,packages,managedRoot,packageBin,stop};
