const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const recovery=require('../workbench/codex-recovery.cjs'),{parseEvent,Agents}=require('../workbench/agents.cjs'),{Store}=require('../workbench/store.cjs');
const id='e640016d-cf22-42a9-ae7d-e5e7f6ec7db7',bad='{"detail":"Bad Request"}';
function options(){return {role:{engine:'codex',provider:'native'},session:{id,record:{confirmed:true}},state:{nativeSessionId:id,turnStarted:true,error:bad,pendingTools:new Set()},message:{text:'Preserved progress'},signal:new AbortController().signal,update(){}};}

test('A failed model turn restores only the exact session and never resends the original task',async()=>{
  const o=options(),calls=[],delays=[];o.attempt=async value=>{calls.push(value);if(calls.length===1)throw new Error(bad);assert.equal(value.session.id,id);assert.equal(value.session.resumed,true);assert.equal(value.input,recovery.continuation);assert(!value.input.includes('ORIGINAL_TASK_MARKER'));o.state.completed=true;};o.wait=async ms=>delays.push(ms);
  await recovery.run(o);assert.equal(calls.length,2);assert.equal(o.message.recovery.state,'recovered');assert.equal(o.message.text,'Preserved progress');assert.deepEqual(delays,[2000]);assert.equal(calls[1].session.disableRequestCompression,true);assert.equal(o.session.record.disableRequestCompression,true);assert.equal(o.message.recovery.transport,'uncompressed');
});

test('Recovery has two extra attempts at most and preserves cancellation during backoff',async()=>{
  const o=options();let calls=0;o.attempt=async()=>{calls++;Object.assign(o.state,{turnStarted:true,error:bad});throw new Error(bad);};o.wait=async()=>{};
  await assert.rejects(recovery.run(o),/Bad Request/);assert.equal(calls,3);assert.equal(o.message.recovery.attempt,2);assert.equal(o.message.recovery.state,'stopped');assert.equal(o.session.record.disableRequestCompression,undefined);
  const controller=new AbortController(),c=options();c.signal=controller.signal;let cancelled=0;c.attempt=async()=>{cancelled++;throw new Error(bad);};c.wait=async()=>{controller.abort();throw new Error('Fixture cancelled');};await assert.rejects(recovery.run(c),/cancelled/);assert.equal(cancelled,1);assert.equal(c.message.recovery.state,'cancelled');
});

test('A plain connection failure retains the configured compression setting',async()=>{
  const o=options();o.state.error='stream disconnected before completion';let calls=0;
  o.attempt=async value=>{if(++calls===1)throw new Error(o.state.error);assert.equal(value.session.disableRequestCompression,false);o.state.completed=true;};o.wait=async()=>{};
  await recovery.run(o);assert.equal(calls,2);assert.equal(o.session.record.disableRequestCompression,undefined);assert.equal(o.message.recovery.transport,undefined);
});

test('Authentication, quota, invalid requests, unknown native progress and unfinished tools never auto-continue',()=>{
  for(const error of ['401 Unauthorized','403 Forbidden','quota exhausted','429 Too many requests','The model is not supported','invalid model','invalid parameter','maximum context length exceeded','request timed out: failed to refresh available models']){const o=options();o.state.error=error;assert.equal(recovery.reason(o),'',error);}
  for(const change of [o=>o.state.turnStarted=false,o=>o.session.record.confirmed=false,o=>o.state.nativeSessionId='unrelated',o=>o.state.pendingTools.add('unknown-command'),o=>o.state.completed=true,o=>o.role.engine='claude',o=>o.role.provider='openai']){const o=options();change(o);assert.equal(recovery.reason(o),'');}
  for(const error of [{code:'REMOTE_CHANNEL_CLOSED'},{code:'REMOTE_AGENT_KILLED'},{code:'NATIVE_SESSION_MISMATCH'},{exitCode:137},{exitCode:null},{exitCode:1,cliShutdown:{forced:true}}]){const o=options();o.error=error;assert.equal(recovery.reason(o),'');}
  for(const error of ['unexpected status 503 Service Unavailable','stream disconnected before completion','Connection failed: error sending request']){const o=options();o.state.error=error;assert.equal(recovery.reason(o),'transport');}
});

test('Codex parser retains pending command state until its native completion event',()=>{
  const state={text:''},emit=()=>{};parseEvent('codex',{type:'turn.started'},state,emit);assert(state.turnStarted);
  parseEvent('codex',{type:'item.started',item:{id:'one',type:'command_execution',command:'echo fixture'}},state,emit);assert(state.pendingTools.has('one'));
  parseEvent('codex',{type:'error',message:bad},state,emit);assert(state.pendingTools.has('one'));assert(state.terminal.includes('[CLI warning]'));
  parseEvent('codex',{type:'item.completed',item:{id:'one',type:'command_execution',command:'echo fixture',exit_code:0,aggregated_output:'Fixture output'}},state,emit);assert.equal(state.pendingTools.size,0);
});

test('SSH Codex driver preserves partial output and restores its native session after a generic model failure',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-codex-recovery-'));t.after(()=>fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const store=new Store(directory,directory),project=store.state.projects[0];store.state.locations.push({id:'fixture-ssh',type:'ssh',os:'linux',control:'ssh',name:'Fixture SSH',host:'example.invalid',username:'fixture',port:22});project.directories=[{locationId:'fixture-ssh',path:'/tmp/fixture'}];
  const role=store.saveRole({...store.state.roles[0],engine:'codex',provider:'native',locationId:'fixture-ssh',codexLoginSource:'isolated',model:'fixture-model',allowLocationTools:false});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'ORIGINAL_TASK_MARKER',status:'accepted'});
  const requests=[];const client={exec(_command,callback){const stream=new EventEmitter();stream.stderr=new PassThrough();stream.write=line=>{const request=JSON.parse(line);requests.push(request);queueMicrotask(()=>{const events=[{type:'thread.started',thread_id:id},{type:'turn.started'}];if(requests.length===1)events.push({type:'item.started',item:{id:'done',type:'command_execution',command:'echo fixture'}},{type:'item.completed',item:{id:'done',type:'command_execution',command:'echo fixture',exit_code:0,aggregated_output:'Fixture work completed'}},{type:'item.completed',item:{id:'partial',type:'agent_message',text:'PARTIAL_PROGRESS_MARKER'}},{type:'turn.failed',error:{message:bad}});else events.push({type:'item.completed',item:{id:'final',type:'agent_message',text:'RECOVERED_FINAL_MARKER'}},{type:'turn.completed'});for(const event of events)stream.emit('data',Buffer.from(JSON.stringify(event)+'\n'));stream.emit('exit',requests.length===1?1:0);stream.emit('close');});};stream.close=()=>{};callback(null,stream);}};
  const agents=new Agents(store,{get:()=>''},{runner:async()=>({client,file:'/tmp/fixture-runner.py'})},()=>{});t.after(()=>agents.close());
  const result=await agents.run(chat.id,role,project,new AbortController().signal);assert.equal(result.status,'complete',result.note);assert.equal(requests.length,2);assert(requests[0].input.includes('ORIGINAL_TASK_MARKER'));assert.equal(requests[1].input,recovery.continuation);assert(requests[1].command.includes('resume'));assert(requests[1].command.includes(id));assert(result.text.includes('PARTIAL_PROGRESS_MARKER'));assert(result.text.includes('RECOVERED_FINAL_MARKER'));assert.equal(result.recovery.state,'recovered');assert.equal(chat.nativeSessions[role.id].id,id);assert.equal(chat.nativeSessions[role.id].status,'ready');assert.equal(chat.messages.filter(m=>m.kind==='assistant').length,1);
});
