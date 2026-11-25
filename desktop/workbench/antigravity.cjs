const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {packageVersion,versionFromOutput}=require('./cli-release.cjs');
const run=promisify(execFile);
const directory=path.resolve(__dirname,'../../.runtime/workbench/agents/antigravity');
const executable=path.join(directory,'agy.exe');
function validateManifest(value){
  if(!value||typeof value.version!=='string'||!packageVersion.test(value.version)||typeof value.sha512!=='string'||!/^[a-f0-9]{128}$/i.test(value.sha512))throw new Error('Invalid Antigravity release manifest.');
  const url=new URL(value.url);
  if(url.protocol!=='https:'||url.hostname!=='storage.googleapis.com'||!url.pathname.startsWith('/antigravity-public/antigravity-cli/')||url.username||url.password||url.search||url.hash)throw new Error('Unexpected Antigravity download origin.');
  return value;
}
let installing=false;
async function manifest(request=fetch){
  if(process.platform!=='win32'||!['x64','arm64'].includes(process.arch))throw new Error('This managed Antigravity installer requires Windows x64 or ARM64.');
  const platform=process.arch==='arm64'?'windows_arm64':'windows_amd64';
  const response=await request('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/'+platform+'.json',{signal:AbortSignal.timeout(20000),redirect:'error'});
  if(!response.ok)throw new Error('Could not read Google Antigravity release manifest.');
  const body=await response.text();
  if(body.length>16384)throw new Error('Antigravity manifest is too large.');
  return validateManifest(JSON.parse(body));
}
async function installed(){
  if(!fs.existsSync(executable))return '';
  const {stdout}=await run(executable,['--version'],{encoding:'utf8',windowsHide:true,timeout:15000});
  return versionFromOutput(stdout);
}
async function install({request=fetch,expected}={}){
  if(installing)throw new Error('Antigravity installation is already running.');installing=true;
  const temporary=executable+'.'+crypto.randomUUID()+'.download.exe';
  try{
    const release=await manifest(request);
    if(expected&&release.version!==expected)throw new Error('The published version changed. Check for updates again.');
    fs.mkdirSync(directory,{recursive:true});
    const download=await request(release.url,{signal:AbortSignal.timeout(300000),redirect:'error'});if(!download.ok||!download.body)throw new Error('Could not download Antigravity CLI.');
    const hash=crypto.createHash('sha512');let size=0;
    await pipeline(Readable.fromWeb(download.body),new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>768*1024*1024)return callback(new Error('Antigravity download exceeded its size limit.'));hash.update(chunk);callback(null,chunk);}}),fs.createWriteStream(temporary,{flags:'wx'}));
    if(hash.digest('hex')!==release.sha512.toLowerCase())throw new Error('Antigravity SHA-512 verification failed.');
    const {stdout}=await run(temporary,['--version'],{encoding:'utf8',windowsHide:true,timeout:20000});if(versionFromOutput(stdout)!==release.version)throw new Error('Antigravity version verification failed.');
    fs.renameSync(temporary,executable);return {engine:'antigravity',version:release.version,executable};
  }finally{installing=false;try{fs.unlinkSync(temporary);}catch{}}
}
module.exports={directory,executable,installed,latest:async request=>(await manifest(request)).version,install,validateManifest};
