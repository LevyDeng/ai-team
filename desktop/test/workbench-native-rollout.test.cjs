const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {findExecutable,cleanEnv}=require('../workbench/agents.cjs');
const {startBridge}=require('../workbench/api/bridge.cjs');
const {NativeHistory,displayEvent}=require('../workbench/native-history.cjs');
test('Installed Codex writes an owned native transcript that the bubble synchronizer can read without desktop credentials',{timeout:50000},async t=>{
  let executable;try{executable=findExecutable({engine:'codex'});}catch{t.skip('No native Codex installed.');return;}
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-owned-rollout-'));t.after(()=>{try{fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});}catch{}});
  let requests=0;const bridge=await startBridge({settings:{mode:'chat',baseUrl:'https://fixture.invalid',label:'Fixture'},apiKey:'fixture-only',upstreamFetch:async()=>{requests++;return new Response('data: '+JSON.stringify({choices:[{delta:{content:'OWNED_NATIVE_REPLY'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}});t.after(()=>bridge.close());
  const home=path.join(directory,'home');fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,'config.toml'),'model="fixture-model"\nmodel_provider="fixture"\nweb_search="disabled"\ncheck_for_update_on_startup=false\n[features]\nplugins=false\nremote_plugin=false\n[model_providers.fixture]\nname="Fixture"\nbase_url='+JSON.stringify(bridge.url)+'\nwire_api="responses"\nenv_key="FIXTURE_KEY"\nrequires_openai_auth=false\nsupports_websockets=false\n');
  const originator='relay_desk_fixture_'+Date.now(),events=[],tail=new NativeHistory({engine:'codex',root:home,originator,event:row=>{const e=displayEvent('codex',row);if(e)events.push(e);}});
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(executable,['--no-daemon','exec','--skip-git-repo-check','--json','-s','read-only','Fixture transcript request'],{cwd:directory,env:{...cleanEnv(directory),CODEX_HOME:home,CODEX_INTERNAL_ORIGINATOR_OVERRIDE:originator,FIXTURE_KEY:bridge.token},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let error='';child.stdout.resume();child.stderr.on('data',data=>error=(error+data.toString()).slice(-3000));const timeout=setTimeout(()=>{child.kill();reject(new Error('Native transcript fixture timed out.'));},40000);
    child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('close',code=>{clearTimeout(timeout);resolve({code,error});});
  });
  assert.equal(result.code,0,result.error.split(bridge.token).join('[redacted]'));tail.poll();assert(tail.file,'The exact originator must identify the native rollout.');assert(events.some(e=>e.kind==='user'&&e.text==='Fixture transcript request'));assert(events.some(e=>e.kind==='assistant'&&e.text.includes('OWNED_NATIVE_REPLY')));assert(requests>0);
});
