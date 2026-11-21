const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {AcpClient,requestTimeout}=require('../workbench/acp-client.cjs');
function fixture(engine='antigravity'){
  const child=new EventEmitter();child.stdin=new EventEmitter();child.stdout=new EventEmitter();const writes=[];child.stdin.write=line=>writes.push(JSON.parse(line));
  const client=new AcpClient(child,{text:''},()=>{},{engine});return {child,client,writes,reply:(id,result)=>child.stdout.emit('data',Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result})+'\n'))};
}
test('Antigravity can finish handshake and session startup after the old 20-second cutoff without a duplicate request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(()=>f.client.close());
  const initialized=f.client.initialize();t.mock.timers.tick(25000);assert.equal(f.client.pending.size,1);f.reply(1,{protocolVersion:1,agentCapabilities:{}});await initialized;
  const session=f.client.session('D:/fixture',{});t.mock.timers.tick(70000);assert.equal(f.client.pending.size,1);f.reply(2,{sessionId:'late-session'});assert.equal((await session).sessionId,'late-session');assert.deepEqual(f.writes.map(r=>r.method),['initialize','session/new']);
  assert.equal(requestTimeout('codebuddy','session/new'),20000);
});
test('Startup still has a bounded deadline, reports the exact stage and never submits a model prompt on timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(()=>f.client.close());const waiting=f.client.session('D:/fixture',{});
  const rejected=assert.rejects(waiting,error=>error.code==='VENDOR_PROTOCOL_TIMEOUT'&&error.method==='session/new'&&error.timeoutMs===120000);
  t.mock.timers.tick(120000);await rejected;assert.equal(f.client.pending.size,0);assert.deepEqual(f.writes.map(r=>r.method),['session/new']);
});
test('Closing the client cancels slow initialization immediately and removes its deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),pending=f.client.initialize(),rejected=assert.rejects(pending,/Fixture paused/);f.client.close(new Error('Fixture paused'));await rejected;t.mock.timers.tick(180000);assert.equal(f.client.pending.size,0);assert.equal(f.writes.length,1);
});
test('Synchronous protocol-write failures do not leave orphan pending requests or timeout rejections',async()=>{
  const f=fixture();f.child.stdin.write=()=>{throw new Error('Fixture closed pipe');};await assert.rejects(f.client.initialize(),/closed pipe/);assert.equal(f.client.pending.size,0);f.client.close();
});
