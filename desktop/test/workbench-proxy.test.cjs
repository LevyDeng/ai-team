const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProxyRouter, policy, environment, settings } = require('../workbench/proxy.cjs');
const { Store } = require('../workbench/store.cjs');
test('Role override takes priority over its own location without using another location proxy', () => {
  const local={id:'local',type:'local',proxy:{mode:'custom',url:'http://127.0.0.1:7890'}};
  const remote={id:'remote',type:'ssh',proxy:{mode:'custom',url:'http://127.0.0.1:8888'}};
  assert.equal(policy(local,{proxyMode:'inherit'}).url,'http://127.0.0.1:7890');
  assert.equal(policy(remote,{proxyMode:'proxy'}).url,'http://127.0.0.1:8888');
  assert.equal(policy(remote,{proxyMode:'direct'}).mode,'direct');
  assert.throws(()=>policy({proxy:{mode:'direct'}},{proxyMode:'proxy'}),/Configure/);
  assert.throws(()=>settings({mode:'custom',url:'socks5://localhost:1080'}),/HTTP/);
  assert.throws(()=>settings({mode:'custom',url:'http://user:password@localhost:7890'}),/credentials/);
});
test('Child proxy environment is isolated and preserves loopback gateway access', () => {
  const original={HTTP_PROXY:'http://old:9000',https_proxy:'http://old:9001',NO_PROXY:'example.test',MARKER:'unchanged'};
  const direct=environment(original,{mode:'direct'});assert(!direct.HTTP_PROXY);assert(!direct.https_proxy);assert.equal(direct.NO_PROXY,'*');
  const custom=environment(original,{mode:'custom',url:'http://localhost:7890'});assert.equal(custom.HTTPS_PROXY,'http://localhost:7890');assert(custom.NO_PROXY.includes('127.0.0.1'));
  assert.equal(original.NO_PROXY,'example.test');assert.equal(original.HTTP_PROXY,'http://old:9000');
});
test('Each proxy policy uses an independent Chromium session; native agents resolve system proxy locally', async () => {
  const saved=[];const location={id:'local',type:'local',proxy:{mode:'system'}};
  const router=new ProxyRouter({get:()=>location},{app:{resolveProxy:async()=> 'PROXY 127.0.0.1:7890; DIRECT'},session:{fromPartition:id=>({setProxy:async config=>saved.push({id,...config}),fetch:async()=>({})})}});
  const role={locationId:'local',engine:'codex',provider:'native'};
  await router.fetchFor(role);await router.fetchFor({...role,proxyMode:'direct'});
  location.proxy={mode:'custom',url:'http://127.0.0.1:8888'};await router.fetchFor(role);
  assert.deepEqual(saved.map(item=>item.mode),['system','direct','fixed_servers']);assert.equal(new Set(saved.map(item=>item.id)).size,3);
  location.proxy={mode:'system'};const env=await router.environmentFor(role,{});assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7890');
});
test('Built-in local connection stays immutable while its proxy and per-role overrides persist', () => {
  const directory=fs.mkdtempSync(path.resolve(__dirname,'../../.runtime/proxy-store-'));
  try {
    const store=new Store(directory,directory);const role=store.state.roles[0];
    store.saveLocationProxy('local',{mode:'custom',url:'http://localhost:7890'});store.saveRole({...role,proxyMode:'direct'});
    const restored=new Store(directory,directory);assert.equal(restored.get('locations','local').proxy.url,'http://localhost:7890');assert.equal(restored.get('roles',role.id).proxyMode,'direct');
    assert.throws(()=>restored.saveLocation({id:'local',name:'changed'}),/cannot be edited/);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
