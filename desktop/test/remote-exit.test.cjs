const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {waitForRemoteExit}=require('../workbench/remote-exit.cjs');
test('A closed SSH stream without an exit status is a transport failure rather than a fabricated undefined CLI code',async()=>{
  const stream=new EventEmitter(),pending=waitForRemoteExit(stream);stream.emit('close');await assert.rejects(pending,error=>error.code==='REMOTE_CHANNEL_CLOSED'&&!error.message.includes('undefined'));assert.equal(stream.listenerCount('exit'),0);
});
test('An explicit SSH exit status survives a close event without arguments',async()=>{
  const stream=new EventEmitter(),pending=waitForRemoteExit(stream);stream.emit('exit',0);stream.emit('close');await pending;
});
test('Real CLI failures keep their detail, and SIGKILL is not equated with an account failure or proven OOM',async()=>{
  const stream=new EventEmitter(),pending=waitForRemoteExit(stream,()=> 'Fixture usage credits required.');stream.emit('exit',1);stream.emit('close');await assert.rejects(pending,/code 1.*Fixture usage credits/);
  const killed=new EventEmitter(),failure=waitForRemoteExit(killed);killed.emit('exit',undefined,'KILL',false,'Fixture terminated');killed.emit('close');await assert.rejects(failure,error=>error.code==='REMOTE_AGENT_KILLED'&&!/out of memory|banned/i.test(error.message));
});
test('Network errors retain the reconnection category without retrying the job',async()=>{
  const stream=new EventEmitter(),pending=waitForRemoteExit(stream);stream.emit('error',new Error('read ECONNRESET'));await assert.rejects(pending,error=>error.code==='REMOTE_CHANNEL_CLOSED');assert.equal(stream.listenerCount('close'),0);
});
test('Abort reaches a terminal state even if the SSH channel never closes',async()=>{
  const stream=new EventEmitter(),controller=new AbortController();
  let closed=false;stream.close=()=>{closed=true;};
  const pending=waitForRemoteExit(stream,undefined,{signal:controller.signal,stopMs:20});
  controller.abort();
  await assert.rejects(pending,{code:'REMOTE_STOP_UNCONFIRMED'});
  assert.equal(closed,true);
  assert.equal(stream.listenerCount('exit'),0);
});
test('A runner stop acknowledgement still counts when the SSH close event is delayed',async()=>{
  const stream=new EventEmitter(),controller=new AbortController();
  stream.close=()=>{};
  const pending=waitForRemoteExit(stream,undefined,{signal:controller.signal,stopMs:20});
  controller.abort();stream.emit('exit',130);
  await assert.rejects(pending,{exitCode:130});
});
