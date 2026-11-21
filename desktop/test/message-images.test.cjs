const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {MessageImages,candidates,imagePath}=require('../workbench/message-images.cjs');

test('Historical CLI image outputs are recovered from successful copy destinations before temporary generated files',()=>{
  const message={text:'See [record](/D:/project/output/README.md).',activities:[{status:'complete',title:'Get-Item C:/profile/generated_images/task/source.png'},{status:'complete',title:'Copy-Item C:/profile/generated_images/task/source.png -Destination "D:/project/output with spaces/result.png"'},{status:'failed',title:'Copy-Item input.png -Destination D:/project/failed.png'},{status:'complete',title:'Get-Content D:/project/reference.png'}]};
  assert.deepEqual(candidates(message),['D:/project/output with spaces/result.png','C:/profile/generated_images/task/source.png']);
  assert.deepEqual(candidates({text:'![Preview](</D:/project/panel #1.png>)'}),['D:/project/panel #1.png']);
  for(const value of ['https://example.invalid/a.png','data:image/png;base64,test','//server/a.png','/tmp/remote.png','D:/script.exe','D:/vector.svg'])assert.equal(imagePath(value),null);
});

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-message-images-')),project={id:'project',directories:[{locationId:'local',path:root}]},chat={id:'chat',projectId:'project',messages:[]};let decodes=0;
  const store={get:(kind,id)=>{const item=(kind==='chats'?[chat]:[project]).find(x=>x.id===id);if(!item)throw new Error('Missing fixture');return item;}};
  const image={isEmpty:()=>false,getSize:()=>({width:1500,height:600}),resize:()=>image,toPNG:()=>Buffer.from('fixture-thumbnail')};
  const service=new MessageImages({store,nativeImage:{createFromBuffer:()=>{decodes++;return image;}}});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,chat,service,decodes:()=>decodes};
}

test('Image previews deduplicate identical files, cache unchanged images and keep image bytes out of saved history',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'output.png'),'fixture-image');fs.writeFileSync(path.join(f.root,'copy.png'),'fixture-image');
  const message={id:'message',kind:'assistant',text:'![Result](output.png) ![Copy](copy.png)'};f.chat.messages.push(message);
  const files=await f.service.list('chat','message');assert.equal(files.length,1);assert.equal(files[0].width,1500);assert(files[0].thumbnail.startsWith('data:image/png;base64,'));assert(!('digest'in files[0]));assert(!JSON.stringify(message).includes('base64'));
  const count=f.decodes();await f.service.list('chat','message');assert.equal(f.decodes(),count);
  fs.writeFileSync(path.join(f.root,'output.png'),'changed-fixture-image');await f.service.list('chat','message');assert(f.decodes()>count);
});

test('Previews allow explicit files outside the root, retain missing paths and never resolve a remote image URL',async t=>{
  const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'relay-explicit-image-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));const filename=path.join(outside,'outside.png');fs.writeFileSync(filename,'fixture');
  f.chat.messages.push({id:'message',kind:'assistant',imagePaths:[filename],text:'![Remote](https://fixture.invalid/remote.png) ![Missing](missing.png)'});
  const files=await f.service.list('chat','message');assert.equal(files.length,2);assert.equal(files[0].path,filename);assert.equal(files[1].path,path.join(f.root,'missing.png'));assert(files[1].warning);assert(!files[1].thumbnail);await assert.rejects(f.service.list('chat','not-owned'),/not found/);
});

test('Oversized images remain openable without being decoded for a preview',async t=>{
  const f=fixture(t),filename=path.join(f.root,'large.png'),fd=fs.openSync(filename,'w');fs.ftruncateSync(fd,24*1024*1024+1);fs.closeSync(fd);
  f.chat.messages.push({id:'large',kind:'assistant',text:'![Large](large.png)'});const files=await f.service.list('chat','large');assert.equal(files.length,1);assert(files[0].warning);assert(!files[0].thumbnail);assert.equal(f.decodes(),0);
});
