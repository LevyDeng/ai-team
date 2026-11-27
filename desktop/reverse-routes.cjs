const net=require('node:net');
const clients=new WeakMap();
function add(client,port,localPort){let routes=clients.get(client);if(!routes){routes=new Map();clients.set(client,routes);}routes.set(port,localPort);return ()=>{routes.delete(port);};}
function route(client,details,accept,reject){const port=clients.get(client)?.get(details.destPort);if(!port)return false;if(!['127.0.0.1','localhost'].includes(details.destIP)){reject();return true;}const channel=accept(),local=net.connect({host:'127.0.0.1',port});local.on('error',()=>channel.destroy());channel.on('error',()=>local.destroy());channel.on('close',()=>local.destroy());local.pipe(channel).pipe(local);return true;}
async function expose(client,bridge){const port=await new Promise((resolve,reject)=>client.forwardIn('127.0.0.1',0,(error,value)=>error?reject(error):resolve(value)));const remove=add(client,port,new URL(bridge.url).port);let closed=false;return {url:'http://127.0.0.1:'+port+'/rpc',token:bridge.token,close(){if(closed)return;closed=true;remove();try{client.unforwardIn('127.0.0.1',port,()=>{});}catch{}bridge.close();}};}
module.exports={route,expose,add};
