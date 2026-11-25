const fs=require('node:fs');
const path=require('node:path');
const vendors=require('./vendor-agents.cjs');
const antigravity=require('./antigravity.cjs');
const {npmLatest}=require('./cli-release.cjs');
const {replacePackage}=require('./managed-npm.cjs');
const installing=new Set();
const packageRoot=engine=>path.join(vendors.managedRoot,engine,'node_modules',vendors.packages[engine]);
function managed(engine){
  if(engine==='antigravity')return fs.existsSync(antigravity.executable)?antigravity.executable:'';
  return vendors.packageBin(packageRoot(engine));
}
function installed(engine){
  if(engine==='antigravity')return antigravity.installed();
  if(!managed(engine))return '';
  try{return JSON.parse(fs.readFileSync(path.join(packageRoot(engine),'package.json'),'utf8')).version||'';}catch{return '';}
}
function latest(engine,request){
  return engine==='antigravity'?antigravity.latest(request):npmLatest(vendors.packages[engine],request);
}
async function install(engine,{request,env:installEnv=process.env,expected}={}){
  if(engine==='antigravity')return antigravity.install({request,expected});
  const packageName=vendors.packages[engine];
  if(!packageName)throw new Error('Use this agent\'s official installation guide.');
  if(installing.has(engine))throw new Error('This agent is already being installed.');
  installing.add(engine);
  try{
    const versionToInstall=await latest(engine,request);
    if(expected&&versionToInstall!==expected)throw new Error('The published version changed. Check for updates again.');
    const executable = await replacePackage({
      target: path.join(vendors.managedRoot, engine), cache: path.join(vendors.managedRoot, 'cache'),
      name: packageName, version: versionToInstall, minimum: [22, 19], env: installEnv,
      verify(staging) {
        const root = path.join(staging, 'node_modules', packageName);
        const entry = vendors.packageBin(root);
        const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (!entry || metadata.name !== packageName || metadata.version !== versionToInstall) {
          throw new Error('Installed package verification failed.');
        }
        return entry;
      },
    });
    return {engine,version:versionToInstall,executable};
  }finally{installing.delete(engine);}
}
module.exports={install,managed,installed,latest};
