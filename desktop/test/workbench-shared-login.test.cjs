const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Store}=require('../workbench/store.cjs');
const {Agents}=require('../workbench/agents.cjs');
const {startBridge}=require('../workbench/api/bridge.cjs');
const {usesDesktopLogin,usesDesktopTools,sharedTaskArgs}=require('../workbench/desktop-login.cjs');
const {effectiveRole}=require('../workbench/conversations.cjs');

function fixture(t) {
  const directory=fs.mkdtempSync(path.resolve(__dirname,'../../.runtime/shared-login-test-'));
  t.after(()=>{try{fs.rmSync(directory,{recursive:true,force:true});}catch{}});
  const store=new Store(path.join(directory,'workbench'),directory);
  const desktop=path.join(directory,'desktop');fs.mkdirSync(desktop);
  const agents=new Agents(store,{get:()=>''},{},()=>{},{desktopCodexHome:()=>desktop});t.after(()=>agents.close());
  return {directory,store,desktop,agents,project:store.state.projects[0]};
}
test('Desktop login is opt-in, persists, and is limited to local native Codex roles',t=>{
  const {directory,store}=fixture(t),original=store.state.roles[0];
  assert(!usesDesktopLogin(original));
  const shared=store.saveRole({...original,codexLoginSource:'desktop'});assert(usesDesktopLogin(shared));
  const reloaded=new Store(store.directory,directory);assert.equal(reloaded.get('roles',shared.id).codexLoginSource,'desktop');
  assert.throws(()=>store.saveRole({...shared,provider:'gemini'}),/local native Codex/);
  assert.throws(()=>store.saveRole({...shared,codexLoginSource:'invalid'}),/local native Codex/);
  assert.throws(()=>store.saveRole({...shared,engine:'claude'}),/local native Codex/);
  assert.equal(store.saveRole({...shared,codexLoginSource:'isolated'}).codexLoginSource,'isolated');
});
test('Desktop tool inheritance defaults on for participants and moderators and can be disabled per role',async t=>{
  const {store,directory}=fixture(t),role=store.saveRole({...store.state.roles[0],codexLoginSource:'desktop'});
  assert.equal(role.codexDesktopTools,true);assert(usesDesktopTools(role));assert(usesDesktopTools({...role,moderatorTask:true}));
  const inherited=await sharedTaskArgs('unused-executable',{},directory);assert(!inherited.some(value=>/mcp_servers=|features\.(?:remote_)?plugins=false/.test(value)));assert(inherited.includes('features.hooks=false'));
  const isolated=store.saveRole({...role,codexDesktopTools:false});assert.equal(usesDesktopTools(isolated),false);assert.equal(usesDesktopTools({...isolated,moderatorTask:true}),false);
  assert.equal(new Store(store.directory,directory).get('roles',role.id).codexDesktopTools,false);
  assert.throws(()=>store.saveRole({...isolated,codexDesktopTools:'false'}),/inherit desktop/);assert.equal(store.get('roles',role.id).codexDesktopTools,false);
});
test('Only opted-in Codex roles share the home; private agent folders and API roles remain separate',t=>{
  const {store,desktop,agents}=fixture(t);
  const shared=store.saveRole({...store.state.roles[0],codexLoginSource:'desktop'});
  const own=store.saveRole({...shared,id:undefined,name:'Separate',codexLoginSource:'isolated'});
  const api=store.saveRole({...shared,id:undefined,name:'API',provider:'gemini',codexLoginSource:'isolated'});
  const sharedEnv=agents.environment(shared),ownEnv=agents.environment(own),apiEnv=agents.environment(api);
  assert.equal(sharedEnv.CODEX_HOME,desktop);assert.notEqual(ownEnv.CODEX_HOME,desktop);assert.notEqual(apiEnv.CODEX_HOME,desktop);
  assert(sharedEnv.CLAUDE_CONFIG_DIR.startsWith(agents.home(shared)));
  assert(!fs.existsSync(path.join(agents.home(shared),'codex','auth.json')));
  assert(!usesDesktopLogin({...shared,locationId:'remote'}));
});

test('A logged-out desktop source does not fall back to a role private account', {timeout:15000},async t=>{
  const {store,agents,project}=fixture(t);
  const role=store.saveRole({...store.state.roles[0],codexLoginSource:'desktop',model:'fixture-model',allowLocationTools:false});
  const privateHome=path.join(agents.home(role),'codex');fs.mkdirSync(privateHome);
  const privateAuth=JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'private-fixture-key'});fs.writeFileSync(path.join(privateHome,'auth.json'),privateAuth);
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'Retain task while the shared source is logged out.',status:'accepted'});
  const result=await agents.run(chat.id,role,project,new AbortController().signal);
  assert.equal(result.errorCode,'CODEX_DESKTOP_LOGIN_REQUIRED');assert.equal(result.status,'failed');
  assert.equal(fs.readFileSync(path.join(privateHome,'auth.json'),'utf8'),privateAuth);
});

test('Shared login refuses an unresolved model before using any desktop default',async t=>{
  const {store,agents,project,desktop}=fixture(t);
  fs.writeFileSync(path.join(desktop,'config.toml'),'model="desktop-default-model"\n');
  const role=store.saveRole({...store.state.roles[0],codexLoginSource:'desktop',model:'',allowLocationTools:false});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'Retain this task until a model is chosen.',status:'accepted'});
  const result=await agents.run(chat.id,effectiveRole(chat,role),project,new AbortController().signal);
  assert.equal(result.errorCode,'CODEX_MODEL_REQUIRED');assert.equal(result.status,'failed');assert(!result.note.includes('Agent exited'));
  assert.equal(chat.messages[0].text,'Retain this task until a model is chosen.');
});

test('An explicit inheritance opt-out excludes desktop tools and hooks while retaining project tools', {timeout:60000},async t=>{
  const {directory,store,desktop,agents,project}=fixture(t);
  store.state.locations.push({id:'fixture-ssh',name:'Fixture SSH',type:'ssh',control:'ssh',os:'linux'});
  project.directories.push({locationId:'fixture-ssh',path:'/tmp/fixture'});
  let requests=0;
  const gateway=await startBridge({settings:{mode:'chat',baseUrl:'https://fixture.invalid',label:'Fixture'},apiKey:'fixture-upstream',upstreamFetch:async(_url,options)=>{
    const body=JSON.parse(options.body);requests++;
    assert.equal(body.model,'fixture-model');
    const names=(body.tools||[]).map(tool=>tool.function.name);
    assert(names.some(name=>/relay_session_[a-f0-9]{16}_/.test(name)),'Project tools must keep their session namespace after desktop MCP exclusion.');
    assert(!names.some(name=>name.includes('desktop_only')));
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'SHARED_LOGIN_OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  }});t.after(()=>gateway.close());
  const trap=path.join(directory,'trap.cjs'),marker=path.join(directory,'unexpected-desktop-action');
  fs.writeFileSync(trap,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"unexpected");');
  const q=JSON.stringify;
  const config='model="desktop-default-model"\nweb_search="disabled"\nnotify=['+q(process.execPath)+','+q(trap)+']\n[features]\nhooks=true\n[mcp_servers.desktop_only]\ncommand='+q(process.execPath)+'\nargs=['+q(trap)+']\nenabled=true\n[plugins."fixture@local"]\nenabled=true\n';
  fs.writeFileSync(path.join(desktop,'config.toml'),config);
  const auth=JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:gateway.token});fs.writeFileSync(path.join(desktop,'auth.json'),auth);
  fs.writeFileSync(path.join(desktop,'hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:q(process.execPath)+' '+q(trap)}]}]}}));
  const role=store.saveRole({...store.state.roles[0],codexLoginSource:'desktop',codexDesktopTools:false,model:'fixture-model',effort:'high',permission:'read-only'});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.saveChatRole(chat.id,role.id,{model:'',effort:''});store.message(chat.id,{kind:'user',text:'Check shared authentication using the fixture service.',status:'accepted'});
  const prepare=agents.prepareLocal.bind(agents);
  agents.prepareLocal=async(...args)=>{
    const prepared=await prepare(...args);assert.equal(prepared.env.CODEX_HOME,desktop);
    assert(prepared.extra.some(value=>value.includes('desktop_only')&&value.includes('enabled=false')));
    prepared.extra.push('-c','model_providers.relay_native_http.base_url='+q(gateway.url));return prepared;
  };
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
  try {
    const selected=effectiveRole(chat,role);assert.equal(selected.model,'fixture-model');assert.equal(selected.effort,'high');
    const result=await agents.run(chat.id,selected,project,controller.signal);
    assert.equal(result.status,'complete',result.note);assert(result.text.includes('SHARED_LOGIN_OK'));assert(requests>0);
    assert(!fs.existsSync(marker),'Desktop MCP, notify and hooks must not run.');
    assert.equal(fs.readFileSync(path.join(desktop,'auth.json'),'utf8'),auth);
    assert.equal(fs.readFileSync(path.join(desktop,'config.toml'),'utf8'),config);
    assert(!fs.existsSync(path.join(agents.home(role),'codex','auth.json')));
    assert(!result.terminal.includes('responses_websocket'));
    assert(result.terminal.includes('[Requested model] fixture-model'));assert.equal(result.model,'fixture-model');assert.equal(result.effort,'high');
  } finally {clearTimeout(timer);}
});
test('Real Codex inherits enabled desktop MCP, honors disabled entries, and reloads tools on the same session', {timeout:90000},async t=>{
  const {directory,store,desktop,agents,project}=fixture(t),q=JSON.stringify;
  store.state.locations.push({id:'fixture-ssh',name:'Fixture SSH',type:'ssh',control:'ssh',os:'linux'});project.directories.push({locationId:'fixture-ssh',path:'/tmp/fixture'});
  const called=path.join(directory,'desktop-tool-called'),unexpected=path.join(directory,'unexpected-action'),trap=path.join(directory,'trap.cjs');
  fs.writeFileSync(trap,'require("node:fs").writeFileSync('+q(unexpected)+',"unexpected");');
  let inherit=true,returned=false;const catalogs=[];
  const gateway=await startBridge({settings:{mode:'chat',baseUrl:'https://fixture.invalid',label:'Fixture'},apiKey:'fixture-upstream',upstreamFetch:async(_url,options)=>{
    const body=JSON.parse(options.body),names=(body.tools||[]).map(tool=>tool.function.name);catalogs.push({inherit,names});
    assert(names.some(name=>/relay_session_[a-f0-9]{16}_/.test(name)));assert(!names.some(name=>name.includes('desktop_disabled')));
    const tool=(body.tools||[]).find(tool=>tool.function.name.includes('desktop_enabled')&&tool.function.name.endsWith('desktop_echo'));
    assert.equal(Boolean(tool),inherit);const hasResult=body.messages.some(message=>message.role==='tool'&&message.tool_call_id==='desktop_fixture_call');returned||=hasResult;
    const delta=inherit&&!hasResult?{tool_calls:[{index:0,id:'desktop_fixture_call',type:'function',function:{name:tool.function.name,arguments:JSON.stringify({text:'DESKTOP_MCP_FIXTURE'})}}]}:{content:inherit?'DESKTOP_INHERIT_OK':'DESKTOP_OPT_OUT_OK'};
    return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:inherit&&!hasResult?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  }});t.after(()=>gateway.close());
  const config='model="desktop-default-model"\nweb_search="disabled"\nnotify=['+q(process.execPath)+','+q(trap)+']\n[features]\nhooks=true\nplugins=false\nremote_plugin=false\n[mcp_servers.desktop_enabled]\ncommand='+q(process.execPath)+'\nargs=['+q(path.join(__dirname,'fixtures/desktop-mcp.cjs'))+']\nenabled=true\ndefault_tools_approval_mode="approve"\n[mcp_servers.desktop_enabled.env]\nFIXTURE_CALL_MARKER='+q(called)+'\n[mcp_servers.desktop_disabled]\ncommand='+q(process.execPath)+'\nargs=['+q(trap)+']\nenabled=false\n';
  fs.writeFileSync(path.join(desktop,'config.toml'),config);const auth=JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:gateway.token});fs.writeFileSync(path.join(desktop,'auth.json'),auth);
  fs.writeFileSync(path.join(desktop,'hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:q(process.execPath)+' '+q(trap)}]}]}}));
  let role=store.saveRole({...store.state.roles[0],codexLoginSource:'desktop',model:'fixture-model',permission:'read-only'});const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  const prepare=agents.prepareLocal.bind(agents);agents.prepareLocal=async(...args)=>{const prepared=await prepare(...args);if(args[0].codexDesktopTools!==false){assert.equal(prepared.desktopToolPolicy,'inherit');assert(!prepared.extra.some(value=>value.includes('desktop_enabled')&&value.includes('enabled=false')));assert(!prepared.extra.includes('features.plugins=false'));}prepared.extra.push('-c','model_providers.relay_native_http.base_url='+q(gateway.url));return prepared;};
  store.message(chat.id,{kind:'user',text:'Call the inherited desktop fixture tool once.',status:'accepted'});const first=await agents.run(chat.id,role,project,AbortSignal.timeout(45000));assert.equal(first.status,'complete',first.note);assert(first.text.includes('DESKTOP_INHERIT_OK'));assert(returned);assert(fs.existsSync(called));assert(!fs.existsSync(unexpected));assert.equal(first.desktopToolPolicy,'inherit');
  const sharedSession=first.agentSessionId;inherit=false;role=store.saveRole({...role,codexDesktopTools:false});store.message(chat.id,{kind:'user',text:'Answer after desktop tool inheritance is disabled.',status:'accepted'});
  const second=await agents.run(chat.id,role,project,AbortSignal.timeout(45000));assert.equal(second.status,'complete',second.note);assert(second.text.includes('DESKTOP_OPT_OUT_OK'));assert.equal(second.agentSessionId,sharedSession);assert.equal(second.desktopToolPolicy,'isolated');assert(catalogs.some(c=>c.inherit)&&catalogs.some(c=>!c.inherit));
  inherit=true;role=store.saveRole({...role,codexDesktopTools:true});store.message(chat.id,{kind:'user',text:'Restore inherited desktop tools on the existing session.',status:'accepted'});
  const third=await agents.run(chat.id,role,project,AbortSignal.timeout(45000));assert.equal(third.status,'complete',third.note);assert.equal(third.agentSessionId,sharedSession);assert.equal(third.desktopToolPolicy,'inherit');assert(third.text.includes('DESKTOP_INHERIT_OK'));
  const moderator=await prepare({...role,codexDesktopTools:true,moderatorTask:true,permission:'read-only',allowLocationTools:false},directory,project);assert.equal(moderator.desktopToolPolicy,'inherit');assert(!moderator.extra.includes('features.plugins=false'));moderator.tools?.close();
  assert.equal(fs.readFileSync(path.join(desktop,'auth.json'),'utf8'),auth);assert.equal(fs.readFileSync(path.join(desktop,'config.toml'),'utf8'),config);assert(!fs.existsSync(unexpected));
});
