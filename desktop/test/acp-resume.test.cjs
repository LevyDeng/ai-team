const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {AcpClient}=require('../workbench/acp-client.cjs');
function fixture(capabilities,handler){const child=new EventEmitter();child.stdin=new EventEmitter();child.stdout=new EventEmitter();const requests=[];child.stdin.write=line=>{const value=JSON.parse(line);if(!value.method)return;requests.push(value);queueMicrotask(()=>handler?.(value,reply,child));};const reply=(id,result,error)=>child.stdout.emit('data',Buffer.from(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\n'));const state={text:''},client=new AcpClient(child,state,()=>{},{engine:'antigravity'});client.capabilities=capabilities;return {client,state,requests};}
test('ACP prefers advertised resume, restores optional metadata and never requests a different or latest session',async()=>{
  const f=fixture({sessionCapabilities:{resume:{}}},(v,reply)=>reply(v.id,{}));const session=await f.client.session('D:/fixture',{}, {id:'exact-session',metadata:{configOptions:[{id:'model'}]}});assert.equal(session.sessionId,'exact-session');assert.equal(session.restored,true);assert.equal(session.configOptions[0].id,'model');assert.deepEqual(f.requests.map(r=>r.method),['session/resume']);f.client.close();
});
test('ACP load and custom resume suppress history replay before a new reply',async()=>{
  const replay = (v,reply,child) => {
    child.stdout.emit('data',Buffer.from(JSON.stringify({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_REPLAY'}}}})+'\n'));
    reply(v.id,{});
  };
  for (const [engine,capabilities,method] of [
    ['antigravity',{loadSession:true},'session/load'],
    ['custom-acp',{sessionCapabilities:{resume:{}}},'session/resume'],
  ]) {
    const f=fixture(capabilities,replay);
    f.client.role.engine=engine;
    await f.client.session('D:/fixture',{}, {id:'exact-session'});
    assert.equal(f.state.text,'');
    assert.equal(f.requests[0].method,method);
    f.client.close();
  }
});
test('Only an explicit unknown-session response permits a fresh session before prompt submission',async()=>{
  const f=fixture({sessionCapabilities:{resume:{}}},(v,reply)=>v.method==='session/resume'?reply(v.id,null,{code:-32002,message:'Unknown session'}):reply(v.id,{sessionId:'replacement'}));const result=await f.client.session('D:/fixture',{}, {id:'old-session'});assert.equal(result.fallback,'session_missing');assert.equal(result.sessionId,'replacement');assert.deepEqual(f.requests.map(r=>r.method),['session/resume','session/new']);f.client.close();
  const denied=fixture({loadSession:true},(v,reply)=>reply(v.id,null,{code:-32000,message:'Authentication required'}));await assert.rejects(denied.client.session('D:/fixture',{}, {id:'old-session'}),e=>e.code==='VENDOR_LOGIN_REQUIRED');assert.equal(denied.requests.length,1);denied.client.close();
});

test('Cursor recreates a missing session reported in Invalid params details', async t => {
  const f = fixture({loadSession:true}, (request, reply) => {
    if (request.method === 'session/load') {
      reply(request.id, null, {code:-32602, message:'Invalid params', data:{message:'Session "old-session" not found'}});
    } else {
      reply(request.id, {sessionId:'replacement'});
    }
  });
  f.client.role.engine = 'cursor';
  t.after(() => f.client.close());
  const result = await f.client.session('D:/fixture', {tools:{command:'tool-fixture'}}, {id:'old-session'});
  assert.equal(result.sessionId, 'replacement');
  assert.equal(result.restored, false);
  assert.equal(result.fallback, 'session_missing');
  assert.deepEqual(f.requests.map(request => request.method), ['session/load', 'session/new']);
  assert.deepEqual(f.requests[1].params, {cwd:'D:/fixture', mcpServers:f.requests[0].params.mcpServers});
});

test('Cursor exposes other Invalid params errors without replacing the session', async t => {
  for (const data of [{mcpServers:{_errors:['Invalid value']}}, {message:'Session "different-session" not found'}]) {
    const f = fixture({loadSession:true}, (request, reply) => reply(request.id, null, {code:-32602, message:'Invalid params', data}));
    f.client.role.engine = 'cursor';
    t.after(() => f.client.close());
    await assert.rejects(f.client.session('D:/fixture', {}, {id:'old-session'}), error => {
      assert.equal(error.rpcCode, -32602);
      assert.ok(error.message.includes('session/load'));
      assert.ok(error.message.includes(data.message || 'Invalid params'));
      return true;
    });
    assert.deepEqual(f.requests.map(request => request.method), ['session/load']);
  }
});

test('Unsupported restore capability uses explicit compatibility mode, never an unadvertised resume operation',async()=>{
  const f=fixture({},(v,reply)=>reply(v.id,{sessionId:'fresh-session'}));const result=await f.client.session('D:/fixture',{}, {id:'old-session'});assert.equal(result.fallback,'resume_unsupported');assert.deepEqual(f.requests.map(r=>r.method),['session/new']);f.client.close();
});

test('An unexpected restored ID is rejected before submitting any prompt',async()=>{
  const f=fixture({sessionCapabilities:{resume:{}}},(v,reply)=>reply(v.id,{sessionId:'unrelated-session'}));
  await assert.rejects(f.client.session('D:/fixture',{}, {id:'expected-session'}),error=>error.code==='NATIVE_SESSION_MISMATCH');
  assert.deepEqual(f.requests.map(r=>r.method),['session/resume']);assert.equal(f.client.sessionId,undefined);f.client.close();
});
