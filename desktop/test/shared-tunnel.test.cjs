const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Backend}=require('../backend.cjs');
const {PassThrough}=require('node:stream');
function fixture(t,options){const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-shared-'));fs.writeFileSync(path.join(root,'.env'),'SSH_TARGET=fixture@example.test\nSSH_PORT=22\nLOCAL_MCP_PORT=8111\nREMOTE_MCP_PORT=18111\nWINDOWS_MCP_SECRET='+'a'.repeat(64)+'\n');const b=new Backend(root,options);t.after(()=>{b.stop();fs.rmSync(root,{recursive:true,force:true});});return b;}
test('Workbench follows an authenticated existing service control mode without restarting it',async t=>{
  const b=fixture(t,{shareControlMode:true});b.probe=async()=>true;b.readControlMode=async()=>true;await b.startMcp();assert.equal(b.forceControl,true);assert.equal(b.appliedForceControl,true);assert.equal(b.status.mcp,'ready');assert.equal(b.status.mcpOwned,false);assert.equal(b.service,null);assert.equal(b.localPort,8111);
});
test('A classic explicit control preference still refuses a mismatched service',async t=>{
  const b=fixture(t);b.probe=async()=>true;b.readControlMode=async()=>true;await assert.rejects(b.startMcp(),/control mode differs/);assert.equal(b.forceControl,false);assert.equal(b.service,null);
});
test('Two SSH clients borrow the same authenticated forwarding endpoint without replacing it',async t=>{
  for(let index=0;index<2;index++){
    const b=fixture(t,{shareControlMode:true}),calls=[];const client={forwardIn:(host,port,cb)=>{calls.push({host,port});cb(new Error('Already bound'));},end(){}};b.client=client;b.probe=async(port,remote)=>{assert.equal(port,18111);assert(remote);return true;};b.findRemotePorts=async()=>{throw new Error('Must reuse the valid tunnel');};
    assert.equal(await b.startTunnel(18111,client,b.generation),false);assert.deepEqual(calls,[{host:'127.0.0.1',port:18111}]);assert.equal(b.remotePort,18111);b.stop();assert.equal(b.service,null);
  }
});
test('An unauthenticated occupied port is never treated as a reusable MCP tunnel',async t=>{
  const b=fixture(t),calls=[],client={forwardIn:(host,port,cb)=>{calls.push(port);cb(port===18112?null:new Error('Bound'));},end(){}};b.client=client;b.findRemotePorts=async()=>[18112];b.probe=async(port)=>{if(port===18111)throw new Error('Wrong service or secret');return true;};assert.equal(await b.startTunnel(18111,client,b.generation),true);assert.deepEqual(calls,[18111,18112]);assert.equal(b.remotePort,18112);
});
test('A disconnect during the shared endpoint probe cannot revive the connection',async t=>{
  const b=fixture(t),client={forwardIn:(host,port,cb)=>cb(new Error('Bound')),end(){}};b.client=client;b.probe=async()=>{b.stop();return true;};await assert.rejects(b.startTunnel(18111,client,b.generation),/canceled/);
});
test('Concurrent interface synchronization uses distinct temporary upload names',async t=>{
  const sources=[];const instances=[fixture(t),fixture(t)];
  for(const b of instances){b.localPort=8111;b.remotePort=18111;b.exec=async command=>command==='printf %s "$HOME"'?'/home/fixture':command.includes('read-usage.py')?'{}':'';b.syncDesktopSettings=async()=>{};
    b.client={end(){},sftp:callback=>callback(null,{fastPut:(source,target,options,done)=>{sources.push(target);setImmediate(done);},createWriteStream:target=>{sources.push(target);const stream=new PassThrough();stream.resume();stream.once('finish',()=>stream.destroy());return stream;},ext_openssh_rename:(source,target,done)=>setImmediate(done),end(){}})};
  }
  await Promise.all(instances.map(b=>b.syncServer()));assert(sources.length>40);assert.equal(new Set(sources).size,sources.length);assert(sources.every(source=>/\.[a-f0-9-]{36}\.relay-upload$/.test(source)));
});
