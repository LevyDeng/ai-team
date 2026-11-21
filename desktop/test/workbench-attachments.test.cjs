const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Store}=require('../workbench/store.cjs');
const {Attachments,maxFileBytes}=require('../workbench/attachments.cjs');
const {messageText}=require('../workbench/attachment-text.js');
const {buildPrompt}=require('../workbench/agents.cjs');
const {historyFor}=require('../workbench/conversations.cjs');
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-attachments-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const store=new Store(directory,directory),manager=new Attachments(store),project=store.state.projects[0],role=store.state.roles[0];
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]}),other=store.createChat({projectId:project.id,roleIds:[role.id]});
  const file=(name='fixture notes.md',text='Fixture content')=>{const filename=path.join(directory,name);fs.writeFileSync(filename,text);return filename;};
  return {directory,store,manager,project,role,chat,other,file};
}
test('File metadata is staged separately from typed text and persists per chat across restart',t=>{
  const f=fixture(t),filename=f.file('notes-` @agent-\u6d4b\u8bd5.md');f.chat.draft='Typed draft';
  const files=f.manager.add(f.chat.id,[filename]);assert.equal(files.length,1);assert.equal(files[0].name,path.basename(filename));assert.equal(files[0].path,filename);assert.equal(f.chat.draft,'Typed draft');
  assert.deepEqual(f.manager.files(f.other.id),[]);assert.equal(f.manager.add(f.chat.id,[filename]).length,1);
  const loaded=new Store(f.directory,f.directory);assert.equal(loaded.get('chats',f.chat.id).draftAttachments[0].id,files[0].id);assert.equal(loaded.get('chats',f.chat.id).draft,'Typed draft');
});
test('Capacity, folder and invalid-file failures are atomic and preserve the draft',t=>{
  const f=fixture(t);f.chat.draft='Keep this';f.manager.add(f.chat.id,[f.file()]);const before=structuredClone(f.chat.draftAttachments);
  for(const paths of [[f.file('another.md'),path.join(f.directory,'missing.md')],[f.directory],['relative.md'],Array(9).fill(f.file('many.md'))])assert.throws(()=>f.manager.add(f.chat.id,paths));
  const huge=f.file('huge.bin','');fs.truncateSync(huge,maxFileBytes+1);assert.throws(()=>f.manager.add(f.chat.id,[huge]),/16 MiB/);assert.deepEqual(f.chat.draftAttachments,before);assert.equal(f.chat.draft,'Keep this');
  const atLimit=Array.from({length:7},(_,i)=>f.file('small-'+i+'.md'));f.manager.add(f.chat.id,atLimit);assert.throws(()=>f.manager.add(f.chat.id,[f.file('ninth.md')]),/8 files/);assert.equal(f.chat.draftAttachments.length,8);
});
test('Total byte limit applies across multiple attachment batches without reading file contents',t=>{
  const f=fixture(t),paths=Array.from({length:3},(_,i)=>{const file=f.file('large-'+i+'.bin','');fs.truncateSync(file,maxFileBytes);return file;});
  f.manager.add(f.chat.id,paths.slice(0,2));assert.throws(()=>f.manager.add(f.chat.id,paths.slice(2)),/32 MiB/);assert.equal(f.chat.draftAttachments.length,2);
});
test('Submitted IDs are scoped to their chat; changed and missing files are rejected without clearing anything',t=>{
  const f=fixture(t),filename=f.file(),files=f.manager.add(f.chat.id,[filename]);assert.throws(()=>f.manager.select(f.other.id,[files[0].id]),/expired/);assert.throws(()=>f.manager.select(f.chat.id,[files[0].id,files[0].id]),/Invalid/);
  const selected=f.manager.select(f.chat.id,[files[0].id]);assert.notEqual(selected[0],files[0]);fs.writeFileSync(filename,'Changed fixture data');assert.throws(()=>f.manager.select(f.chat.id,[files[0].id]),/changed/);assert.equal(f.manager.files(f.chat.id).length,1);
  fs.unlinkSync(filename);assert.throws(()=>f.manager.select(f.chat.id,[files[0].id]),/unavailable/);assert.equal(f.manager.files(f.chat.id).length,1);
});
test('Accepting one snapshot consumes only its files and leaves newer staged attachments untouched',t=>{
  const f=fixture(t),files=f.manager.add(f.chat.id,[f.file()]),sent=f.manager.select(f.chat.id,[files[0].id]);
  f.manager.add(f.chat.id,[f.file('later.md')]);f.manager.consume(f.chat.id,sent);assert.equal(f.manager.files(f.chat.id).length,1);assert.equal(f.manager.files(f.chat.id)[0].name,'later.md');
  f.manager.remove(f.chat.id,f.manager.files(f.chat.id)[0].id);assert.equal(f.manager.files(f.chat.id).length,0);
});
test('Attachment-only messages remain in agent history, including location paths but excluding image bytes',t=>{
  const f=fixture(t),files=f.manager.add(f.chat.id,[f.file()]);const message={kind:'user',text:'',attachments:files,status:'accepted'};f.chat.messages.push(message);
  assert.equal(historyFor(f.chat,f.role).length,1);const text=messageText(message);assert(text.includes('not uploaded'));assert(text.includes(files[0].name));
  const prompt=buildPrompt(f.role,f.project,f.chat);assert(prompt.includes(files[0].name));assert(!prompt.includes('Fixture content'));
  assert(!messageText({...message,attachments:[{...files[0],thumbnail:'PRIVATE_IMAGE_BYTES'}]}).includes('PRIVATE_IMAGE_BYTES'));
});
test('Restoring a sent message restores text and file cards with fresh IDs; missing files do not erase the text',t=>{
  const f=fixture(t),filename=f.file(),files=f.manager.add(f.chat.id,[filename]),message=f.store.message(f.chat.id,{kind:'user',text:'Original request',attachments:structuredClone(files),status:'accepted'});
  f.manager.consume(f.chat.id,files);fs.unlinkSync(filename);const restored=f.manager.restore(f.chat.id,message.id);assert.equal(restored.text,'Original request');assert.equal(restored.attachments.length,1);assert.notEqual(restored.attachments[0].id,files[0].id);assert.throws(()=>f.manager.select(f.chat.id,[restored.attachments[0].id]));assert.equal(f.chat.draft,'Original request');
});
test('Clipboard image drafts retain normalized thumbnails and protect their cache file during cleanup',t=>{
  const f=fixture(t),filename=f.file('clipboard.png','fixture-image'),image={path:filename,kind:'clipboard-image',width:100,height:80,format:'PNG',thumbnail:'data:image/png;base64,Zml4dHVyZQ=='};
  const files=f.manager.add(f.chat.id,[filename],image);assert.equal(files[0].kind,'clipboard-image');assert.equal(files[0].width,100);assert.equal(files[0].thumbnail,image.thumbnail);assert(f.manager.protectedPaths().has(filename));f.manager.remove(f.chat.id,files[0].id);assert(!f.manager.protectedPaths().has(filename));
});
