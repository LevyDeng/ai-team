const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const vendors=require('./vendor-agents.cjs');
const installing=new Set();
async function install(engine){
  if(engine==='antigravity')return require('./antigravity.cjs').install();
  const packageName=vendors.packages[engine];
  if(!packageName)throw new Error('Use this agent\'s official installation guide.');
  if(installing.has(engine))throw new Error('This agent is already being installed.');
  installing.add(engine);
  try{
    const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(packageName)+'/latest',{signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!response.ok)throw new Error('Could not read the official npm registry.');
    const pkg=await response.json();
    if(pkg.name!==packageName||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version))throw new Error('Unexpected official package metadata.');
    const nodes=execFileSync('where.exe',['node.exe'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/);
    const node=nodes.find(file=>fs.existsSync(path.join(path.dirname(file),'node_modules/npm/bin/npm-cli.js')));
    if(!node)throw new Error('Install Node.js 22.19 or newer with npm first.');
    const version=execFileSync(node,['--version'],{encoding:'utf8',windowsHide:true}).trim().slice(1).split('.').map(Number);
    if(version[0]<22||(version[0]===22&&version[1]<19))throw new Error('Node.js 22.19 or newer is required.');
    const target=path.join(vendors.managedRoot,engine);fs.mkdirSync(target,{recursive:true});
    await new Promise((resolve,reject)=>{
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(node,[path.join(path.dirname(node),'node_modules/npm/bin/npm-cli.js'),'install','--prefix',target,'--cache',path.join(vendors.managedRoot,'cache'),'--registry','https://registry.npmjs.org','--no-audit','--no-fund','--save-exact',packageName+'@'+pkg.version],{env,windowsHide:true,stdio:'ignore'});
      const timer=setTimeout(()=>{child.kill();reject(new Error('Official agent installation timed out.'));},600000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Official agent npm installation failed. Check network access.'));});
    });
    const executable=vendors.packageBin(path.join(target,'node_modules',packageName));if(!executable)throw new Error('The installed official agent entry was not found.');
    return {engine,version:pkg.version,executable};
  }finally{installing.delete(engine);}
}
module.exports={install};
