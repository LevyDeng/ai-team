const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHistory,prepare,threshold}=require('../workbench/chat-context.cjs');
const {buildPrompt,Agents}=require('../workbench/agents.cjs');
const {Store}=require('../workbench/store.cjs');
const {createTools}=require('../workbench/mcp-tools.cjs');

function fixture(){
  const role={id:'agy',name:'Fixture agent',engine:'antigravity'},project={name:'Fixture project',directories:[{locationId:'local',path:'D:/Fixture'}]};
  const messages=Array.from({length:100},(_,i)=>({id:'old-'+i,kind:i%2?'assistant':'user',roleId:i%2?'peer':undefined,roleName:'Fixture peer',text:'Historical message '+i+' \u732b'.repeat(600),status:'complete'}));
  messages.push({id:'latest',kind:'user',text:'PAGED_CONTEXT_FIXTURE_LATEST: Review the latest request.',status:'accepted'});
  return {role,project,chat:{messages,relayReplies:true}};
}

test('Long Antigravity history keeps the latest task intact and every original message accessible',()=>{
  const f=fixture(),transfer=prepare(f.role,f.project,f.chat,false,buildPrompt);assert(transfer.history);assert(Buffer.byteLength(transfer.prompt)<threshold);assert(transfer.prompt.includes(f.chat.messages.at(-1).text));
  let offset=0,text='';while(true){const page=transfer.history.read({offset,maxBytes:517});assert(!page.text.includes('\ufffd'));text+=page.text;if(page.eof)break;assert(page.nextOffset>offset);offset=page.nextOffset;}
  const restored=JSON.parse(text);assert.equal(restored.length,f.chat.messages.length);assert.equal(restored[47].text,f.chat.messages[47].text);assert.equal(restored.at(-1).text,f.chat.messages.at(-1).text);
  f.chat.messages[0].text='Changed after snapshot';assert(transfer.history.read({search:'Historical message 0'}).text.includes('Historical message 0'));assert.equal(transfer.history.read({search:'Changed after snapshot'}).found,false);
});

test('Independent mode filters peers before exposing history; snapshots reject foreign scopes and support literal search',()=>{
  const f=fixture();f.chat.relayReplies=false;const transfer=prepare(f.role,f.project,f.chat,false,buildPrompt);
  const found=transfer.history.read({search:'Historical message 48'});assert(found.text.includes('Historical message 48'));assert(!transfer.history.read({search:'Historical message 47'}).found);
  assert.throws(()=>transfer.history.read({chatId:'other'}),/Invalid/);assert.throws(()=>transfer.history.read({offset:-1}),/range/);assert.throws(()=>transfer.history.read({maxBytes:100000}),/range/);
});

test('Small prompts and other agents retain existing behavior; an oversized latest request fails visibly',()=>{
  const f=fixture();const small={...f.chat,messages:f.chat.messages.slice(-1)};assert.equal(prepare(f.role,f.project,small,false,buildPrompt).prompt,buildPrompt(f.role,f.project,small,false));
  const other={...f.role,engine:'codex'};assert.equal(prepare(other,f.project,f.chat,false,buildPrompt).prompt,buildPrompt(other,f.project,f.chat,false));
  f.chat.messages.at(-1).text='x'.repeat(threshold+1);assert.throws(()=>prepare(f.role,f.project,f.chat,false,buildPrompt),/original message remains saved/);assert.equal(f.chat.messages.at(-1).text.length,threshold+1);
});

test('A history-only authenticated MCP bridge works without enabling SSH or skill execution',async t=>{
  const history=createHistory([{speaker:'User',text:'Fixture archived context'}]),bridge=await createTools({directories:[]},{},{},{history});t.after(()=>bridge.close());
  const rpc=async(method,params)=>{const response=await fetch(bridge.url,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return response.json();};
  const list=await rpc('tools/list');assert.deepEqual(list.result.tools.map(t=>t.name),['chat_history_read']);const result=await rpc('tools/call',{name:'chat_history_read',arguments:{offset:0}});assert(JSON.parse(result.result.content[0].text).text.includes('Fixture archived context'));
  const forbidden=await rpc('tools/call',{name:'chat_history_read',arguments:{path:'D:/other-account'}});assert(forbidden.result.isError);
});

test('The Antigravity role adapter sends a bounded prompt and exposes all long history to its ACP session',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-acp-context-'));t.after(()=>fs.promises.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const store=new Store(directory,directory),project=store.state.projects[0];project.directories=[{locationId:'local',path:directory}];
  const role=store.saveRole({...store.state.roles[0],engine:'antigravity',provider:'native',model:'fixture-model',permission:'workspace-write',allowLocationTools:false,executable:path.join(__dirname,'fixtures/acp-agent.cjs')});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  for(const m of fixture().chat.messages)store.message(chat.id,m);
  const agents=new Agents(store,{get:()=>''},{},()=>{});t.after(()=>agents.close());
  const message=await agents.run(chat.id,role,project,AbortSignal.timeout(20000));assert.equal(message.status,'complete',message.note);assert(message.text.includes('PAGED_CONTEXT_COMPLETE'));assert.equal(message.contextTransfer.mode,'paged');assert(message.contextTransfer.inlineBytes<threshold);
});
