const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {Usage,normalize,codexUsage,claudeUsage,queryNative}=require('../workbench/usage.cjs');
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-usage-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const roles=[],locations=[{id:'local',type:'local'},{id:'remote',type:'ssh',managed:true},{id:'other',type:'ssh'}];
  const store={directory,state:{roles,locations},get:(kind,id)=>{const value=store.state[kind].find(x=>x.id===id);if(!value)throw new Error('Missing fixture');return value;}};
  const vault={values:{},get:id=>vault.values[id]||''},backend={usage:{claude:{state:'pending',windows:[]},codex:{state:'pending',windows:[]}}};
  const agents={environment:(role)=>({CODEX_HOME:role.codexLoginSource==='desktop'?'shared-codex':path.join(directory,role.id,'codex'),CLAUDE_CONFIG_DIR:path.join(directory,role.id,'claude'),CODEBUDDY_CONFIG_DIR:'shared-codebuddy'})};
  const network={policy:()=>({mode:'direct'}),environmentFor:async(_role,env)=>env,fetchFor:async()=>{throw new Error('Unexpected fixture network request');}};
  const service=new Usage({store,vault,agents,backend,locations:{connect:async()=>{throw new Error('Unexpected SSH connection');}},network,native:async()=>({state:'ready',windows:[{id:'first',label:'Fixture',usedPercent:25}],updatedAt:Date.now(),source:'codex-app-server'})});t.after(()=>service.close());
  const add=(id,extra={})=>{const role={id,engine:'codex',provider:'native',locationId:'local',...extra};roles.push(role);return role;};
  return {service,store,vault,backend,agents,network,add,directory};
}
test('All roles are represented without launching CLI or SSH; only shared login configurations group together',t=>{
  const {service,add}=fixture(t);add('a',{codexLoginSource:'desktop'});add('b',{codexLoginSource:'desktop'});add('c');add('d');add('e',{engine:'antigravity'});add('f',{engine:'cursor'});add('g',{locationId:'other'});
  const entries=service.snapshot();assert.equal(entries.length,6);assert.deepEqual(entries[0].roleIds,['a','b']);assert.equal(entries.find(x=>x.engine==='antigravity').refreshable,false);assert.equal(entries.find(x=>x.locationId==='other').state,'unsupported');assert(!JSON.stringify(entries).includes('shared-codex'));
  add('h',{locationId:'other'});assert.equal(service.snapshot().filter(e=>e.locationId==='other').length,2);
});
test('Real native protocol helpers request quota metadata only and strip unrelated account fields',async()=>{
  const calls=[],children=new Set();const launch=(_file,args,options)=>{calls.push(args);return spawn(process.execPath,[path.join(__dirname,'fixtures/usage-agent.cjs')],options);};
  for(const engine of ['codex','claude']){const result=await queryNative({engine,provider:'native'},process.env,process.cwd(),{executable:'fixture.exe',launch,children});assert.equal(result.state,'ready');assert.equal(result.windows[0].usedPercent,engine==='codex'?0:14);assert(!JSON.stringify(result).includes('DO_NOT_EXPORT'));}
  assert.equal(children.size,0);assert(calls[0].includes('app-server'));assert(calls[1].includes('--no-session-persistence'));assert(calls[1].includes('--tools'));
});
test('Used percentage normalization rejects missing, out-of-range, and non-number values without inventing remaining quota',()=>{
  const codex=codexUsage({rateLimitsByLimitId:{team:{limitName:'Team',primary:{usedPercent:40,windowDurationMins:300},secondary:{usedPercent:100,windowDurationMins:10080}}}});assert.deepEqual(codex.windows.map(w=>w.usedPercent),[40,100]);
  const claude=claudeUsage({rate_limits:{five_hour:{utilization:0},seven_day:{utilization:25},model_scoped:[{display_name:'Model quota',utilization:33}]}});assert.deepEqual(claude.windows.map(w=>w.usedPercent),[0,25,33]);
  assert.equal(codexUsage({}).state,'unsupported');assert.equal(claudeUsage({}).windows.length,0);
  assert.equal(normalize({windows:[{usedPercent:null},{usedPercent:'40'},{usedPercent:101},{usedPercent:-1},{usedPercent:NaN},{usedPercent:0}]}).windows.length,1);
});
test('Requests deduplicate shared accounts, respect cooldown and persist only sanitized quota data',async t=>{
  const f=fixture(t);f.add('a',{codexLoginSource:'desktop'});f.add('b',{codexLoginSource:'desktop'});let calls=0;
  f.service.native=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));return {state:'ready',windows:[{id:'first',usedPercent:5}],updatedAt:Date.now(),privateToken:'DO_NOT_EXPORT'};};
  await Promise.all([f.service.request('a'),f.service.request('b')]);await f.service.request('a');assert.equal(calls,1);assert.equal(f.service.snapshot()[0].windows[0].usedPercent,5);assert(!fs.readFileSync(f.service.file,'utf8').includes('DO_NOT_EXPORT'));
  const loaded=new Usage({...f.service});assert.equal(loaded.snapshot()[0].cached,true);assert.equal(loaded.snapshot()[0].windows[0].usedPercent,5);
});
test('A failed refresh retains old readings as explicitly cached and hides raw errors',async t=>{
  const {service,add}=fixture(t);add('a');await service.request('a');service.attempts.clear();service.native=async()=>{throw new Error('DO_NOT_EXPORT');};await service.request('a');const entry=service.snapshot()[0];assert.equal(entry.state,'error');assert.equal(entry.cached,true);assert.equal(entry.windows[0].usedPercent,25);assert(!JSON.stringify(entry).includes('DO_NOT_EXPORT'));
});
test('Reauthorizing a shared login clears its cached quota and discards an older in-flight result',async t=>{
  const f=fixture(t);f.add('a',{codexLoginSource:'desktop'});f.add('b',{codexLoginSource:'desktop'});await f.service.request('a');f.service.invalidate('b');assert.equal(f.service.snapshot()[0].windows.length,0);
  let finish;f.service.native=()=>new Promise(resolve=>{finish=resolve;});const work=f.service.request('a');for(let count=0;count<20&&!finish;count++)await new Promise(resolve=>setTimeout(resolve,5));assert(finish);f.service.invalidate('b');finish({state:'ready',windows:[{id:'old-account',usedPercent:99}],updatedAt:Date.now()});await work;assert.equal(f.service.snapshot()[0].windows.length,0);
});
test('API balance uses official endpoint, selected proxy, and current role key; key changes invalidate cached data',async t=>{
  const f=fixture(t);f.add('a',{provider:'deepseek'});f.vault.values['api:a']='fixture-secret';let request;
  f.network.fetchFor=async role=>async(url,options)=>{request={role,url,options};return {ok:true,status:200,text:async()=>JSON.stringify({balance_infos:[{currency:'CNY',total_balance:'12.3400'}]})};};
  await f.service.request('a');const before=f.service.snapshot()[0];assert.equal(request.url,'https://api.deepseek.com/user/balance');assert.equal(request.options.headers.Authorization,'Bearer fixture-secret');assert.equal(request.options.redirect,'error');assert.deepEqual(before.balances,[{currency:'CNY',remaining:'12.3400'}]);
  assert(!JSON.stringify(before).includes('fixture-secret'));f.vault.values['api:a']='changed-secret';const after=f.service.snapshot()[0];assert.notEqual(before.id,after.id);assert.equal(after.balances.length,0);assert.equal(after.state,'pending');
});
test('Custom endpoints and providers without balance adapters remain explicit unknowns',async t=>{
  const f=fixture(t);f.add('a',{provider:'deepseek',baseUrl:'https://example.com/v1'});f.add('b',{provider:'openai'});f.add('c',{provider:'gemini'});f.add('d',{engine:'kimi'});f.add('e',{engine:'workbuddy'});await f.service.request();assert.equal(f.service.snapshot().length,5);assert(f.service.snapshot().every(e=>e.state==='unsupported'&&e.windows.length===0&&e.balances.length===0));assert.equal(f.service.snapshot()[0].reason,'custom_endpoint');
  assert.equal(f.service.endpoint({provider:'deepseek',baseUrl:'https://api.deepseek.com:8443/v1'}),null);
});
test('Moonshot API money, authentication errors and malformed balance data are handled separately from subscriptions',async t=>{
  const f=fixture(t);f.add('a',{provider:'moonshot',baseUrl:'https://api.moonshot.ai/v1'});f.vault.values['api:a']='fixture-secret';
  f.network.fetchFor=async()=>async()=>({ok:true,status:200,text:async()=>JSON.stringify({code:0,data:{available_balance:12.5}})});await f.service.request('a');assert.deepEqual(f.service.snapshot()[0].balances,[{currency:'USD',remaining:'12.5'}]);
  f.service.attempts.clear();f.network.fetchFor=async()=>async()=>({ok:false,status:401});await f.service.request('a');assert.equal(f.service.snapshot()[0].state,'not_signed_in');assert.equal(f.service.snapshot()[0].balances.length,0);
  f.service.attempts.clear();f.network.fetchFor=async()=>async()=>({ok:true,status:200,text:async()=>JSON.stringify({code:0,data:{available_balance:'unknown'}})});await f.service.request('a');assert.equal(f.service.snapshot()[0].state,'error');assert.equal(f.service.snapshot()[0].balances.length,0);
});
test('Managed VPS quotas connect only when explicitly refreshed and share the existing backend account',async t=>{
  const f=fixture(t);f.add('a',{engine:'claude',locationId:'remote'});f.add('b',{engine:'claude',locationId:'remote'});let connects=0,reads=0;f.service.locations.connect=async()=>{connects++;};f.backend.refreshUsage=async engine=>{reads++;f.backend.usage[engine]={state:'ready',windows:[{id:'5h',usedPercent:40}],source:'claude-cli-control',updatedAt:Date.now()};};
  f.service.snapshot();assert.equal(connects,0);await f.service.request();assert.equal(connects,1);assert.equal(reads,1);assert.equal(f.service.snapshot()[0].roleIds.length,2);assert.equal(f.service.snapshot()[0].windows[0].usedPercent,40);
  f.service.invalidate('a');assert.equal(f.service.snapshot()[0].windows.length,0);await f.service.request('b');assert.equal(f.service.snapshot()[0].windows[0].usedPercent,40);assert.equal(reads,2);
});
