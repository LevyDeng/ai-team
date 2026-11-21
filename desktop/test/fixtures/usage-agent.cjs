const input=require('node:readline').createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
input.on('line',line=>{
  const value=JSON.parse(line);
  if(value.method==='initialize')return send({id:1,result:{}});
  if(value.method==='initialized')return;
  if(value.method==='account/rateLimits/read')return send({id:2,result:{rateLimits:{primary:{usedPercent:0,resetsAt:2000000000,windowDurationMins:300}},privateToken:'DO_NOT_EXPORT'}});
  if(value.type==='control_request'&&value.request.subtype==='initialize')return send({type:'control_response',response:{request_id:'usage-init',subtype:'success',response:{}}});
  if(value.type==='control_request'&&value.request.subtype==='get_usage')return send({type:'control_response',response:{request_id:'usage-read',subtype:'success',response:{rate_limits:{five_hour:{utilization:14,resets_at:'2030-01-01T00:00:00Z'}},privateToken:'DO_NOT_EXPORT'}}});
  process.exit(90);
});
