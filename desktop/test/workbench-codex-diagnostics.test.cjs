const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {inspect,create}=require('../workbench/codex-diagnostics.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-diagnostic-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}

test('Generic Bad Request does not invent a capacity code, HTTP status or request ID',()=>{
  const data=inspect({error:{message:'{"detail":"Bad Request"}'}});assert.equal(data.category,'bad_request');assert.equal(data.httpStatus,null);assert.deepEqual(data.codes,[]);assert.deepEqual(data.requestIds,[]);
});

test('Explicit native overload codes stay distinct from quotas, context and ordinary transport failures',()=>{
  const data=inspect({error:{message:'Temporarily unavailable',codex_error_info:'ServerOverloaded',http_status_code:503,request_id:'req_fixture1234',retry_after_ms:12000}});assert.equal(data.category,'capacity');assert.equal(data.httpStatus,503);assert.deepEqual(data.codes,['serveroverloaded']);assert.deepEqual(data.requestIds,['req_fixture1234']);assert.equal(data.retryAfterMs,12000);
  assert.equal(inspect({codexErrorInfo:'policy_capacity_unavailable'}).category,'capacity');assert.equal(inspect('Selected model is at capacity. Please try a different model.').category,'capacity');
  assert.equal(inspect({code:'RateLimitExceeded',http_status_code:429}).category,'quota_or_rate_limit');assert.equal(inspect('maximum context length exceeded').category,'context');assert.equal(inspect('unexpected status 503 Service Unavailable').category,'transport');assert.equal(inspect('failed to refresh available models: request timed out').category,'model_catalog');
});

test('Metadata logs contain neither prompts, arbitrary error text, commands, images nor authentication data',t=>{
  const directory=fixture(t),writer=create(directory,{traceId:'trace-fixture',chatId:'chat-fixture',model:'fixture-model',prompt:'PRIVATE_PROMPT_MARKER'});
  writer.begin({resumed:true,sessionId:'session-fixture',compression:'disabled_by_override',appPromptBytes:123,cliVersion:'0.169.0'});
  writer.event({type:'item.completed',item:{id:'private',type:'command_execution',command:'PRIVATE_COMMAND_MARKER',aggregated_output:'PRIVATE_OUTPUT_MARKER',exit_code:0}});
  writer.event({type:'turn.failed',error:{message:'{"detail":"Bad Request","private":"PRIVATE_ERROR_MARKER","Authorization":"Bearer PRIVATE_TOKEN_MARKER","image":"data:image/png;base64,PRIVATE_IMAGE_MARKER"}',request_id:'req_fixture5678'}});
  const message={status:'failed',note:'{"detail":"Bad Request"}'};writer.end(new Error(message.note),{turnEnded:'failed'});writer.finish(message);
  const saved=fs.readFileSync(path.join(directory,'diagnostics/codex-events.jsonl'),'utf8');for(const value of ['PRIVATE_PROMPT_MARKER','PRIVATE_COMMAND_MARKER','PRIVATE_OUTPUT_MARKER','PRIVATE_ERROR_MARKER','PRIVATE_TOKEN_MARKER','PRIVATE_IMAGE_MARKER','Authorization','data:image'])assert(!saved.includes(value),value);
  assert(saved.includes('req_fixture5678'));assert(saved.includes('"successfulCommands":1'));assert.equal(message.diagnostics.failure.category,'bad_request');assert.equal(message.diagnostics.localLogWritten,true);
});

test('Split stderr metadata retains observed correlation values without writing raw lines',t=>{
  const directory=fixture(t),writer=create(directory,{traceId:'trace-fixture'});writer.begin({resumed:false,appPromptBytes:5,compression:'cli_default'});
  writer.stderr('unexpected status 400 Bad Req');writer.stderr('uest request id: req_split_fixture secret=PRIVATE_SECRET\n');writer.finish({status:'failed',note:'Bad Request'});
  const rows=fs.readFileSync(path.join(directory,'diagnostics/codex-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse),row=rows.find(r=>r.event==='stderr_metadata');assert.equal(row.httpStatus,400);assert.deepEqual(row.requestIds,['req_split_fixture']);assert(!JSON.stringify(rows).includes('PRIVATE_SECRET'));
});

test('Structured capacity evidence survives a short message and clears after successful recovery',t=>{
  const writer=create(fixture(t),{traceId:'trace-fixture'});writer.begin({resumed:true,compression:'cli_default',appPromptBytes:1});writer.event({type:'turn.failed',error:{message:'Bad Request',codex_error_info:'server_overloaded'}});const failed={status:'failed',note:'Bad Request'};writer.finish(failed);assert.equal(failed.diagnostics.failure.category,'capacity');
  writer.begin({resumed:true,compression:'cli_default',appPromptBytes:1});writer.event({type:'turn.completed',usage:{input_tokens:123}});const complete={status:'complete'};writer.finish(complete);assert.equal(complete.diagnostics.failure,undefined);
});

test('Log rotation bounds disk usage and logging failures cannot fail the task',t=>{
  const directory=fixture(t),writer=create(directory,{traceId:'trace-fixture'},{limit:700});for(let i=0;i<30;i++)writer.begin({sessionId:'session-fixture',resumed:true,compression:'cli_default',appPromptBytes:i});writer.finish({status:'complete'});
  const folder=path.join(directory,'diagnostics'),files=fs.readdirSync(folder);assert(files.length<=3);for(const name of files){const data=fs.readFileSync(path.join(folder,name),'utf8');for(const line of data.trim().split('\n'))assert.doesNotThrow(()=>JSON.parse(line));}
  const blocked=path.join(directory,'blocked');fs.writeFileSync(blocked,'fixture');const unavailable=create(blocked,{traceId:'blocked-fixture'}),message={status:'complete'};assert.doesNotThrow(()=>unavailable.finish(message));assert.equal(message.diagnostics.localLogWritten,false);
});
test('Shutdown diagnostics separate cleanup intervention from an actual abnormal CLI exit',t=>{
  const directory=fixture(t),writer=create(directory,{traceId:'shutdown-fixture'});writer.begin({sessionId:'session-fixture',resumed:false,appPromptBytes:1,compression:'cli_default'});
  writer.shutdown({reason:'cleanup_timeout',graceMs:50000,afterTerminalMs:50123,exitCode:null,exitSignal:'SIGTERM',forced:true,exitObserved:true,private:'PRIVATE_SHUTDOWN_MARKER'});
  const message={status:'complete'};writer.end(null,{turnEnded:'complete'});writer.finish(message);
  assert.equal(message.diagnostics.shutdown.reason,'cleanup_timeout');assert.equal(message.diagnostics.shutdown.graceMs,50000);assert.equal(message.diagnostics.shutdown.exitSignal,'SIGTERM');assert.equal(message.diagnostics.failure,undefined);
  const rows=fs.readFileSync(path.join(directory,'diagnostics/codex-events.jsonl'),'utf8');assert(rows.includes('process_shutdown'));assert(!rows.includes('PRIVATE_SHUTDOWN_MARKER'));
  writer.begin({sessionId:'session-fixture',resumed:true,appPromptBytes:2,compression:'cli_default'});writer.finish({status:'complete'});const next={status:'complete'};writer.finish(next);assert.equal(next.diagnostics.shutdown,undefined);
});

test('The real adapter exposes explicit capacity separately and writes only diagnostic metadata',async t=>{
  const {Store}=require('../workbench/store.cjs'),{Agents}=require('../workbench/agents.cjs'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
  const directory=fixture(t),store=new Store(directory,directory),project=store.state.projects[0];
  const location={id:'capacity-ssh',name:'Fixture SSH',type:'ssh',os:'linux',control:'ssh',host:'example.invalid',username:'fixture',port:22};store.state.locations.push(location);project.directories=[{locationId:location.id,path:'/tmp/fixture'}];
  const role=store.saveRole({...store.state.roles[0],engine:'codex',provider:'native',model:'gpt-6.1-sol',locationId:location.id,allowLocationTools:false}),chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'PRIVATE_TASK_MARKER',status:'accepted'});
  const client={exec(_command,callback){const stream=new EventEmitter();stream.stderr=new PassThrough();stream.close=()=>{};stream.write=()=>queueMicrotask(()=>{for(const value of [{type:'thread.started',thread_id:'capacity-thread'},{type:'turn.started'},{type:'turn.failed',error:{message:'Selected model is at capacity. Please try a different model.',codex_error_info:'server_overloaded',http_status_code:503,request_id:'req_capacity_fixture'}}])stream.emit('data',Buffer.from(JSON.stringify(value)+'\n'));stream.emit('exit',1);stream.emit('close');});callback(null,stream);}};
  const agents=new Agents(store,{get:()=>''},{runner:async()=>({client,file:'/tmp/fixture.py'})},()=>{});t.after(()=>agents.close());const message=await agents.run(chat.id,role,project,new AbortController().signal);
  assert.equal(message.errorCode,'CODEX_CAPACITY');assert.equal(message.diagnostics.failure.category,'capacity');assert.equal(message.diagnostics.failure.httpStatus,503);assert.deepEqual(message.diagnostics.failure.requestIds,['req_capacity_fixture']);assert.equal(message.diagnostics.attempts,1);assert.equal(message.diagnostics.lastAttempt.cliVersion,'remote_unobserved');
  const log=fs.readFileSync(path.join(directory,'diagnostics/codex-events.jsonl'),'utf8');assert(!log.includes('PRIVATE_TASK_MARKER'));assert(log.includes('gpt-6.1-sol'));assert(log.includes('turn_failure'));
});
