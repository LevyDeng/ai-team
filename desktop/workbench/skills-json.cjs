function redact(value,secret=''){
  let text=String(value??'');if(secret)text=text.split(secret).join('[redacted]');
  return text.replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [redacted]').replace(/[\x00-\x1f\x7f]/g,' ').trim();
}

async function apiFailure(response,secret){
  const chunks=[];let size=0;
  try{for await(const chunk of response.body){const bytes=Buffer.from(chunk),remaining=16384-size;if(remaining<=0)break;chunks.push(bytes.subarray(0,remaining));size+=bytes.length;if(size>=16384)break;}}catch{}
  let error;try{error=JSON.parse(Buffer.concat(chunks).toString('utf8')).error;}catch{}
  const clean=(value,max)=>redact(value,secret).slice(0,max);
  const code=clean(error?.code||error?.status,100),type=clean(error?.type,100),detail=clean(typeof error==='string'?error:error?.message,450);
  const retryAfter=clean(response.headers.get('retry-after'),100),requestId=clean(response.headers.get('x-request-id')||response.headers.get('request-id'),160);
  const quota=/^(?:insufficient_quota|credit_balance_exhausted|organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded)$/i;
  const rate=/^(?:rate_limit_exceeded|rate_limit_error|slow_down)$/i;
  const category=quota.test(code)||quota.test(type)?'quota':response.status===429&&(rate.test(code)||rate.test(type))?'rate_limit':response.status===401?'authentication':response.status===403?'access':'unknown';
  const diagnostic={status:response.status,category,code,type,message:detail,retryAfter,requestId};
  const result=new Error('Image API returned HTTP '+response.status+(code?' ('+code+')':type?' ('+type+')':'')+(detail?': '+detail:'.')+(retryAfter?' Retry-After: '+retryAfter+'.':'')+(requestId?' Request ID: '+requestId+'.':''));
  result.apiError=diagnostic;return result;
}

async function limitedJson(response,limit=48*1024*1024,{secret=''}={}){
  if(!response.ok)throw await apiFailure(response,secret);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit){throw new Error('Image response exceeds the size limit.');}chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
module.exports={limitedJson,redact};
