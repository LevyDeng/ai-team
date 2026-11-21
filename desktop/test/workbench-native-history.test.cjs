const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {NativeHistory,displayEvent}=require('../workbench/native-history.cjs');
test('Codex discovers only the exact per-process originator, never the latest unrelated desktop session',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-native-tail-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const today=new Date(),folder=path.join(root,'sessions',String(today.getFullYear()),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0'));fs.mkdirSync(folder,{recursive:true});
  const meta=originator=>JSON.stringify({type:'session_meta',payload:{originator}})+'\n';
  fs.writeFileSync(path.join(folder,'rollout-other.jsonl'),meta('desktop-other')+JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'WRONG_SESSION'}})+'\n');
  const file=path.join(folder,'rollout-owned.jsonl');fs.writeFileSync(file,meta('relay_owned')+JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'OWNED_REPLY'}})+'\n');
  const rows=[],tail=new NativeHistory({engine:'codex',root,originator:'relay_owned',event:row=>rows.push(row)});tail.poll();assert.equal(tail.file,file);assert.equal(rows.length,2);assert(!JSON.stringify(rows).includes('WRONG_SESSION'));tail.poll();assert.equal(rows.length,2);
});
test('Public transcript parsing excludes compaction, tool results, commands and reasoning',()=>{
  for(const row of [{type:'user',isMeta:true,message:{content:'meta'}},{type:'user',isCompactSummary:true,message:{content:'summary'}},{type:'user',message:{content:[{type:'tool_result',content:'tool'}]}},{type:'user',message:{content:'<local-command-stdout>status'}},{type:'assistant',message:{content:[{type:'thinking',thinking:'private'}]}}])assert(!displayEvent('claude',row)?.text);
  assert.equal(displayEvent('claude',{type:'system',subtype:'turn_duration'}).state,'completed');assert.equal(displayEvent('codex',{type:'event_msg',payload:{type:'task_complete'}}).state,'completed');
});
