const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const paths=require('../path-links.js');
const {readMessageDetail}=require('./workspace-db.cjs');
const imageExtension=/\.(?:png|jpe?g|webp|gif|bmp)$/i;

function imagePath(value,encoded=false){
  try{const name=paths.normalize(value,{encoded});return imageExtension.test(name)&&!/^[/\\]/.test(name)?name:null;}catch{return null;}
}
function imageLinks(text){return paths.links(String(text||'')).filter(link=>link.kind==='local').map(link=>imagePath(link.value)).filter(Boolean);}
function candidates(message){
  const result=[];
  const add=value=>{const name=imagePath(value);if(name&&!result.some(p=>p.toLowerCase()===name.toLowerCase()))result.push(name);};
  for(const value of message.imagePaths||[])add(value);
  for(const value of imageLinks(message.text))add(value);
  for(const item of message.activities||[]){
    if(item.status!=='complete')continue;
    const title=item.title||'';
    // A copied output is stronger evidence than a reference passed to an image tool.
    const destination=/-Destination\s+(?:'([^']+)'|"([^"]+)"|([^\s'";\r\n]+))/gi;let match;
    while((match=destination.exec(title)))add(match[1]||match[2]||match[3]);
    if(/^Files: /.test(title))for(const value of imageLinks(title))add(value);
  }
  for(const item of message.activities||[])if(item.status==='complete')for(const value of imageLinks(item.title))if(/[\\/]generated_images[\\/]/i.test(value))add(value);
  return result.slice(0,24);
}

class MessageImages{
  constructor({store,nativeImage}){this.store=store;this.nativeImage=nativeImage;this.cache=new Map();}
  async preview(filename){
    const info=await fs.stat(filename);if(!info.isFile())return null;
    const cacheKey=filename+'\0'+info.size+'\0'+info.mtimeMs;
    if(this.cache.has(cacheKey))return this.cache.get(cacheKey);
    if(info.size>24*1024*1024)return {path:filename,name:path.basename(filename),warning:'Image is too large for an inline preview.'};
    const bytes=await fs.readFile(filename);if(bytes.length>24*1024*1024)return {path:filename,name:path.basename(filename),warning:'Image is too large for an inline preview.'};const image=this.nativeImage.createFromBuffer(bytes);
    if(image.isEmpty())return {path:filename,name:path.basename(filename),warning:'The image cannot be decoded.'};
    const {width,height}=image.getSize();if(width>16384||height>16384||width*height>40*1024*1024)return {path:filename,name:path.basename(filename),warning:'Image dimensions exceed the preview limit.'};
    const scale=Math.min(1,1024/width,640/height);
    const thumbnail=image.resize({width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))}).toPNG();
    if(thumbnail.length>2*1024*1024)return {path:filename,name:path.basename(filename),warning:'Image preview exceeds the size limit.'};
    const result={path:filename,name:path.basename(filename),width,height,sizeBytes:info.size,digest:crypto.createHash('sha256').update(bytes).digest('hex'),thumbnail:'data:image/png;base64,'+thumbnail.toString('base64')};
    this.cache.set(cacheKey,result);while(this.cache.size>32)this.cache.delete(this.cache.keys().next().value);return result;
  }
  async list(chatId,messageId){
    const chat=this.store.get('chats',chatId),message=chat.messages.find(m=>m.id===messageId&&m.kind==='assistant');if(!message)throw new Error('Assistant message not found.');
    const project=this.store.get('projects',chat.projectId),root=project.directories.find(d=>d.locationId==='local')?.path;
    const result=[],digests=new Set(),names=new Set();
    for(const candidate of candidates({text:message.text,imagePaths:message.imagePaths,activities:readMessageDetail(message,'activities')})){
      if(result.length>=8)break;
      if(!path.isAbsolute(candidate)&&!root)continue;
      const filename=path.resolve(root||'',candidate),key=filename.toLowerCase();if(names.has(key))continue;names.add(key);
      let file;try{file=await this.preview(filename);}catch{file={path:filename,name:path.basename(filename),warning:'Image is unavailable or cannot be read.'};}
      if(!file||file.digest&&digests.has(file.digest))continue;if(file.digest)digests.add(file.digest);const {digest,...publicFile}=file;result.push(publicFile);
    }
    return result;
  }
}
module.exports={MessageImages,candidates,imagePath,imageLinks};
