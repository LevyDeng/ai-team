const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {Store}=require('../workbench/store.cjs');
const {readSkillAvailability}=require('../workbench/workspace-db.cjs');
const {Skills,parseCommand}=require('../workbench/skills.cjs');
const {createTools}=require('../workbench/mcp-tools.cjs');
const {expose,route}=require('../reverse-routes.cjs');
function fixture(t,request){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-skills-')),store=new Store(directory,directory),keys=new Map(),vault={has:id=>keys.has(id),get:id=>keys.get(id)||'',set:(id,value)=>keys.set(id,value),remove:id=>keys.delete(id)},events=[];
  const pixels=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c/eUAAAAASUVORK5CYII=','base64');
  const image={isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>pixels,toJPEG:()=>pixels,resize:()=>image};
  const service=new Skills({store,vault,fetch:request||(async()=>new Response(JSON.stringify({data:[{b64_json:pixels.toString('base64')}]}))),nativeImage:{createFromBuffer:()=>image},emit:event=>events.push(event)});
  const project=store.state.projects[0],chat=store.createChat({projectId:project.id,roleIds:[store.state.roles[0].id]});
  t.after(()=>{service.close();store.save();fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const prompt=()=>service.save({name:'Review',command:'review',kind:'prompt',enabled:true,instructions:'Review the current request and list concrete issues.'});
  return {directory,store,vault,service,chat,project,keys,events,pixels,prompt};
}
test('Global skill definitions persist without plaintext keys, and commands cannot collide',t=>{
  const f=fixture(t),image=f.service.list()[0];assert.equal(image.ready,false);const saved=f.service.save({...f.service.read(image.id),model:'fixture-image',apiKey:'fixture-secret-key'});
  assert(saved.ready);assert(!JSON.stringify(saved).includes('fixture-secret-key'));assert(!fs.readFileSync(f.store.file,'utf8').includes('fixture-secret-key'));
  assert(!fs.readFileSync(path.join(f.service.root,saved.id,'SKILL.md'),'utf8').includes('fixture-secret-key'));
  assert.throws(()=>f.service.save({...f.service.read(saved.id),instructions:'Do not embed fixture-secret-key'}),/credential/);
  const loaded=new Skills({store:f.store,vault:f.vault,nativeImage:{}});assert.equal(loaded.list().length,2);assert.equal(loaded.list()[0].ready,true);
  assert.throws(()=>f.service.save({name:'Image',command:'image',kind:'prompt',instructions:'Duplicate'}),/already used/);
  f.service.save({...f.service.read(saved.id),clearKey:true});assert.equal(f.service.list()[0].hasKey,false);
});
test('A skill toggle preserves its definition and blocks a running executor with an older workspace snapshot', async t => {
  const f = fixture(t);
  const skill = f.prompt();
  const filename = path.join(f.service.root, skill.id, 'SKILL.md');
  fs.utimesSync(filename, new Date(1000000), new Date(1000000));
  const original = fs.readFileSync(filename);
  const originalMtime = fs.statSync(filename).mtimeMs;
  const executor = new Skills({
    store: { directory: f.directory, state: structuredClone(f.store.state) },
    vault: f.vault, nativeImage: {}, readAvailability: () => readSkillAvailability(f.store.file),
  });
  t.after(() => executor.close());
  const scope = executor.scope(f.chat.id, 'fixture-role', 'fixture-task');
  assert.equal((await executor.call(scope, 'skill_read', { skill: skill.command })).command, skill.command);
  f.service.setEnabled(skill.id, false);
  assert.deepEqual(fs.readFileSync(filename), original);
  assert.equal(fs.statSync(filename).mtimeMs, originalMtime);
  assert.throws(() => parseCommand('/review Example', f.service.list(), { rejectDisabled: true }), /已停用/);
  assert(!executor.tools().some(tool => tool.inputSchema.properties.skill?.enum.includes(skill.command)));
  await assert.rejects(executor.call(scope, 'skill_run', { skill: skill.command, prompt: 'Example' }), /unavailable/);
  f.service.setEnabled(skill.id, true);
  assert.equal((await executor.call(scope, 'skill_read', { skill: skill.command })).command, skill.command);
});

test('Each user task shares the three-call budget across roles and rounds; read is free, recursion is blocked',async t=>{
  const f=fixture(t),skill=f.prompt();const a=f.service.scope(f.chat.id,'first','task'),b=f.service.scope(f.chat.id,'second','task');
  for(let n=0;n<6;n++)await f.service.call(a,'skill_read',{skill:skill.command});
  for(const scope of [a,b,a])await f.service.call(scope,'skill_run',{skill:skill.command,prompt:'Review fixture'});
  await assert.rejects(f.service.call(b,'skill_run',{skill:skill.command,prompt:'Fourth call'}),/3/);
  await assert.rejects(f.service.call({...a,depth:1},'skill_run',{skill:skill.command,prompt:'Nested'}),/Nested/);
  await assert.rejects(f.service.call(a,'skill_run',{skill:skill.command,prompt:'Override',depth:0}),/Invalid/);
  assert.equal(f.chat.messages.filter(m=>m.kind==='skill').length,3);
});
test('Request IDs deduplicate uncertain retries without reexecuting or refunding a failed paid attempt',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return new Response('{}',{status:401});}),image=f.service.list()[0];f.service.save({...f.service.read(image.id),model:'fixture-image',apiKey:'fixture-key'});const scope=f.service.scope(f.chat.id,'first','retry-task');
  const first=f.service.run(scope,image.id,'Draw a fixture','request-1');await assert.rejects(first,/401/);await assert.rejects(f.service.run(scope,image.id,'Draw a fixture','request-1'),/401/);assert.equal(calls,1);assert.equal(f.service.begin(scope.taskId).used,1);
  assert.throws(()=>f.service.run(scope,image.id,'Different request','request-1'),/different request/);assert.equal(f.chat.messages.at(-1).status,'failed');
});
test('Image generation uses App-side credentials and persists a result card and local image, not image bytes in tool results',async t=>{
  const f=fixture(t),image=f.service.list()[0],calls=[];f.service.save({...f.service.read(image.id),model:'fixture-image',apiKey:'fixture-private-key',baseUrl:'https://fixture.invalid/v1'});
  f.service.request=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({data:[{b64_json:f.pixels.toString('base64')}]}));};
  const result=await f.service.run(f.service.scope(f.chat.id,'fixture-role','image-task'),image.id,'A quiet forest');assert.equal(calls[0].url,'https://fixture.invalid/v1/images/generations');assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-private-key');assert.equal(JSON.parse(calls[0].options.body).n,1);assert(fs.existsSync(result.files[0].path));assert.equal(f.chat.messages.at(-1).status,'complete');assert(f.chat.messages.at(-1).files[0].thumbnail);assert(!JSON.stringify(result).includes('fixture-private-key'));
  assert(!JSON.stringify(result).includes('base64'));
});
test('Gemini uses its native key header and inline image response without exposing credentials',async t=>{
  const f=fixture(t),image=f.service.list()[0];f.service.save({...f.service.read(image.id),provider:'gemini',baseUrl:'https://fixture.invalid/v1beta',model:'fixture-image',apiKey:'fixture-gemini-key'});
  f.service.request=async(url,options)=>{assert.equal(url,'https://fixture.invalid/v1beta/models/fixture-image:generateContent');assert.equal(options.headers['x-goog-api-key'],'fixture-gemini-key');assert(!url.includes('key='));assert.deepEqual(JSON.parse(options.body).generationConfig.responseModalities,['TEXT','IMAGE']);return new Response(JSON.stringify({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:f.pixels.toString('base64')}}]}}]}));};
  const result=await f.service.run(f.service.scope(f.chat.id,'role','gemini-task'),image.id,'Fixture image');assert(fs.existsSync(result.files[0].path));
});

test('Blank image model queries the catalog and records the selected model before a single generation',async t=>{
  const f=fixture(t),image=f.service.list()[0],calls=[];f.service.save({...f.service.read(image.id),model:'',apiKey:'fixture-auto-key'});
  assert(f.service.list()[0].ready);
  f.service.request=async(url,options)=>{
    calls.push(url);assert.equal(options.headers.Authorization,'Bearer fixture-auto-key');
    if(url.endsWith('/models'))return Response.json({data:[{id:'gpt-99-chat'},{id:'gpt-image-2.5-flare'},{id:'gpt-image-2.6-flare'}]});
    assert.equal(JSON.parse(options.body).model,'gpt-image-2.6-flare');assert.equal(f.chat.messages.at(-1).model,'gpt-image-2.6-flare');
    return Response.json({data:[{b64_json:f.pixels.toString('base64')}]});
  };
  const result=await f.service.run(f.service.scope(f.chat.id,'role','auto-task'),image.id,'A fixture image');
  assert.equal(calls.length,2);assert.equal(result.model,'gpt-image-2.6-flare');assert.equal(f.chat.messages.at(-1).model,result.model);assert.equal(f.service.get(image.id).model,'');
});

test('Failed catalog discovery never sends a speculative paid generation',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return Response.json({data:[{id:'gpt-99-chat'}]});}),image=f.service.list()[0];
  f.service.save({...f.service.read(image.id),model:'',apiKey:'fixture-auto-key'});
  await assert.rejects(f.service.run(f.service.scope(f.chat.id,'role','auto-failure'),image.id,'A fixture image'),/No compatible/);assert.equal(calls,1);assert.equal(f.chat.messages.at(-1).status,'failed');
});

test('Provider quota diagnostics persist in the failed skill card without leaking its key or retrying',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return Response.json({error:{code:'insufficient_quota',type:'insufficient_quota',message:'No balance for fixture-private-key'}},{status:429,headers:{'x-request-id':'fixture-quota-request'}});}),image=f.service.list()[0];
  f.service.save({...f.service.read(image.id),model:'fixture-image',apiKey:'fixture-private-key'});
  await assert.rejects(f.service.run(f.service.scope(f.chat.id,'role','quota-task'),image.id,'Fixture image'),/insufficient_quota/);
  assert.equal(calls,1);const message=f.chat.messages.at(-1);assert.equal(message.apiError.category,'quota');assert.equal(message.apiError.requestId,'fixture-quota-request');assert(!JSON.stringify(message).includes('fixture-private-key'));assert.equal(message.status,'failed');
});
test('Cancellation aborts only the matching chat task and preserves its request and status',async t=>{
  const f=fixture(t),image=f.service.list()[0];f.service.save({...f.service.read(image.id),model:'fixture',apiKey:'fixture-key'});f.service.request=async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Fixture aborted.'))));
  const result=f.service.run(f.service.scope(f.chat.id,'role','cancel-task'),image.id,'Keep this request');const id=f.chat.messages.at(-1).id;f.service.cancel('other-chat',id);assert.equal(f.service.jobs.size,1);f.service.cancel(f.chat.id,id);await assert.rejects(result,/取消/);assert.equal(f.chat.messages.at(-1).status,'cancelled');assert.equal(f.chat.messages.at(-1).request,'Keep this request');assert.equal(f.service.jobs.size,0);
});
test('Slash invocation is explicit and global; disabled skills and incidental text never execute',t=>{
  const f=fixture(t),list=f.service.list();assert.equal(parseCommand('/image forest',list).skill.id,list[0].id);assert.equal(parseCommand('/'+list[0].name+' forest',list).prompt,'forest');
  for(const text of ['Please discuss /image','`/image forest`','@image forest','/missing forest'])assert.equal(parseCommand(text,list),null);assert.equal(parseCommand('/image forest',list.map(s=>({...s,enabled:false}))),null);
});
test('Authenticated local and reverse-forwarded MCP expose skills even without SSH project tools',async t=>{
  const f=fixture(t),skill=f.prompt(),scope=f.service.scope(f.chat.id,'role','mcp-task');const bridge=await createTools({...f.project,directories:[]},f.store,{}, {service:f.service,scope});t.after(()=>bridge.close());
  const rpc=async(url,token,method,params)=>{const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return response.json();};
  const list=await rpc(bridge.url,bridge.token,'tools/list');assert.deepEqual(list.result.tools.map(t=>t.name),['skill_read','skill_run','skill_handoff_targets','skill_handoff_prepare']);
  const read=await rpc(bridge.url,bridge.token,'tools/call',{name:'skill_read',arguments:{skill:skill.command}});assert(JSON.parse(read.result.content[0].text).instructions.includes('concrete issues'));
  const bad=await fetch(bridge.url,{method:'POST',headers:{Authorization:'Bearer wrong'},body:'{}'});assert.equal(bad.status,403);
  let server;const client={forwardIn:(host,port,callback)=>{assert.equal(host,'127.0.0.1');assert.equal(port,0);server=net.createServer(socket=>{const details={destIP:'127.0.0.1',destPort:server.address().port};if(!route(client,details,()=>socket,()=>socket.destroy()))socket.destroy();});server.listen(0,'127.0.0.1',()=>callback(null,server.address().port));},unforwardIn:(_host,_port,callback)=>server.close(callback)};
  const forwarded=await expose(client,bridge);t.after(()=>{forwarded.close();server.closeAllConnections?.();});const result=await rpc(forwarded.url,forwarded.token,'tools/call',{name:'skill_run',arguments:{skill:skill.command,prompt:'Review fixture'}});assert(!result.result.isError);assert.equal(f.service.begin('mcp-task').used,1);assert.equal(route(client,{destPort:1},()=>assert.fail(),()=>assert.fail()),false);
});

test('Handoff prepares one review card for selected recipients without writing to the destination',async t=>{
  const f=fixture(t),[first,second]=f.store.state.roles;
  const target=f.store.createChat({projectId:f.project.id,name:'Animation',roleIds:[first.id,second.id]});
  f.store.message(target.id,{kind:'user',status:'accepted',text:'Private destination history'});
  const closed=f.store.createChat({projectId:f.project.id,name:'Animation archive',roleIds:[first.id]});
  closed.disbandedAt=Date.now();
  const scope=f.service.scope(f.chat.id,first.id,'handoff-task');
  const skill=parseCommand('/handoff Review animation',f.service.list()).skill;
  const instructions=await f.service.call(scope,'skill_read',{skill:skill.command});
  assert.match(instructions.instructions,/skill_handoff_prepare/);
  const results=await f.service.call(scope,'skill_handoff_targets',{query:'animation'});
  assert.deepEqual(results.targets.map(chat=>chat.chatId),[target.id]);
  assert.equal(results.targets[0].recipients.length,2);
  assert.doesNotMatch(JSON.stringify(results),/Private destination history/);
  const args={targetChatId:target.id,recipientIds:[second.id],prompt:'Verify the animation changes against the approved reference.',requestId:'verify-animation'};
  await assert.rejects(f.service.call(scope,'skill_handoff_prepare',{...args,recipientIds:['missing-role']}));
  await assert.rejects(f.service.call(scope,'skill_handoff_prepare',{...args,targetChatId:f.chat.id}));
  await assert.rejects(f.service.call(scope,'skill_handoff_prepare',{...args,targetChatId:closed.id}));
  target.draft='Existing draft';
  const bridge=await createTools({...f.project,directories:[]},f.store,{}, {service:f.service,scope});
  t.after(()=>bridge.close());
  const response=await fetch(bridge.url,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'skill_handoff_prepare',arguments:args}})});
  const {result}=await response.json();
  assert.equal(result.isError,undefined);
  const prepared=JSON.parse(result.content[0].text);
  assert.equal(prepared.status,'ready_for_review');
  assert.equal(prepared.budget.used,1);
  assert.deepEqual(prepared.recipientIds,[second.id]);
  assert.equal(target.draft,'Existing draft');
  assert.equal(target.messages.length,1);
  assert.deepEqual(await f.service.call(scope,'skill_handoff_prepare',args),prepared);
  assert.equal(f.chat.messages.length,1);
  assert.equal(f.chat.messages[0].request,args.prompt);
  f.service.save({...f.service.read(skill.id),enabled:false});
  assert(!f.service.tools().some(tool=>tool.name==='skill_handoff_prepare'));
  await assert.rejects(f.service.call(scope,'skill_handoff_prepare',args),/Enable/);
});

function systemChoices(service, overrides) {
  return Object.fromEntries(service.system.sources().map(source => [source.id, { ...source, ...overrides[source.id] }]));
}

test('Local system skill sources honor invocation flags, preserve built-in commands and remember switches',async t=>{
  const f=fixture(t);
  const codex=path.join(f.directory,'codex');
  const claude=path.join(f.directory,'claude');
  const write=(root,folder,markdown)=>{
    const directory=path.join(root,folder);
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'SKILL.md'),markdown,'utf8');
  };
  write(path.join(codex,'.system'),'review','---\nname: Review\ndescription: >-\n  A folded\n  description.\n---\n\nSystem review instructions.');
  write(claude,'manual','---\ndisable-model-invocation: true\n---\nManual instructions.');
  write(claude,'background','---\nuser-invocable: false\n---\nBackground instructions.');
  const directories={codex:[codex,path.join(codex,'.system')],claude:[claude]};
  f.service.system.directories=directories;
  f.service.save({name:'Custom-review',command:'co-review',kind:'prompt',instructions:'Custom instructions.'});
  assert.equal(f.service.list().filter(skill=>skill.source).length,0);
  await f.service.system.saveSources(systemChoices(f.service,{codex:{enabled:true},claude:{enabled:true}}));
  const external=f.service.list().filter(skill=>skill.source);
  assert.equal(external.length,3);
  const review=external.find(skill=>skill.source==='codex');
  assert.equal(review.command,'co-review-2');
  assert.equal(review.description,'A folded description.');
  assert.equal(parseCommand('/co-review-2 Inspect this',f.service.list()).skill.id,review.id);
  assert.equal(parseCommand('/cl-background',f.service.list()),null);
  assert.equal(parseCommand('/cl-manual',f.service.list()).skill.modelInvocable,false);
  const scope=f.service.scope(f.chat.id,'fixture-role','system-skill');
  const instructions=await f.service.call(scope,'skill_read',{skill:review.command});
  assert.match(instructions.instructions,/Windows machine/);
  assert.match(instructions.instructions,/System review instructions/);
  await assert.rejects(f.service.call(scope,'skill_read',{skill:'cl-manual'}),/unavailable/);
  assert.match((await f.service.call(scope,'skill_read',{skill:'cl-background'})).instructions,/Background instructions/);
  assert.throws(()=>f.service.save({...review,instructions:'Changed'}),/Only ai-team skills/);
  assert.throws(()=>f.service.remove(review.id),/managed at their source/);
  f.service.system.setEnabled(review,false);
  await f.service.system.saveSources(systemChoices(f.service,{codex:{enabled:false}}));
  assert(!f.service.list().some(skill=>skill.source==='codex'));
  const reloaded=new Skills({store:new Store(f.directory,f.directory),vault:f.vault,systemDirectories:directories});
  await reloaded.system.saveSources(systemChoices(reloaded,{codex:{enabled:true}}));
  assert.equal(reloaded.get(review.id).enabled,false);
  assert.equal(reloaded.read(review.id).instructions,'System review instructions.');
});

test('System skill sources replace their location, preserve per-location switches and validate prefixes',async t=>{
  const f=fixture(t);
  const local=path.join(f.directory,'local-claude','review');
  fs.mkdirSync(local,{recursive:true});
  fs.writeFileSync(path.join(local,'SKILL.md'),'Local instructions.');
  const server={id:'fixture-vps',name:'Fixture VPS',type:'ssh',os:'linux',managed:true};
  f.store.state.locations.push(server);
  f.store.state.settings.systemSkillSources={claude:true};
  const remoteBody=Buffer.from('---\nname: VPS review\n---\nRemote instructions with \u4e2d.').toString('base64');
  const connections=[];
  let fail=false;
  const service=new Skills({store:f.store,vault:f.vault,systemDirectories:{claude:[path.dirname(local)]},
    locations:{async readSkillCatalog(id,command){
      connections.push({id,command});
      if(fail)throw new Error('VPS is offline.');
      return JSON.stringify([{name:'review',folder:'/home/test/skills/review',runtimeFolder:'/home/claude/state/skills/review',contents:remoteBody}]);
    }}});
  assert.deepEqual(service.system.sources().map(source=>source.prefix),['co','cl','ds','ag']);
  const original=service.list().find(skill=>skill.source==='claude');
  assert.equal(service.read(original.id).instructions,'Local instructions.');
  assert.equal(connections.length,0);
  service.system.setEnabled(original,false);
  await assert.rejects(service.system.saveSources(systemChoices(service,{claude:{locationId:['local',server.id]}})),/Choose one location/);
  await assert.rejects(service.system.saveSources(systemChoices(service,{codex:{enabled:true,prefix:'cl'}})),/distinct/);
  await service.system.saveSources(systemChoices(service,{claude:{locationId:server.id,prefix:'review'}}));
  assert.equal(connections[0].id,server.id);
  assert.match(connections[0].command,/python3 -c/);
  const remote=service.list().filter(skill=>skill.source==='claude');
  assert.deepEqual(remote.map(skill=>skill.command),['review-review']);
  assert.notEqual(remote[0].id,original.id);
  assert.equal(remote[0].enabled,true);
  assert.match(service.instructions(remote[0].id),/\/home\/claude\/state\/skills\/review inside the managed agent/);
  assert.match(service.instructions(remote[0].id),/Remote instructions with \u4e2d/);
  fail=true;
  await service.system.refresh();
  assert.equal(service.system.sources().find(source=>source.id==='claude').error,'VPS is offline.');
  assert.equal(service.get(remote[0].id).id,remote[0].id);
  await service.system.saveSources(systemChoices(service,{claude:{locationId:'local'}}));
  assert.equal(service.get(original.id).enabled,false);
  assert.throws(()=>service.get(remote[0].id),/not found/);
});
