const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../workbench/store.cjs');
const { ModelCatalogs, normalize, queryCli } = require('../workbench/model-catalogs.cjs');
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.resolve(__dirname, '../../.runtime/model-catalog-test-'));
  t.after(() => { try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  const store = new Store(directory, directory);
  const role = store.saveRole({ ...store.state.roles[0], provider: 'deepseek', model: '' });
  return { directory, store, role, manager: new ModelCatalogs({ directory, store, vault: { get: () => 'saved-fixture-key' }, ...overrides }) };
}
test('Draft API credentials query models without saving and cache by account and provider', async t => {
  const calls = [];
  const { manager, role, store, directory } = fixture(t, { fetch: async (url, options) => { calls.push({ url, authorization: options.headers.Authorization }); return new Response(JSON.stringify({ data: [{ id: 'rare-model-alpha' }, { id: 'rare-model-beta' }] })); } });
  const draft = { ...role, apiKey: 'draft-fixture-key' };
  const first = await manager.request(draft); assert.equal(first.models.length, 2); assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, 'Bearer draft-fixture-key');
  assert.equal((await manager.request(draft)).cached, true); assert.equal(calls.length, 1);
  await manager.request(draft, { force: true }); assert.equal(calls.length, 2);
  await manager.request({ ...draft, apiKey: 'other-fixture-key' }); assert.equal(calls.length, 3);
  await manager.request({ ...draft, provider: 'gemini' }); assert.equal(calls.length, 4);
  assert.equal(store.get('roles', role.id).model, '');
  const saved = fs.readFileSync(path.join(directory, 'model-catalogs.json'), 'utf8'); assert(!saved.includes('fixture-key'));
});
test('Refresh failures preserve cached models and do not expose provider payloads', async t => {
  let fail = false;
  const { manager, role } = fixture(t, { fetch: async () => fail ? new Response('private-payload-fixture', { status: 401 }) : new Response(JSON.stringify({ data: [{ id: 'cached-model' }] })) });
  await manager.request(role); fail = true;
  const result = await manager.request(role, { force: true }); assert.equal(result.cached, true); assert.equal(result.models[0].id, 'cached-model');
  assert(result.warning.includes('401')); assert(!JSON.stringify(result).includes('private-payload'));
});

test('Model catalogs survive restart and age without another query until a manual refresh',async t=>{
  let calls=0;const request=async()=>{calls++;return Response.json({data:[{id:'cached-model-'+calls}]});};
  const {manager,role,store,directory}=fixture(t,{fetch:request});await manager.request(role);
  for(const entry of Object.values(manager.cache))entry.updatedAt=Date.now()-365*86400000;
  fs.writeFileSync(manager.file,JSON.stringify(manager.cache));
  const reopened=new ModelCatalogs({directory,store,vault:{get:()=> 'saved-fixture-key'},fetch:request});
  assert.equal((await reopened.request(role)).models[0].id,'cached-model-1');assert.equal(calls,1);
  assert.equal((await reopened.request(role,{force:true})).models[0].id,'cached-model-2');assert.equal(calls,2);
});

test('Changing an SSH endpoint does not reuse the previous server catalog',async t=>{
  let calls=0;const {manager,role,store}=fixture(t,{network:{policy:()=>({mode:'direct'})},locations:{catalog:async()=>({models:[{id:'server-'+(++calls)}]})}});
  const location={id:'fixture-remote',type:'ssh',managed:true,host:'first.invalid',username:'fixture',port:22};store.state.locations.push(location);
  const draft={...role,provider:'native',locationId:location.id};await manager.request(draft);await manager.request(draft);assert.equal(calls,1);
  location.host='second.invalid';assert.equal((await manager.request(draft)).models[0].id,'server-2');assert.equal(calls,2);
});
test('Changing provider never silently reuses another provider key and invalid URLs are rejected', async t => {
  const { manager, role } = fixture(t, { fetch: async () => { throw new Error('Should not fetch.'); } });
  await assert.rejects(manager.request({ ...role, provider: 'openai' }), /API key/);
  await assert.rejects(manager.request({ ...role, baseUrl: 'http://example.invalid' }), /HTTPS/);
});
test('Connection failures identify the system proxy without exposing upstream error details', async t => {
  const { manager, role } = fixture(t, { fetch: async () => { throw new TypeError('fetch failed: fixture-private-details'); } });
  await assert.rejects(manager.request(role), error => /system proxy/.test(error.message) && !/fixture-private-details/.test(error.message));
});
test('Model requests follow the role network policy and proxy changes invalidate the cache', async t => {
  const routes=[];
  const {manager,role}=fixture(t,{network:{policy:role=>({mode:role.proxyMode==='direct'?'direct':'system'}),fetchFor:async role=>async()=>{routes.push(role.proxyMode||'inherit');return new Response(JSON.stringify({data:[{id:'routed-model'}]}));}}});
  await manager.request(role);await manager.request({...role,proxyMode:'direct'});
  assert.deepEqual(routes,['inherit','direct']);
});
test('Native and managed catalogs load only on request and retain readable model names', async t => {
  let calls = 0;
  const { manager, role } = fixture(t, { agents: { home: () => 'fixture-home' }, native: async () => { calls++; return [{ model: 'native-model', displayName: 'Native Model' }]; } });
  assert.equal(calls, 0);
  const result = await manager.request({ ...role, provider: 'native' }); assert.equal(result.models[0].label, 'Native Model'); assert.equal(calls, 1);
  assert.deepEqual(normalize([{ id: 'good' }, { id: 'good' }, { id: 'hidden', hidden: true }, { id: 'invalid value' }]).map(item => item.id), ['good']);
});
test('Installed Codex exposes a model catalog without creating a model task', { timeout: 35000 }, async t => {
  const { directory } = fixture(t);
  const models = normalize(await queryCli({ engine: 'codex' }, path.join(directory, 'profile'), directory));
  assert(models.length > 0); assert(models.every(model => model.id));
});

test('Model refresh preserves advertised reasoning levels, distinguishes missing metadata, and shares the updated cache', async t => {
  let current='max',calls=0;
  const {manager,role}=fixture(t,{agents:{home:()=> 'fixture-home'},native:async()=>{
    calls++;
    return [
      {id:'picker-entry',model:'fixture-model',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:current}],defaultReasoningEffort:'high',isDefault:true},
      {value:'alias',resolvedModel:'fixture-resolved',supportedEffortLevels:['max'],defaultEffortLevel:'max'},
      {id:'unknown'}, {id:'no-override',efforts:[]}
    ];
  }});
  const draft={...role,provider:'native'};
  assert.deepEqual((await manager.request(draft,{cacheOnly:true})).models,[]);
  const first=(await manager.request(draft)).models;
  assert.equal(first[0].id,'fixture-model');assert.deepEqual(first[0].efforts,['high','max']);
  assert.equal(first[0].defaultEffort,'high');assert.equal(first[1].resolvedModel,'fixture-resolved');
  assert.deepEqual(first[1].efforts,['max']);assert.equal(first[2].efforts,undefined);assert.deepEqual(first[3].efforts,[]);
  current='xhigh';await manager.request(draft,{force:true});
  assert.deepEqual((await manager.request(draft,{cacheOnly:true})).models[0].efforts,['high','xhigh']);
  assert.equal(calls,2);
});

test('Native catalogs follow the selected login source and do not reuse the other source cache', async t=>{
  const calls=[];
  const desktop=path.resolve(__dirname,'../../.runtime/fixture-desktop-home');
  const {manager,role}=fixture(t,{agents:{home:()=> 'private-fixture',desktopHome:()=>desktop,environment:(role,home)=>({CODEX_HOME:role.codexLoginSource==='desktop'?desktop:path.join(home,'codex')})},native:async(role,_home,_cwd,env)=>{calls.push({source:role.codexLoginSource,home:env.CODEX_HOME});return[{id:role.codexLoginSource+'-model'}];}});
  await manager.request({...role,provider:'native',codexLoginSource:'isolated'});
  await manager.request({...role,provider:'native',codexLoginSource:'desktop'});
  assert.deepEqual(calls.map(call=>call.source),['isolated','desktop']);assert.equal(calls[1].home,desktop);assert.notEqual(calls[0].home,desktop);
  assert.equal((await manager.request({...role,provider:'native',codexLoginSource:'isolated'})).cached,true);assert.equal(calls.length,2);
});
