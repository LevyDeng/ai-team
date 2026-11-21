const test=require('node:test'),assert=require('node:assert/strict');
const {limitedJson}=require('../workbench/skills-json.cjs');

test('Quota and rate-limit errors retain distinct codes and retry/request headers',async()=>{
  const response=(code,type)=>Response.json({error:{code,type,message:'Fixture provider detail.'}},{status:429,headers:{'retry-after':'30','x-request-id':'fixture-request'}});
  for(const [code,type,category]of [['insufficient_quota','insufficient_quota','quota'],['credit_balance_exhausted','insufficient_quota','quota'],['project_spend_limit_exceeded','insufficient_quota','quota'],['rate_limit_exceeded','requests','rate_limit'],['tokens','rate_limit_error','rate_limit'],['','rate_limit_error','rate_limit'],['','resource_exhausted','unknown']]){
    await assert.rejects(limitedJson(response(code,type)),error=>{assert.equal(error.apiError.category,category);assert.equal(error.apiError.code,code);assert.equal(error.apiError.retryAfter,'30');assert.equal(error.apiError.requestId,'fixture-request');assert(error.message.includes('Fixture provider detail'));return true;});
  }
});

test('Provider errors redact credentials before exposing structured or display diagnostics',async()=>{
  const key='fixture-private-key';
  await assert.rejects(limitedJson(Response.json({error:{code:'invalid_api_key',type:'auth',message:'Key '+key+' sk-fixture-other-secret Bearer fixture-token'}},{status:401}),1024,{secret:key}),error=>{
    const all=JSON.stringify({text:error.message,diagnostic:error.apiError});for(const value of [key,'sk-fixture-other-secret','fixture-token'])assert(!all.includes(value));assert.equal(error.apiError.category,'authentication');return true;
  });
});

test('Malformed and excessive error bodies preserve HTTP status without dumping provider pages',async()=>{
  for(const body of ['<html>Fixture private proxy page</html>',' '.repeat(20000)]){
    await assert.rejects(limitedJson(new Response(body,{status:429})),error=>{assert.equal(error.apiError.status,429);assert.equal(error.apiError.category,'unknown');assert(error.message.length<300);assert(!error.message.includes('private proxy page'));return true;});
  }
});

test('Successful JSON keeps the caller size bound and original data shape',async()=>{
  assert.deepEqual(await limitedJson(Response.json({data:[{id:'fixture'}]})),{data:[{id:'fixture'}]});
  await assert.rejects(limitedJson(new Response(' '.repeat(1100)),1024),/size limit/);
});
