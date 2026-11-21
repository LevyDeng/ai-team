const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {AcpClient}=require('../workbench/acp-client.cjs');
function fixture(capabilities,handler){const child=new EventEmitter();child.stdin=new EventEmitter();child.stdout=new EventEmitter();const requests=[];child.stdin.write=line=>{const value=JSON.parse(line);if(!value.method)return;requests.push(value);queueMicrotask(()=>handler?.(value,reply,child));};const reply=(id,result,error)=>child.stdout.emit('data',Buffer.from(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\n'));const state={text:''},client=new AcpClient(child,state,()=>{},{engine:'antigravity'});client.capabilities=capabilities;return {client,state,requests};}
test('ACP prefers advertised resume, restores optional metadata and never requests a different or latest session',async()=>{
  const f=fixture({sessionCapabilities:{resume:{}}},(v,reply)=>reply(v.id,{}));const session=await f.client.session('D:/fixture',{}, {id:'exact-session',metadata:{configOptions:[{id:'model'}]}});assert.equal(session.sessionId,'exact-session');assert.equal(session.restored,true);assert.equal(session.configOptions[0].id,'model');assert.deepEqual(f.requests.map(r=>r.method),['session/resume']);f.client.close();
});
test('ACP load fallback suppresses history replay so old assistant messages are not appended as a new reply',async()=>{
  const f=fixture({loadSession:true},(v,reply,child)=>{child.stdout.emit('data',Buffer.from(JSON.stringify({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_REPLAY'}}}})+'\n'));reply(v.id,{});});await f.client.session('D:/fixture',{}, {id:'exact-session'});assert.equal(f.state.text,'');assert.equal(f.requests[0].method,'session/load');f.client.close();
});
test('Only an explicit unknown-session response permits a fresh session before prompt submission',async()=>{
  const f=fixture({sessionCapabilities:{resume:{}}},(v,reply)=>v.method==='session/resume'?reply(v.id,null,{code:-32002,message:'Unknown session'}):reply(v.id,{sessionId:'replacement'}));const result=await f.client.session('D:/fixture',{}, {id:'old-session'});assert.equal(result.fallback,'session_missing');assert.equal(result.sessionId,'replacement');assert.deepEqual(f.requests.map(r=>r.method),['session/resume','session/new']);f.client.close();
  const denied=fixture({loadSession:true},(v,reply)=>reply(v.id,null,{code:-32000,message:'Authentication required'}));await assert.rejects(denied.client.session('D:/fixture',{}, {id:'old-session'}),e=>e.code==='VENDOR_LOGIN_REQUIRED');assert.equal(denied.requests.length,1);denied.client.close();
});
test('Unsupported restore capability uses explicit compatibility mode, never an unadvertised resume operation',async()=>{
  const f=fixture({},(v,reply)=>reply(v.id,{sessionId:'fresh-session'}));const result=await f.client.session('D:/fixture',{}, {id:'old-session'});assert.equal(result.fallback,'resume_unsupported');assert.deepEqual(f.requests.map(r=>r.method),['session/new']);f.client.close();
});

test('An unexpected restored ID is rejected before submitting any prompt',async()=>{
  const f=fixture({sessionCapabilities:{resume:{}}},(v,reply)=>reply(v.id,{sessionId:'unrelated-session'}));
  await assert.rejects(f.client.session('D:/fixture',{}, {id:'expected-session'}),error=>error.code==='NATIVE_SESSION_MISMATCH');
  assert.deepEqual(f.requests.map(r=>r.method),['session/resume']);assert.equal(f.client.sessionId,undefined);f.client.close();
});
