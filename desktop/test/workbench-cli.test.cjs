const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Store}=require('../workbench/store.cjs');
const {Agents}=require('../workbench/agents.cjs');
const {startBridge}=require('../workbench/api/bridge.cjs');
test('Real Codex CLI completes a tool round trip through the isolated role adapter', {timeout:60000},async()=>{
  const directory=fs.mkdtempSync(path.resolve(__dirname,'../../.runtime/workbench-cli-test-'));
  const store=new Store(directory,directory);const project=store.state.projects[0];project.directories=[{locationId:'local',path:directory},{locationId:'fixture-ssh',path:'/tmp/fixture'}];
  store.state.locations.push({id:'fixture-ssh',name:'Fixture SSH',type:'ssh',control:'ssh',os:'linux'});
  const role=store.saveRole({...store.state.roles[0],provider:'gemini',model:'fixture-model',baseUrl:'https://fixture.invalid',permission:'read-only'});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'Run the harmless protocol check.',status:'accepted'});
  let requests=0;let toolReturned=false;let sshCalled=false;
  const upstreamFetch=async(_url,init)=>{
    const body=JSON.parse(init.body);requests++;assert(requests<=8);
    const tool=(body.tools||[]).find(t=>t.function.name.endsWith('ssh_exec'));
    assert(tool,'Project SSH MCP tool must be present in the real CLI catalog.');
    const returned=body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='fixture_call');toolReturned ||= returned;
    const delta=!returned&&tool ? {tool_calls:[{index:0,id:'fixture_call',type:'function',function:{name:tool.function.name,arguments:JSON.stringify({locationId:'fixture-ssh',command:'printf RELAY_WORKBENCH_OK'})}}]} : {content:'RELAY_PROTOCOL_COMPLETE'};
    return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:!returned&&tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  };
  const agents=new Agents(store,{get:()=> 'fixture-only'},{exec:async(id,command)=>{assert.equal(id,'fixture-ssh');assert(command.includes('RELAY_WORKBENCH_OK'));sshCalled=true;return 'SSH_TOOL_FIXTURE_OK';}},()=>{},{fetch:upstreamFetch});
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
  try { const result=await agents.run(chat.id,role,project,controller.signal);assert.equal(result.status,'complete',JSON.stringify({note:result.note,tail:result.terminal?.slice(-2200),requests,toolReturned,sshCalled}));assert(result.text.includes('RELAY_PROTOCOL_COMPLETE'));assert(toolReturned);assert(sshCalled);assert(requests>=2);assert(!JSON.stringify(store.snapshot()).includes('fixture-only')); }
  finally {clearTimeout(timer);agents.close();try{fs.rmSync(directory,{recursive:true,force:true});}catch{}}
});
test('Native Codex uses HTTP streaming without a WebSocket connection', {timeout:60000},async()=>{
  const directory=fs.mkdtempSync(path.resolve(__dirname,'../../.runtime/native-http-test-'));
  const store=new Store(directory,directory);const project=store.state.projects[0];
  const role=store.saveRole({...store.state.roles[0],provider:'native',model:'fixture-model',permission:'read-only',allowLocationTools:false});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'Run the local HTTP transport fixture.',status:'accepted'});
  let requests=0;
  const gateway=await startBridge({settings:{mode:'chat',baseUrl:'https://fixture.invalid',label:'Fixture'},apiKey:'fixture-key',upstreamFetch:async()=>{
    requests++;return new Response('data: '+JSON.stringify({choices:[{delta:{content:'NATIVE_HTTP_OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  }});
  const agents=new Agents(store,{get:()=>''},{},()=>{});
  const authHome=path.join(agents.home(role),'codex');fs.mkdirSync(authHome,{recursive:true});
  fs.writeFileSync(path.join(authHome,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:gateway.token}));
  const prepare=agents.prepareLocal.bind(agents);
  agents.prepareLocal=async(...args)=>{
    const result=await prepare(...args);
    result.extra.push('-c','model_providers.relay_native_http.base_url='+JSON.stringify(gateway.url),'-c','cli_auth_credentials_store="file"','-c','web_search="disabled"','-c','features.plugins=false','-c','features.remote_plugin=false');
    return result;
  };
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
  try {const result=await agents.run(chat.id,role,project,controller.signal);assert.equal(result.status,'complete',result.note);assert(result.text.includes('NATIVE_HTTP_OK'));assert(requests>0);assert(!result.terminal.includes('responses_websocket'));}
  finally{clearTimeout(timer);agents.close();gateway.close();try{fs.rmSync(directory,{recursive:true,force:true});}catch{}}
});

test('An unsigned native role is stopped before inference and retains the submitted task', {timeout:20000}, async()=>{
  const directory=fs.mkdtempSync(path.resolve(__dirname,'../../.runtime/native-login-test-'));
  const store=new Store(directory,directory),project=store.state.projects[0];
  const role=store.saveRole({...store.state.roles[0],provider:'native',model:'fixture-model',permission:'read-only',allowLocationTools:false});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  store.message(chat.id,{kind:'user',text:'Keep this task for retry after login.',status:'accepted'});
  const agents=new Agents(store,{get:()=>''},{},()=>{});
  try {
    const result=await agents.run(chat.id,role,project,new AbortController().signal);
    assert.equal(result.status,'failed');assert.equal(result.errorCode,'CODEX_LOGIN_REQUIRED');
    assert(!result.note.includes('401'));assert(!result.note.includes('api.openai.com'));
    assert.equal(chat.messages[0].text,'Keep this task for retry after login.');
    assert(!fs.existsSync(path.join(agents.home(role),'codex','auth.json')));
  } finally {agents.close();try{fs.rmSync(directory,{recursive:true,force:true});}catch{}}
});
