const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const paths=require('../path-links.js');
const {readMessageDetail}=require('./workspace-db.cjs');
const {findProjectPaths,messagePaths}=require('./path-resolution.cjs');
const imageExtension=/\.(?:png|jpe?g|webp|gif|bmp)$/i;
const maxImageBytes = 24 * 1024 * 1024;

function rasterType(bytes) {
  if (bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const header = bytes.toString('ascii', 0, 12);
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'gif';
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'webp';
  if (header.startsWith('BM')) return 'bmp';
}

function withinPreviewDimensions({ width, height }) {
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 40 * 1024 * 1024;
}

function imagePath(value,encoded=false){
  try{const name=paths.normalize(value,{encoded});return imageExtension.test(name)&&!/^[/\\]/.test(name)?name:null;}catch{return null;}
}
function imageLinks(text){return paths.links(String(text||'')).filter(link=>link.kind==='local').map(link=>imagePath(link.value)).filter(Boolean);}
function displayPath(reference, roots) {
  if (path.isAbsolute(reference)) return path.normalize(reference);
  if (roots.length !== 1 || /^~[\\/]/.test(reference)) return reference;
  const filename = path.resolve(roots[0], reference);
  const relative = path.relative(roots[0], filename);
  return relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ? reference : filename;
}
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
  messageSource(chatId, messageId) {
    const chat = this.store.get('chats', chatId);
    const message = chat.messages.find(item => item.id === messageId && ['assistant', 'skill'].includes(item.kind));
    if (!message) throw new Error('找不到这条图片回复。');
    const project = this.store.get('projects', chat.projectId);
    const roots = project.directories.filter(directory => directory.locationId === 'local').map(directory => directory.path);
    const activities = readMessageDetail(message, 'activities') || [];
    const references = message.kind === 'skill' ? (message.files || []).map(file => imagePath(file.path)).filter(Boolean)
      : candidates({text:message.text,imagePaths:message.imagePaths,activities});
    let hints;
    const resolve = reference => findProjectPaths(reference, roots, {
      search: false, getHints: () => hints ??= messagePaths(message, activities),
    }).catch(() => ({ candidates: [] }));
    return { roots, references, resolve };
  }

  async original(chatId, messageId, value) {
    const source = this.messageSource(chatId, messageId);
    const reference = imagePath(value);
    if (!reference || !source.references.includes(reference)) throw new Error('这张图片不属于当前回复。');
    const { candidates: matches } = await source.resolve(reference);
    if (matches.length !== 1 || matches[0].directory) return { unavailable: 'path' };
    const filename = matches[0].path;
    try {
      const info = await fs.stat(filename);
      if (!info.isFile()) return { unavailable: 'path' };
      if (info.size > maxImageBytes) return { unavailable: 'size' };
      const bytes = await fs.readFile(filename);
      if (bytes.length > maxImageBytes) return { unavailable: 'size' };
      const type = bytes.length >= 12 && rasterType(bytes);
      if (!type) return { unavailable: 'format' };
      const image = this.nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return { unavailable: 'format' };
      if (!withinPreviewDimensions(image.getSize())) return { unavailable: 'size' };
      return { path:filename, dataUrl:'data:image/'+type+';base64,'+bytes.toString('base64') };
    } catch (error) {
      return { unavailable: error.code === 'ENOENT' ? 'path' : 'read' };
    }
  }

  async preview(filename){
    const info=await fs.stat(filename);if(!info.isFile())return null;
    const cacheKey=filename+'\0'+info.size+'\0'+info.mtimeMs;
    if(this.cache.has(cacheKey))return this.cache.get(cacheKey);
    if(info.size>maxImageBytes)return {path:filename,name:path.basename(filename),warning:'Image is too large for an inline preview.'};
    const bytes=await fs.readFile(filename);if(bytes.length>maxImageBytes)return {path:filename,name:path.basename(filename),warning:'Image is too large for an inline preview.'};const image=this.nativeImage.createFromBuffer(bytes);
    if(image.isEmpty())return {path:filename,name:path.basename(filename),warning:'The image cannot be decoded.'};
    const {width,height}=image.getSize();if(!withinPreviewDimensions({width,height}))return {path:filename,name:path.basename(filename),warning:'Image dimensions exceed the preview limit.'};
    const scale=Math.min(1,1024/width,640/height);
    const thumbnail=image.resize({width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))}).toPNG();
    if(thumbnail.length>2*1024*1024)return {path:filename,name:path.basename(filename),warning:'Image preview exceeds the size limit.'};
    const result={path:filename,name:path.basename(filename),width,height,sizeBytes:info.size,digest:crypto.createHash('sha256').update(bytes).digest('hex'),thumbnail:'data:image/png;base64,'+thumbnail.toString('base64')};
    this.cache.set(cacheKey,result);while(this.cache.size>32)this.cache.delete(this.cache.keys().next().value);return result;
  }
  async list(chatId,messageId){
    const { roots, references, resolve } = this.messageSource(chatId, messageId);
    const result=[],digests=new Set(),names=new Set();
    for(const candidate of references){
      if(result.length>=8)break;
      const matches=await resolve(candidate);
      const resolved=matches.candidates.length===1?matches.candidates[0].path:undefined;
      const filename=resolved||displayPath(candidate,roots);
      const key=filename.toLowerCase();if(names.has(key))continue;names.add(key);
      let file;
      if(resolved)try{file=await this.preview(filename);}catch{}
      file||={path:filename,name:path.basename(filename),warning:'Image is unavailable or cannot be read.',
        ...(!resolved&&filename!==candidate&&{reference:candidate})};
      if(file.digest&&digests.has(file.digest))continue;if(file.digest)digests.add(file.digest);const {digest,...publicFile}=file;result.push({...publicFile,sourcePath:candidate});
    }
    return result;
  }
}
module.exports={MessageImages,candidates,imagePath,imageLinks};
