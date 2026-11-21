const test=require('node:test'),assert=require('node:assert/strict');
const {select,discover}=require('../workbench/image-models.cjs');
const {ImageModelCatalogs}=require('../workbench/image-models.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');

test('Image selection compares versions numerically, prefers stable and excludes chat and retired models',()=>{
  assert.equal(select('openai',[{id:'gpt-image-1'},{id:'gpt-999-chat'},{id:'gpt-image-2.9'},{id:'gpt-image-2.10'},{id:'gpt-image-3-preview'}]),'gpt-image-2.10');
  assert.equal(select('openai',[{id:'gpt-image-2-mini'},{id:'gpt-image-2'}]),'gpt-image-2');
  assert.equal(select('openai',[{id:'chatgpt-image-latest'}]),'chatgpt-image-latest');
  assert.throws(()=>select('openai',[{id:'gpt-image-1'},{id:'gpt-6'}]),/No compatible/);
});

test('Gemini selection requires the supported generation method and handles the renamed recommended image family',()=>{
  const model=(id,methods=['generateContent'])=>({name:'models/'+id,supportedGenerationMethods:methods});
  assert.equal(select('gemini',[model('gemini-3.1-flash-image'),model('gemini-nano-banana-2.1'),model('gemini-99-chat'),model('imagen-99',['predict'])]),'gemini-nano-banana-2.1');
  assert.equal(select('gemini',[model('gemini-nano-banana-2.1'),model('gemini-nano-banana-2.2')]),'gemini-nano-banana-2.2');
  assert.equal(select('gemini',[model('gemini-3.1-flash-image'),model('gemini-3.2-flash-image')]),'gemini-3.2-flash-image');
  assert.throws(()=>select('gemini',[model('gemini-3-pro-image',['predict']),model('gemini-6-chat')]),/No compatible/);
});

test('Gemini catalog pagination keeps credentials in headers and uses only the configured origin',async()=>{
  const calls=[];
  const model=await discover({provider:'gemini',base:'https://fixture.invalid/v1beta',key:'fixture-key',signal:new AbortController().signal,request:async(url,options)=>{
    calls.push(url);assert.equal(new URL(url).origin,'https://fixture.invalid');assert(!url.includes('fixture-key'));assert.equal(options.headers['x-goog-api-key'],'fixture-key');assert.equal(options.redirect,'error');
    return Response.json(calls.length===1?{models:[],nextPageToken:'page/2'}:{models:[{name:'models/gemini-nano-banana-2.1',supportedGenerationMethods:['generateContent']}]});
  }});
  assert.equal(model,'gemini-nano-banana-2.1');assert.equal(calls.length,2);assert.equal(new URL(calls[1]).searchParams.get('pageToken'),'page/2');
});

test('Catalog authentication failures and oversized responses fail before choosing a model',async()=>{
  const input={provider:'openai',base:'https://fixture.invalid/v1',key:'fixture-key',signal:new AbortController().signal};
  await assert.rejects(discover({...input,request:async()=>new Response('denied',{status:401})}),/HTTP 401/);
  await assert.rejects(discover({...input,request:async()=>new Response(' '.repeat(2*1024*1024+1))}),/size limit/);
});

test('Image catalogs persist across restart, ignore age, isolate credentials and refresh only on request',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-image-catalog-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let calls=0,fail=false;
  const request=async()=>{calls++;return fail?new Response('{}',{status:401}):Response.json({data:[{id:calls>1?'gpt-image-3':'gpt-image-2.6-flare'}]});};
  const input={provider:'openai',base:'https://fixture.invalid/v1',key:'fixture-private-key',proxy:'inherit',request},catalog=new ImageModelCatalogs(directory);
  await catalog.request(input);assert.equal((await catalog.request(input)).cached,true);assert.equal(calls,1);
  for(const entry of Object.values(catalog.cache))entry.updatedAt=Date.now()-365*86400000;fs.writeFileSync(catalog.file,JSON.stringify(catalog.cache));
  const reopened=new ImageModelCatalogs(directory);assert.equal((await reopened.request(input)).model,'gpt-image-2.6-flare');assert.equal(calls,1);
  assert.equal((await reopened.request(input,{force:true})).model,'gpt-image-3');assert.equal(calls,2);
  fail=true;const retained=await reopened.request(input,{force:true});assert(retained.cached);assert.equal(retained.model,'gpt-image-3');assert(retained.warning.includes('401'));
  fail=false;await reopened.request({...input,key:'second-private-key'});assert.equal(calls,4);
  const saved=fs.readFileSync(catalog.file,'utf8');assert(!saved.includes('fixture-private-key'));assert(!saved.includes('second-private-key'));
});

test('Concurrent image catalog reads share one query',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-image-dedup-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let calls=0,release;
  const catalog=new ImageModelCatalogs(directory),input={provider:'openai',base:'https://fixture.invalid/v1',key:'fixture-key',request:()=>{calls++;return new Promise(resolve=>release=()=>resolve(Response.json({data:[{id:'gpt-image-2.6-flare'}]})));}};
  const a=catalog.request(input),b=catalog.request(input);release();assert.equal((await a).model,(await b).model);assert.equal(calls,1);
});
