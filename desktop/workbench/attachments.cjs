const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const maxFiles=8,maxFileBytes=16*1024*1024,maxBatchBytes=32*1024*1024;
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function inspect(filename){
  if(typeof filename!=='string'||!path.isAbsolute(filename)||filename.length>4096||/[\x00-\x1f]/.test(filename))throw new Error('Choose a readable local file path.');
  let info;try{info=fs.statSync(filename);}catch{throw new Error('The attached file is unavailable. Remove it and add it again.');}
  if(!info.isFile())throw new Error('Only files can be attached; folders are not supported.');
  if(info.size>maxFileBytes)throw new Error('Each attachment must be at most 16 MiB.');
  return {path:path.resolve(filename),name:path.basename(filename),sizeBytes:info.size,modifiedAt:info.mtimeMs};
}
function capacity(files){if(files.length>maxFiles)throw new Error('Attach at most 8 files per message.');if(files.reduce((sum,file)=>sum+file.sizeBytes,0)>maxBatchBytes)throw new Error('Attachments must total at most 32 MiB.');}
class Attachments{
  constructor(store){this.store=store;}
  files(chatId){return this.store.get('chats',chatId).draftAttachments||[];}
  protectedPaths(){return new Set(this.store.state.chats.flatMap(chat=>[...(chat.draftAttachments||[]),...(chat.inputQueue||[]).flatMap(entry=>entry.value.files||[])].filter(file=>file.kind==='clipboard-image').map(file=>file.path)));}
  add(chatId,paths,image){
    const chat=this.store.get('chats',chatId),current=chat.draftAttachments||[];
    if(!Array.isArray(paths)||paths.length>maxFiles)throw new Error('Attach at most 8 files per message.');
    const next=[...current];
    for(const filename of paths){const file=inspect(filename);if(next.some(existing=>samePath(existing.path,file.path)))continue;
      const entry={...file,id:crypto.randomUUID(),kind:'file'};
      if(image&&image.path===filename){entry.kind='clipboard-image';for(const key of ['width','height','format','thumbnail'])entry[key]=image[key];}
      next.push(entry);
    }
    capacity(next);chat.draftAttachments=next;this.store.save();return next;
  }
  remove(chatId,id){const chat=this.store.get('chats',chatId);chat.draftAttachments=this.files(chatId).filter(file=>file.id!==id);this.store.save();return chat.draftAttachments;}
  select(chatId,ids=[]){
    if(!Array.isArray(ids)||ids.length>maxFiles||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error('Invalid attachment references.');
    const files=ids.map(id=>this.files(chatId).find(file=>file.id===id));if(files.some(file=>!file))throw new Error('Attachment references expired. Add the files again.');
    return this.validate(files);
  }
  validate(files){for(const file of files){const info=inspect(file.path);if(info.sizeBytes!==file.sizeBytes||info.modifiedAt!==file.modifiedAt)throw new Error('The attached file changed. Remove it and add it again.');}capacity(files);return structuredClone(files);}
  consume(chatId,files){const chat=this.store.get('chats',chatId),ids=new Set(files.map(file=>file.id));chat.draftAttachments=this.files(chatId).filter(file=>!ids.has(file.id));}
  restore(chatId,messageId){
    const chat=this.store.get('chats',chatId),message=chat.messages.find(m=>m.id===messageId&&m.kind==='user');if(!message)throw new Error('The original user message is unavailable.');
    chat.draft=message.text||'';chat.draftAttachments=(message.attachments||[]).map(file=>({...file,id:crypto.randomUUID()}));this.store.save();return {text:chat.draft,attachments:chat.draftAttachments};
  }
}
module.exports={Attachments,inspect,maxFiles,maxFileBytes,maxBatchBytes};
