const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {AcpClient}=require('../workbench/acp-client.cjs');
const vendors=require('../workbench/vendor-agents.cjs');
const {Store}=require('../workbench/store.cjs');
const {Agents,cleanEnv}=require('../workbench/agents.cjs');
const {queryCli}=require('../workbench/model-catalogs.cjs');
const entry=path.join(__dirname,'fixtures/acp-agent.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-vendor-'));t.after(()=>fs.promises.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100}));return directory;}
function client(t,permission='workspace-write'){
  const child=spawn(process.execPath,[entry],{windowsHide:true,stdio:['pipe','pipe','pipe']});const state={text:''};const acp=new AcpClient(child,state,()=>{},{permission});t.after(()=>{acp.close();child.kill();});return {acp,state};
}
test('ACP carries long prompts on stdin, streams output and refuses extra permissions by default',async t=>{
  const {acp,state}=client(t);await acp.initialize();await acp.session(process.cwd(),{fixture:{command:'node',args:['fixture.js'],env:{FIXTURE:'value'}},http:{url:'https://example.test/mcp',headers:{Authorization:'Bearer fixture'}}});await acp.prompt('x'.repeat(160000));
  assert(state.completed);assert(state.text.includes('160000 cancelled'));assert(state.note.includes('not approved'));assert.equal(state.thinking,'Public reasoning summary');assert.equal(state.activities[0].status,'complete');assert(state.terminal.includes('Fixture output'));
});
test('ACP full access approves allow_once only, and authentication failure is actionable',async t=>{
  const {acp,state}=client(t,'danger-full-access');await acp.initialize();await acp.session(process.cwd(),{});await acp.prompt('fixture');assert(state.text.endsWith('selected'));assert(!state.note);
  await assert.rejects(acp.prompt('fixture-auth-error'),error=>error.code==='VENDOR_LOGIN_REQUIRED');
});
test('ACP exit before a final result retains partial output and never reports completion',async t=>{
  const {acp,state}=client(t);await acp.initialize();await acp.session(process.cwd(),{});await assert.rejects(acp.prompt('fixture-interrupt'),/before completion/);assert.equal(state.text,'Partial');assert(!state.completed);
});
test('WorkBuddy structured authentication refusal is a failed task, not an empty successful reply',async t=>{
  const {acp,state}=client(t);acp.role.engine='workbuddy';await acp.initialize();await acp.session(process.cwd(),{});await assert.rejects(acp.prompt('fixture-auth-refusal'),error=>error.code==='WORKBUDDY_DESKTOP_AUTH_UNAVAILABLE');assert(!state.completed);assert.equal(state.text,'');
  const args=vendors.args({engine:'workbuddy',permission:'read-only'});assert(args.includes('--serve'));assert(args.includes('--acp'));assert(args.includes('127.0.0.1'));const env=vendors.environment({engine:'workbuddy'},{});assert.equal(env.SERVER__HOST,'127.0.0.1');assert.equal(env.DISABLE_GALILEO,'1');assert(!env.CODEBUDDY_GATEWAY_PASSWORD);
});
test('ACP decodes split UTF-8 events and rejects unsupported project MCP transports',async t=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();const state={text:''},acp=new AcpClient(child,state,()=>{},{});t.after(()=>acp.close());
  const bytes=Buffer.from(JSON.stringify({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello \u732b'}}}})+'\n');
  for(const byte of bytes)acp.consume(Buffer.from([byte]));assert.equal(state.text,'Hello \u732b');acp.capabilities={};await assert.rejects(acp.session(process.cwd(),{http:{url:'https://example.test'}}),/cannot load/);
});
test('New native engines validate local account use, preserve permissions, and do not invent effort flags',t=>{
  const directory=fixture(t),store=new Store(directory,directory),base=store.state.roles[0];
  for(const engine of Object.keys(vendors.catalog)){
    const role=store.saveRole({...base,id:undefined,engine,model:'fixture-model',effort:'high',permission:'danger-full-access',codexLoginSource:'isolated'});
    assert.equal(store.saveRole({...role,permission:undefined}).permission,'danger-full-access');
    assert.equal(role.effort,['kimi','cursor'].includes(engine)?'':'high');
    const args=vendors.args(role);if(engine!=='antigravity')assert(args.includes('fixture-model'));assert(!args.includes('--api-key'));
    assert.equal(args.includes('--effort'),vendors.catalog[engine].effort&&engine!=='antigravity');
    assert.throws(()=>store.saveRole({...role,provider:'openai'}),/Codex adapter/);
  }
  const moonshot=store.saveRole({...base,provider:'moonshot'});assert.equal(moonshot.provider,'moonshot');
});
test('Native runtime discovery rejects GUI launchers and shell shims and finds bundled WorkBuddy',t=>{
  const directory=fixture(t),desktop=path.join(directory,'Programs','Cursor');fs.mkdirSync(path.join(desktop,'resources'),{recursive:true});const gui=path.join(desktop,'Cursor.exe');fs.writeFileSync(gui,'fixture');fs.writeFileSync(path.join(desktop,'resources/app.asar'),'fixture');
  assert(!vendors.validEntry(gui));assert.throws(()=>vendors.find({engine:'cursor',executable:gui}),/runtime/);
  const shim=path.join(directory,'agent.cmd');fs.writeFileSync(shim,'fixture');assert(!vendors.validEntry(shim));
  const bundled=path.join(directory,'WorkBuddyAI/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs');fs.mkdirSync(path.dirname(bundled),{recursive:true});fs.writeFileSync(bundled,'fixture');assert.equal(vendors.find({engine:'workbuddy'},{local:'',home:directory,programFiles:directory,searchPath:''}),bundled);
  const launch=vendors.launch(entry,['acp'],{});assert.equal(launch.command,process.execPath);assert.equal(launch.env.ELECTRON_RUN_AS_NODE,'1');assert.deepEqual(launch.args,[entry,'acp']);
  const original=process.env.KIMI_CODE_HOME;process.env.KIMI_CODE_HOME=path.join(directory,'account-home');try{const env=vendors.environment({engine:'kimi'},cleanEnv(directory));assert.equal(env.KIMI_CODE_HOME,process.env.KIMI_CODE_HOME);assert(!fs.existsSync(env.KIMI_CODE_HOME));}finally{if(original===undefined)delete process.env.KIMI_CODE_HOME;else process.env.KIMI_CODE_HOME=original;}
});
test('Each native adapter completes a fixture job and model metadata uses ACP without a prompt',async t=>{
  const directory=fixture(t),store=new Store(directory,directory),project=store.state.projects[0],agents=new Agents(store,{get:()=>''},{},()=>{});t.after(()=>agents.close());
  for(const engine of Object.keys(vendors.catalog)){
    const role=store.saveRole({...store.state.roles[0],id:undefined,engine,provider:'native',executable:entry,model:'fixture-model',permission:'read-only',allowLocationTools:false,codexLoginSource:'isolated'});
    const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'Fixture request',status:'accepted'});
    const result=await agents.run(chat.id,role,project,new AbortController().signal);assert.equal(result.status,'complete',result.note);assert(result.text.startsWith('ACP_FIXTURE_COMPLETE'));assert.equal(result.agentSessionId,'fixture-session');
    const models=await queryCli(role,directory,directory,vendors.environment(role,cleanEnv(directory)));assert.deepEqual(models,engine==='antigravity'?[{id:'fixture-model',label:'Fixture model'}]:[{id:'fixture-model',label:'Fixture model',description:undefined}]);
  }
});
test('Antigravity uses explicit ACP model/effort/mode settings and rejects unavailable selections',async t=>{
  const {acp}=client(t);acp.role={engine:'antigravity',model:'fixture-model',effort:'high',permission:'read-only'};await acp.initialize();const session=await acp.session(process.cwd(),{});const calls=[],call=acp.call.bind(acp);acp.call=(method,params,...rest)=>{calls.push({method,params});return call(method,params,...rest);};await acp.configure(session);assert.deepEqual(calls.map(x=>[x.method,x.params.configId||x.params.modeId,x.params.value]),[['session/set_config_option','model','fixture-model'],['session/set_config_option','thought_level','high'],['session/set_mode','plan',undefined]]);
  acp.role.model='unavailable-model';await assert.rejects(acp.configure(session),/did not offer/);acp.role.model='';acp.role.effort='xhigh';await assert.rejects(acp.configure(session),/does not offer/);acp.role.effort='';await assert.rejects(acp.configure({}),/cannot enforce/);
  const args=vendors.args({engine:'antigravity',permission:'workspace-write'});assert(args.includes('--process-per-session'));assert(!args.includes('--dangerously-skip-permissions'));assert(!args.some(x=>/override.*agent|user.agent/i.test(x)));assert(vendors.args({engine:'antigravity',permission:'danger-full-access'}).includes('--dangerously-skip-permissions'));
});
test('Antigravity installer rejects unexpected releases or download origins',()=>{
  const {validateManifest}=require('../workbench/antigravity.cjs'),valid={version:'1.2.3',sha512:'a'.repeat(128),url:'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.3/windows-x64/cli.exe'};
  assert.deepEqual(validateManifest(valid),valid);for(const value of [{...valid,version:'latest'},{...valid,sha512:'missing'},{...valid,url:'https://example.test/cli.exe'},{...valid,url:'https://storage.googleapis.com/unrelated/cli.exe'}])assert.throws(()=>validateManifest(value),/manifest|origin/);
});
test('Saved group order survives reload and does not leak to another chat',t=>{
  const directory=fixture(t),store=new Store(directory,directory),project=store.state.projects[0],ids=store.state.roles.map(r=>r.id),chat=store.createChat({projectId:project.id,roleIds:ids}),other=store.createChat({projectId:project.id,roleIds:ids});
  const order=[...ids].reverse();store.saveChat({id:chat.id,roleIds:order,name:'Ordered group'});const loaded=new Store(directory,directory);assert.deepEqual(loaded.get('chats',chat.id).roleIds,order);assert.deepEqual(loaded.get('chats',other.id).roleIds,ids);
});
