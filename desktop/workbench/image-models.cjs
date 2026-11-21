const {limitedJson}=require('./skills-json.cjs');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic}=require('./store.cjs');

function candidates(provider,entries){
  return entries.map(entry=>({...entry,id:String(entry.id||entry.name||'').replace(/^models\//,'')})).filter(entry=>{
    if(!entry.id||entry.id.length>200||/[\s\x00-\x1f]/.test(entry.id))return false;
    if(provider==='gemini')return /^gemini-(?:\d+(?:\.\d+)?-.*image|nano-banana-\d+(?:\.\d+)?)(?:-|$)/.test(entry.id)&&entry.supportedGenerationMethods?.includes('generateContent');
    return /^(?:gpt-image-\d+(?:\.\d+)?(?:-|$)|chatgpt-image-latest$)/.test(entry.id)&&entry.id!=='gpt-image-1';
  });
}

function select(provider,entries){
  const models=candidates(provider,entries);
  // The renamed Nano Banana family cannot be compared numerically with Gemini versions.
  const preferred=['gemini-nano-banana-2.1','gemini-3.1-flash-image','gemini-3-pro-image','gemini-3.1-flash-lite-image','gemini-2.5-flash-image'];
  const stable=models.filter(m=>!/(?:preview|experimental|(?:^|-)exp(?:-|$))/.test(m.id));
  const pool=stable.length?stable:models;
  const score=m=>{
    if(provider==='gemini'){
      const nano=/^gemini-nano-banana-(\d+)(?:\.(\d+))?/.exec(m.id),gemini=/^gemini-(\d+)(?:\.(\d+))?/.exec(m.id);
      const newer=nano&&(Number(nano[1])>2||Number(nano[1])===2&&Number(nano[2]||0)>1)||gemini&&(Number(gemini[1])>3||Number(gemini[1])===3&&Number(gemini[2]||0)>1);
      const version=nano||gemini;
      return [newer?200:preferred.includes(m.id)?100-preferred.indexOf(m.id):0,Number(version?.[1])||0,Number(version?.[2])||0,Number(m.created)||0];
    }
    const match=/^gpt-image-(\d+)(?:\.(\d+))?/.exec(m.id);
    return match?[Number(match[1]),Number(match[2]||0),!/-mini(?:-|$)/.test(m.id)?1:0,Number(m.created)||0,!/\d{4}-\d{2}-\d{2}$/.test(m.id)?1:0]:[0,0,0,0,0];
  };
  pool.sort((a,b)=>{const aa=score(a),bb=score(b);for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])return bb[i]-aa[i];return a.id.localeCompare(b.id,undefined,{numeric:true});});
  if(!pool.length)throw new Error('No compatible image-generation model was found. Enter a supported image model ID in skill settings.');
  return pool[0].id;
}

async function list({provider,base,key,request,signal}){
  const headers=provider==='gemini'?{'x-goog-api-key':key}:{Authorization:'Bearer '+key};
  const entries=[];let token='';
  const timeout=AbortSignal.any([signal,AbortSignal.timeout(20000)]);
  for(let page=0;page<5;page++){
    const url=new URL(base+'/models');
    if(provider==='gemini'){url.searchParams.set('pageSize','1000');if(token)url.searchParams.set('pageToken',token);}
    const result=await limitedJson(await request(url.href,{headers,signal:timeout,redirect:'error'}),2*1024*1024,{secret:key});
    const list=provider==='gemini'?result.models:result.data;
    if(!Array.isArray(list))throw new Error('The provider returned an invalid image model catalog. Enter a model ID manually.');
    entries.push(...list);
    token=provider==='gemini'?result.nextPageToken:'';
    if(!token)return candidates(provider,entries);
    if(typeof token!=='string'||token.length>4096)throw new Error('Invalid image model catalog page token.');
  }
  throw new Error('Image model catalog is too large. Enter a model ID manually.');
}
async function discover(input){return select(input.provider,await list(input));}

class ImageModelCatalogs{
  constructor(directory){this.file=path.join(directory,'image-model-catalogs.json');this.pending=new Map();try{this.cache=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.cache={};}}
  async request(input,{force=false}={}){
    const digest=crypto.createHash('sha256').update(JSON.stringify([input.provider,input.base,input.key,input.proxy])).digest('hex'),cached=this.cache[digest];
    if(!force&&cached?.models?.length)return {...cached,cached:true};
    if(this.pending.has(digest))return this.pending.get(digest);
    const work=(async()=>{
      try{
        const entries=await list({...input,signal:AbortSignal.timeout(20000)}),model=select(input.provider,entries);
        const models=[...entries.filter(m=>m.id===model),...entries.filter(m=>m.id!==model)].slice(0,500).map(m=>({id:m.id,label:String(m.displayName||m.id).slice(0,200)}));
        const result={models,model,updatedAt:Date.now()};this.cache[digest]=result;
        this.cache=Object.fromEntries(Object.entries(this.cache).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,64));atomic(this.file,this.cache);return {...result,cached:false};
      }catch(error){if(cached?.models?.length)return {...cached,cached:true,warning:error.message};throw error;}
    })();
    this.pending.set(digest,work);try{return await work;}finally{this.pending.delete(digest);}
  }
}
module.exports={select,candidates,discover,list,ImageModelCatalogs};
