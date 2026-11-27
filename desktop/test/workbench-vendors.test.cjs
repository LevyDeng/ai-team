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
const generatedWorkflow=require('../workbench/generated-workflow.cjs');
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
    if (engine === 'custom-acp' || !vendors.usesAcp(engine)) continue;
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
test('DeepSeek Harness launches with standalone Node.js and does not inherit Electron RunAsNode', () => {
  const entry=path.join(__dirname,'node_modules','@deepseek-ai','dsh','lib','bin.js');
  const launch=vendors.launch(entry,['--profile','acp'],{ELECTRON_RUN_AS_NODE:'1',FIXTURE:'value'});
  assert.match(path.basename(launch.command),/^node(?:\.exe)?$/i);
  assert.deepEqual(launch.args,[entry,'--profile','acp']);
  assert.deepEqual(launch.env,{FIXTURE:'value'});
});
test('Built-in ACP adapters complete fixture jobs and query models without a prompt',async t=>{
  const directory=fixture(t),store=new Store(directory,directory),project=store.state.projects[0],agents=new Agents(store,{get:()=>''},{},()=>{});t.after(()=>agents.close());
  for(const engine of Object.keys(vendors.catalog)){
    if (engine === 'custom-acp' || !vendors.usesAcp(engine)) continue;
    const role=store.saveRole({...store.state.roles[0],id:undefined,engine,provider:'native',executable:entry,model:'fixture-model',permission:'read-only',allowLocationTools:false,codexLoginSource:'isolated'});
    const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'Fixture request',status:'accepted'});
    const result=await agents.run(chat.id,role,project,new AbortController().signal);assert.equal(result.status,'complete',result.note);assert(result.text.startsWith('ACP_FIXTURE_COMPLETE'));assert.equal(result.agentSessionId,'fixture-session');
    const models=await queryCli(role,directory,directory,vendors.environment(role,cleanEnv(directory)));
    if(engine==='cursor'){
      assert.deepEqual(models.find(model=>model.id==='grok-4.7')?.parameters,[
        {id:'reasoning_effort',category:'thought_level',defaultValue:'high',values:['low','medium','high','xhigh']},
      ]);
    }else assert.deepEqual(models,engine==='antigravity'?[{id:'fixture-model',label:'Fixture model'}]:[{id:'fixture-model',label:'Fixture model',description:undefined}]);
  }
});
test('ZCode runs through the CLI, streams a reply and resumes the same session',async t=>{
  const directory=fixture(t),store=new Store(directory,directory),project=store.state.projects[0];
  const executable=path.join(directory,'zcode-fixture.cjs');
  fs.writeFileSync(executable, `
    const assert=require('node:assert/strict');
    const args=process.argv.slice(2);
    assert.equal(args[args.indexOf('--mode')+1],'edit');
    assert.equal(args[args.indexOf('--output-format')+1],'stream-json');
    assert.ok(args[args.indexOf('--prompt')+1].includes('Fixture request'));
    assert.ok(!args.includes('--acp')&&!args.includes('--model'));
    const response=args.includes('--resume')?'Resumed':'First reply';
    if(args.includes('--resume')) assert.equal(args[args.indexOf('--resume')+1],'sess_fixture');
    console.log(JSON.stringify({type:'model.streaming',payload:{kind:'text_delta',delta:response}}));
    console.log(JSON.stringify({type:'result',sessionId:'sess_fixture',response}));
  `);
  const role=store.saveRole({name:'ZCode fixture',engine:'zcode',provider:'native',locationId:'local',
    executable,model:'ignored',effort:'high',permission:'workspace-write'});
  assert.equal(role.model,'');assert.equal(role.effort,'');assert.equal(role.allowLocationTools,false);
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  const agents=new Agents(store,{get:()=>''},{},()=>{});t.after(()=>agents.close());
  for (const text of ['First reply','Resumed']) {
    store.message(chat.id,{kind:'user',text:'Fixture request',status:'accepted'});
    const reply=await agents.run(chat.id,role,project,AbortSignal.timeout(10000));
    assert.equal(reply.status,'complete',reply.note);
    assert.equal(reply.text,text);
    assert.equal(reply.agentSessionId,'sess_fixture');
  }
});
test('Custom ACP persists its argv and environment and runs through the workflow agent path',async t=>{
  const directory=fixture(t),store=new Store(directory,directory),project=store.state.projects[0];
  const role=store.saveRole({...store.state.roles[0],engine:'custom-acp',executable:entry,model:'fixture-model',
    acpArgs:['--no-http','argument with spaces'],acpEnv:{FIXTURE_CONFIG:directory},allowLocationTools:false});
  const saved=new Store(directory,directory).get('roles',role.id);
  assert.deepEqual(vendors.args(saved),['--no-http','argument with spaces']);
  assert.deepEqual(vendors.customEnvironment(saved).env,{FIXTURE_CONFIG:directory});
  assert.throws(()=>store.saveRole({...saved,acpArgs:[true]}),/JSON/);
  assert.throws(()=>store.saveRole({...saved,acpEnv:['value']}),/JSON/);
  const models=await queryCli(saved,directory,directory);
  assert.deepEqual(models,[{id:'fixture-model',label:'Fixture model'}]);
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  const agents=new Agents(store,{get:()=>''},{},()=>{});
  t.after(()=>agents.close());
  store.message(chat.id,{kind:'user',text:'Fixture request',status:'accepted'});
  const result=await agents.run(chat.id,role,project,new AbortController().signal,false,{workflowAttemptId:'custom-acp-attempt'});
  assert.equal(result.status,'complete',result.note);
  assert(result.text.startsWith('ACP_FIXTURE_COMPLETE'));
  assert.equal(result.workflowSubmitted,true);
});
test('Custom ACP skips unsupported HTTP MCP, applies a manual model and requires an advertised read-only mode',async t=>{
  const {acp,state}=client(t);
  acp.role={engine:'custom-acp',model:'manual-model',permission:'workspace-write'};
  acp.capabilities={};
  const calls=[];
  acp.call=async (method,params)=>{
    calls.push([method,params]);
    return method==='session/new'?{sessionId:'fixture-session'}:{};
  };
  const session=await acp.session(process.cwd(),{fixture:{command:'node'},unavailable:{url:'https://example.test/mcp'}});
  assert.deepEqual(calls[0][1].mcpServers,[{name:'fixture',command:'node',args:[],env:[]}]);
  assert.match(state.note,/HTTP MCP.*unavailable/);
  await acp.configure(session);
  assert.deepEqual(calls[1],['session/set_model',{sessionId:'fixture-session',modelId:'manual-model'}]);
  acp.role={engine:'custom-acp',permission:'read-only'};
  await assert.rejects(acp.configure(session),/ACP/);
});
test('Stopping a custom ACP workflow notifies its native session before stopping the adapter', {timeout:5000}, async t=>{
  const directory=fixture(t),store=new Store(directory,directory),project=store.state.projects[0];
  const role=store.saveRole({...store.state.roles[0],engine:'custom-acp',executable:entry,allowLocationTools:false});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  const controller=new AbortController();
  const agents=new Agents(store,{get:()=>''},{},({message})=>{
    if(message.status==='running' && message.text==='Waiting for cancellation')controller.abort();
  });
  t.after(()=>agents.close());
  store.message(chat.id,{kind:'user',text:'CUSTOM_CANCEL_FIXTURE',status:'accepted'});
  const result=await agents.run(chat.id,role,project,controller.signal,false,{workflowAttemptId:'custom-cancel'});
  assert.equal(result.status,'cancelled');
  assert.equal(result.text,'Waiting for cancellation Cancel notification received');
});
test('Cursor applies the saved model parameter through ACP and reports the confirmed value',async t=>{
  const {acp,state}=client(t);
  acp.role={engine:'cursor',model:'grok-4.7[reasoning_effort=low]'};
  await acp.initialize();
  const session=await acp.session(process.cwd(),{});
  await acp.configure(session);
  assert.equal(state.actualModel,'grok-4.7');
  assert.match(state.terminal,/Cursor confirmed session model\] grok-4\.7\[reasoning_effort=low\]/);
  acp.role.model='grok-4.7[reasoning_effort=invalid]';
  await assert.rejects(acp.configure(session),/invalid/);
});
test('Cursor ask mode starts with the base model ID and leaves parameters to ACP',()=>{
  const model='grok-4.7[context=256k,fast=true]';
  assert.deepEqual(vendors.args({engine:'cursor',model,permission:'read-only'}),['--model','grok-4.7','--mode','ask','acp']);
  assert.deepEqual(vendors.args({engine:'cursor',model,permission:'workspace-write'}),['--model',model,'acp']);
});
test('Antigravity workflow waits for every finite background command and verifies in the same session', {timeout:10000}, async t=>{
  const directory=fixture(t);
  const store=new Store(directory,directory);
  const project=store.state.projects[0];
  const role=store.saveRole({...store.state.roles[0],engine:'antigravity',provider:'native',executable:entry,model:'fixture-model',permission:'workspace-write',allowLocationTools:false});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  const activities=[];
  const agents=new Agents(store,{get:()=>''},{},({message})=>activities.push(message.activity));
  t.after(()=>agents.close());
  chat.workflow=generatedWorkflow.configure({title:'Build',goal:'Build the fixture',nodes:[
    {title:'Build and verify',instruction:'ASYNC_COMMAND_FIXTURE',domain:'Code',duty:'Implementation',mode:'ordered',roleIds:[role.id]},
  ]},[role]);
  await generatedWorkflow.run(chat,{signal:new AbortController().signal,save(){},roles:()=>[role],
    turn(attempt,prompt,signal){
      store.message(chat.id,{kind:'user',text:prompt,status:'accepted',workflowAttemptId:attempt.id});
      return agents.run(chat.id,role,project,signal,false,{workflowAttemptId:attempt.id});
    },
  });
  assert.equal(chat.workflow.status,'complete',chat.workflow.reason);
  assert.equal(chat.workflow.attempts.length,1);
  const result=chat.messages.find(message=>message.kind==='assistant');
  assert.equal(result.agentSessionId,'fixture-session');
  assert.equal(result.text,'Still building\n\nVerified background results\nWORKFLOW: DONE');
  assert.ok(activities.includes('Waiting for background commands'));
});
test('Antigravity workflow can be stopped while waiting for background commands', {timeout:10000}, async t=>{
  const directory=fixture(t);
  const store=new Store(directory,directory);
  const project=store.state.projects[0];
  const role=store.saveRole({...store.state.roles[0],engine:'antigravity',provider:'native',executable:entry,model:'fixture-model',permission:'workspace-write',allowLocationTools:false});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  const controller=new AbortController();
  const agents=new Agents(store,{get:()=>''},{},({message})=>{
    if(message.status==='running' && message.activity==='Waiting for background commands')controller.abort();
  });
  t.after(()=>agents.close());
  store.message(chat.id,{kind:'user',text:'ASYNC_COMMAND_FIXTURE NEVER_EXIT',status:'accepted'});
  const result=await agents.run(chat.id,role,project,controller.signal,false,{workflowAttemptId:'fixture-attempt'});
  assert.equal(result.status,'cancelled');
  assert.equal(result.stopConfirmed,true);
  assert.equal(result.text,'Still building');
  assert.equal(agents.jobs.size,0);
});
test('Antigravity chat ends on the first response even while a command is active', {timeout:5000}, async t=>{
  const {acp,state}=client(t);
  acp.role.engine='antigravity';
  await acp.initialize();
  await acp.session(process.cwd(),{});
  await acp.prompt('ASYNC_COMMAND_FIXTURE NEVER_EXIT');
  assert.equal(state.text,'Still building');
  assert(state.completed);
  assert.equal(state.activity,undefined);
});
test('Antigravity reports missing command exit results at the background wait deadline', async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=new EventEmitter();
  child.stdout=new PassThrough();
  child.stdin=new PassThrough();
  const acp=new AcpClient(child,{text:''},()=>{},{engine:'antigravity'});
  t.after(()=>acp.close());
  acp.backgroundCommands=new Set(['pending-command']);
  const waiting=acp.waitForBackgroundCommands(new AbortController().signal);
  t.mock.timers.tick(30 * 60 * 1000);
  await assert.rejects(waiting,error=>error.code==='AGY_BACKGROUND_TIMEOUT');
  assert.equal(acp.backgroundWaiter,null);
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
