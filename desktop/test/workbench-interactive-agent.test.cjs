const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {Store}=require('../workbench/store.cjs');
const {InteractiveAgents,interactiveArgs}=require('../workbench/interactive-agent.cjs');
const nativeSessions=require('../workbench/native-sessions.cjs');

function fixture(t,overrides={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-interactive-test-'));
  const store=new Store(directory,directory),role=store.state.roles[0],project=store.state.projects[0];
  role.engine='claude';role.provider='native';role.locationId='local';role.model='fixture-model';role.permission='workspace-write';
  project.directories=[{locationId:'local',path:directory}];project.roleIds=[role.id];
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});chat.roleSettings[role.id].model='chat-model';
  store.message(chat.id,{kind:'user',text:'Fixture prior request',status:'accepted'});
  const children=[],events=[],prepared={executable:'fixture-agent.exe',env:{FIXTURE_PROXY:'yes',RELAY_MCP_TOKEN:'fixture-secret-token'},extra:['--mcp-config','fixture-mcp.json'],bridge:{close(){}},tools:{close(){}}};
  const manager=new InteractiveAgents({store,vault:{get:()=>''},agents:{prepareLocal:async()=>prepared},locations:{},busy:()=>false,count:()=>0,emit:e=>events.push(e),spawn:(command,args,options)=>{
    const child={command,args,options,writes:[],sizes:[],kills:0,write(value){this.writes.push(value);},resize(cols,rows){this.sizes.push([cols,rows]);},kill(){this.kills++;},onData(fn){this.data=fn;},onExit(fn){this.exit=fn;}};children.push(child);return child;
  },...overrides});
  t.after(()=>{manager.closeAll();store.save();fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  return {directory,store,role,project,chat,manager,children,events,prepared};
}
test('Interactive arguments launch actual native TUIs, retain model, permission and HTTP transport, and never submit a prompt',()=>{
  for(const engine of ['claude','codex']){
    const args=interactiveArgs({engine,provider:'native',model:'fixture-model',effort:'high',permission:'workspace-write'},'D:/context.txt');
    for(const flag of ['exec','--json','-p','--input-format','--output-format','--no-session-persistence','--ephemeral','-'])assert(!args.includes(flag));
    assert(args.includes('fixture-model'));assert(args.includes('high')||args.some(x=>x.includes('high')));
    assert(args.some(x=>x.includes('D:/context.txt')));
    if(engine==='codex'){assert(args.includes('on-request'));assert(args.some(x=>x.includes('supports_websockets=false')));}
    else assert.equal(args[args.indexOf('--permission-mode')+1],'acceptEdits');
  }
  assert(interactiveArgs({engine:'claude',permission:'danger-full-access'},'/ctx').includes('bypassPermissions'));
  assert(interactiveArgs({engine:'codex',permission:'danger-full-access'},'/ctx').includes('never'));
  assert.throws(()=>interactiveArgs({engine:'opencode'},'/ctx'),/currently support/);
});
test('Interactive arguments restore the exact native session rather than the latest conversation',()=>{
  for(const engine of ['claude','codex']){const args=interactiveArgs({engine,provider:'native',permission:'read-only',model:'fixture-model'},'/ctx',{id:'owned-exact-id',resumed:true});assert(args.includes('owned-exact-id'));assert(!args.includes('--last'));if(engine==='claude'){assert.equal(args[args.indexOf('--resume')+1],'owned-exact-id');assert(!args.includes('--session-id'));}else assert.equal(args[args.indexOf('resume')+1],'owned-exact-id');}
  const compatible=interactiveArgs({engine:'codex',provider:'native',permission:'read-only',model:'fixture-model'},'/ctx',{id:'exact-thread',resumed:true,record:{disableRequestCompression:true}});assert(compatible.includes('features.enable_request_compression=false'));assert.equal(compatible[compatible.indexOf('resume')+1],'exact-thread');
});
test('A completed interactive turn shares its binding with ordinary chat and does not duplicate restored history',async t=>{
  const f=fixture(t),id=await f.manager.open(f.chat.id,f.role.id),entry=f.manager.entries.get(id);
  f.manager.sync(entry,{type:'user',uuid:'native-user',sessionId:id,message:{content:'Interactive user turn'}},'fixture-user');
  f.manager.sync(entry,{type:'assistant',uuid:'native-answer',sessionId:id,message:{id:'native-message',content:[{type:'text',text:'Interactive final answer'}],stop_reason:'end_turn'}},'fixture-answer');
  f.manager.close(id);let executable='';try{executable=require('../workbench/agents.cjs').findExecutable(f.role);}catch{}
  const binding=nativeSessions.plan({store:f.store,chatId:f.chat.id,role:f.role,project:f.project,location:f.store.state.locations[0],directory:f.project.directories[0],executable});assert.equal(binding.resumed,true);assert.equal(binding.id,id);assert.deepEqual(binding.context(f.chat).messages,[]);
  f.prepared.env.CLAUDE_CONFIG_DIR=path.join(f.directory,'native-history');const folder=path.join(f.prepared.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,id+'.jsonl');fs.writeFileSync(file,JSON.stringify({type:'assistant',uuid:'old-replay',sessionId:id,message:{id:'old-message',content:[{type:'text',text:'DO_NOT_DUPLICATE_OLD_NATIVE_HISTORY'}],stop_reason:'end_turn'}})+'\n');
  const count=f.chat.messages.length,next=await f.manager.open(f.chat.id,f.role.id);assert.equal(f.children.at(-1).args[f.children.at(-1).args.indexOf('--resume')+1],id);f.manager.entries.get(next).reader.poll();assert.equal(f.chat.messages.length,count);
});
test('Local terminal routes real keystrokes, resize, contextual configuration, output and end state',async t=>{
  const f=fixture(t),id=await f.manager.open(f.chat.id,f.role.id),child=f.children[0];
  assert.equal(child.options.cwd,f.directory);assert.equal(child.options.env.FIXTURE_PROXY,'yes');assert(child.args.includes('chat-model'));assert(child.args.includes('fixture-mcp.json'));assert.equal(child.writes.length,0);
  assert(fs.readFileSync(path.join(f.directory,'interactive',id,'context.txt'),'utf8').includes('Fixture prior request'));
  f.manager.input(id,'/mcp\r');f.manager.input(id,'\x1b[B');f.manager.input(id,'\r');f.manager.resize(id,132,44);
  assert.deepEqual(child.writes,['/mcp\r','\x1b[B','\r']);assert.deepEqual(child.sizes,[[132,44]]);
  child.data('Select reconnect\r\nfixture-secret-');child.data('token\r\nConnected\r\n');
  const output=f.events.filter(e=>e.type==='data').map(e=>e.data).join('');assert(!output.includes('fixture-secret'));assert(output.includes('[redacted]'));assert(output.includes('Connected'));
  child.exit();assert.equal(f.manager.list()[0].state,'ended');assert.equal(fs.existsSync(path.join(f.directory,'interactive',id)),false);assert.throws(()=>f.manager.input(id,'x'),/not connected/);
  assert.equal(f.chat.messages.length,1);assert(f.chat.interactiveTerminals[f.role.id].output.includes('Connected'));
});
test('Opening is explicit, duplicate opens reuse a process, and completed output survives reload without reconnecting',async t=>{
  const f=fixture(t);assert.equal(f.children.length,0);
  const id=await f.manager.open(f.chat.id,f.role.id);assert.equal(await f.manager.open(f.chat.id,f.role.id),id);assert.equal(f.children.length,1);
  f.children[0].data('Retained terminal output');f.manager.close(id);assert.equal(f.children[0].kills,1);
  const next=new InteractiveAgents({store:f.store,emit:()=>{},spawn:()=>assert.fail('Do not auto-connect')});
  assert.equal(next.list()[0].state,'ended');assert(next.list()[0].output.includes('Retained terminal output'));
  await f.manager.open(f.chat.id,f.role.id);assert.equal(f.manager.list().length,1);assert.equal(f.children.length,2);
});
test('Running discussions, missing membership, unsupported agents and resource limits are rejected before spawning',async t=>{
  const f=fixture(t);f.manager.busy=()=>true;await assert.rejects(f.manager.open(f.chat.id,f.role.id),/discussion/);f.manager.busy=()=>false;
  await assert.rejects(f.manager.open(f.chat.id,'not-a-member'),/participant/);
  f.role.engine='opencode';await assert.rejects(f.manager.open(f.chat.id,f.role.id),/support/);f.role.engine='claude';
  f.manager.count=()=>f.store.state.settings.maxJobs;await assert.rejects(f.manager.open(f.chat.id,f.role.id),/limit/);assert.equal(f.children.length,0);
});
test('A close during asynchronous preparation cannot create a hidden process',async t=>{
  const f=fixture(t);let resolve;f.manager.agents.prepareLocal=()=>new Promise(r=>resolve=r);
  const opening=f.manager.open(f.chat.id,f.role.id);f.manager.close(f.manager.list()[0].id);resolve(f.prepared);
  await assert.rejects(opening,/closed during startup/);assert.equal(f.children.length,0);assert.equal(f.manager.list()[0].state,'ended');
});
test('Remote managed terminals send framed input and resize without exposing the bootstrap to the PTY',async t=>{
  const f=fixture(t),frames=[];const stream=new EventEmitter();stream.stderr=new PassThrough();stream.write=data=>frames.push(JSON.parse(data));stream.close=()=>{};
  f.store.state.locations.push({id:'fixture-ssh',type:'ssh',os:'linux',managed:true});f.role.locationId='fixture-ssh';f.project.directories=[{locationId:'fixture-ssh',path:'/srv/fixture'}];
  f.manager.network={policy:()=>({mode:'custom',url:'http://127.0.0.1:7890'})};
  f.manager.locations={exec:async()=>String(1024*1024),runner:async()=>({file:'/tmp/fixture-runner.py',client:{exec:(command,callback)=>{assert(!command.includes('pty'));callback(null,stream);}}})};
  const id=await f.manager.open(f.chat.id,f.role.id);const request=frames[0];assert.equal(request.interactive,true);assert.equal(request.managed,true);assert(request.context.includes('Fixture prior request'));assert(request.command.some(x=>x.includes('__RELAY_CONTEXT__')));assert.equal(request.proxy.mode,'custom');assert(!request.command.includes('-p'));
  f.manager.input(id,'/mcp\r');f.manager.resize(id,120,40);assert.deepEqual(frames[1],{type:'input',data:'/mcp\r'});assert.deepEqual(frames[2],{type:'resize',cols:120,rows:40});
  stream.emit('data',Buffer.from('Remote TUI output'));assert(f.manager.list()[0].output.includes('Remote TUI output'));
  const closed = f.manager.closeAll();
  assert.deepEqual(frames.at(-1), {type:'close'});
  const stillPending = Symbol('waiting for SSH close');
  assert.equal(await Promise.race([closed, Promise.resolve(stillPending)]), stillPending);
  stream.emit('close');
  await closed;
  assert.equal(f.manager.active(),false);assert.equal(f.children.length,0);
});

test('Native Claude transcript tail updates the same chat, handles partial writes and never displays hidden or synthetic records',async t=>{
  const f=fixture(t),updates=[];f.prepared.env.CLAUDE_CONFIG_DIR=path.join(f.directory,'claude');f.manager.message=e=>updates.push(e);
  const id=await f.manager.open(f.chat.id,f.role.id),entry=f.manager.entries.get(id),folder=path.join(f.prepared.env.CLAUDE_CONFIG_DIR,'projects','fixture-project');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,id+'.jsonl');
  const row={type:'assistant',uuid:'fixture-row-1',message:{id:'fixture-assistant',role:'assistant',content:[{type:'thinking',thinking:'SECRET_REASONING'},{type:'text',text:'Native answer'}],stop_reason:null}};
  const line=JSON.stringify(row)+'\n';fs.writeFileSync(file,line.slice(0,-5));entry.reader.poll();assert.equal(f.chat.messages.length,1);
  fs.appendFileSync(file,line.slice(-5));entry.reader.poll();assert.equal(f.chat.messages.length,2);assert.equal(f.chat.messages.at(-1).text,'Native answer');assert.equal(f.chat.messages.at(-1).status,'running');
  row.uuid='fixture-row-2';row.message.content=[{type:'text',text:'Native answer finished'}];row.message.stop_reason='end_turn';
  fs.appendFileSync(file,JSON.stringify(row)+'\n'+JSON.stringify({type:'user',isCompactSummary:true,message:{content:'INTERNAL_SUMMARY'}})+'\n'+JSON.stringify({type:'user',message:{content:[{type:'tool_result',content:'SECRET_TOOL_OUTPUT'}]}})+'\n');entry.reader.poll();entry.reader.poll();
  assert.equal(f.chat.messages.length,2);assert.equal(f.chat.messages.at(-1).text,'Native answer finished');assert.equal(f.chat.messages.at(-1).status,'complete');assert(!JSON.stringify(updates).includes('SECRET_'));assert(!JSON.stringify(updates).includes('INTERNAL_SUMMARY'));
});
test('Codex sync deduplicates dual representations but preserves repeated real turns and independent terminal ownership',async t=>{
  const f=fixture(t);f.role.engine='codex';const id=await f.manager.open(f.chat.id,f.role.id),entry=f.manager.entries.get(id);
  let pos=0;const sync=row=>f.manager.sync(entry,row,String(pos++));
  const user={type:'event_msg',payload:{type:'user_message',message:'Repeat question'}},answer={type:'event_msg',payload:{type:'agent_message',message:'Native result',phase:'final_answer'}};
  sync(user);sync({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Repeat question'}]}});
  sync(answer);sync({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Native result'}],phase:'final_answer'}});
  assert.equal(f.chat.messages.length,3);sync(user);sync(answer);assert.equal(f.chat.messages.length,5);
  const before=f.chat.messages.length;sync({type:'response_item',payload:{type:'reasoning',content:[{type:'text',text:'Hidden detail'}]}});assert.equal(f.chat.messages.length,before);
  assert.equal(entry.info.taskState,'completed');
});
test('Composer writes to the existing CLI, preserves submission until acknowledged and merges its transcript echo once',async t=>{
  const f=fixture(t);const id=await f.manager.open(f.chat.id,f.role.id),entry=f.manager.entries.get(id);f.manager.screen(id,'Claude Code\n> \n? for shortcuts');
  const result=f.manager.submit(f.chat.id,f.role.id,{text:'Composer question'});assert(result.accepted);assert.equal(f.children.length,1);assert.deepEqual(f.children[0].writes,['\x1b[200~Composer question\x1b[201~','\r']);assert.equal(f.chat.messages.at(-1).status,'submitting');
  f.manager.sync(entry,{type:'user',uuid:'fixture-user-ack',message:{content:'Composer question'}},'0');assert.equal(f.chat.messages.length,2);assert.equal(f.chat.messages.at(-1).status,'accepted');
  f.manager.sync(entry,{type:'assistant',message:{id:'fixture-answer',content:[{type:'text',text:'Reply to composer'}],stop_reason:'end_turn'}},'1');assert.equal(f.chat.messages.length,3);assert.equal(f.chat.messages.at(-1).status,'complete');
  f.manager.screen(id,'Claude Code\n> \n? for shortcuts');f.manager.submit(f.chat.id,f.role.id,{text:'Retain if disconnected'});f.manager.close(id);assert.equal(f.chat.messages.at(-1).text,'Retain if disconnected');assert.equal(f.chat.messages.at(-1).status,'unconfirmed');
});
test('Composer cannot approve startup/trust prompts or send into a running turn',async t=>{
  const f=fixture(t);const id=await f.manager.open(f.chat.id,f.role.id),entry=f.manager.entries.get(id);
  f.manager.screen(id,'Do you trust this folder?\n> ');assert.throws(()=>f.manager.submit(f.chat.id,f.role.id,{text:'Do not approve'}),/终端/);assert.equal(f.chat.messages.length,1);
  assert.throws(()=>f.manager.submit(f.chat.id,f.role.id,{text:'Do not use a stale model',settings:{model:'changed-model',effort:f.role.effort}}),/设置/);assert.equal(f.chat.messages.length,1);
  f.manager.screen(id,'> ');f.manager.submit(f.chat.id,f.role.id,{text:'First turn'});assert.throws(()=>f.manager.submit(f.chat.id,f.role.id,{text:'Second turn'}),/终端/);assert.equal(entry.info.taskState,'running');
});
