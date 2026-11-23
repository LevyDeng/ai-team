const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {waitForCliExit,shutdownGraceMs}=require('../workbench/cli-exit.cjs');
function child(){const value=new EventEmitter();value.stdout=new PassThrough();value.stderr=new PassThrough();return value;}

test('Cancelling an unresponsive CLI yields an explicit unconfirmed stop', async () => {
  const cli = child();
  const controller = new AbortController();
  const exit = waitForCliExit(cli, code => new Error(String(code)), 5, {signal:controller.signal, cancelMs:15});
  controller.abort();
  await assert.rejects(exit, {code:'CLI_STOP_UNCONFIRMED'});
});

test('A CLI that exits after cancellation releases the wait as soon as its streams close', async () => {
  const cli = child();
  const controller = new AbortController();
  const exit = waitForCliExit(cli, code => new Error(String(code)), 5, {signal:controller.signal, cancelMs:1000});
  controller.abort();
  cli.emit('exit', 1);
  cli.emit('close', 1);
  await assert.rejects(exit, {message:'1'});
});
const failure=code=>new Error('CLI exit '+code);
test('An exited CLI does not wait forever for inherited pipes; trailing events drain first',async()=>{
  const process=child();let tail='';process.stdout.on('data',data=>tail+=data.toString());
  const completion=waitForCliExit(process,failure,30);process.emit('exit',0);
  setTimeout(()=>process.stdout.write('final event'),5);await completion;
  assert.equal(tail,'final event');assert(process.stdout.destroyed);assert(process.stderr.destroyed);
});
test('Normal close completes immediately and a nonzero exit is never converted into success',async()=>{
  const normal=child(),done=waitForCliExit(normal,failure,1000);normal.emit('exit',0);normal.emit('close',0);await done;
  const failed=child(),rejected=waitForCliExit(failed,failure,5);failed.emit('exit',1);await assert.rejects(rejected,/CLI exit 1/);
});

test('A completed native turn has bounded shutdown even when the CLI stays alive',async()=>{
  const process=child();let stops=0;process.kill=()=>{stops++;process.emit('exit',null);process.emit('close',null);};
  const result=await waitForCliExit(process,failure,5,{terminal:()=> 'complete',shutdownMs:15,pollMs:2});
  assert.equal(stops,1);assert.equal(result.protocolComplete,true);assert.equal(result.forced,true);assert.equal(process.listenerCount('exit'),0);
  assert.equal(result.shutdown.reason,'cleanup_timeout');assert.equal(result.shutdown.graceMs,15);assert.equal(result.shutdown.exitObserved,true);
});
test('Normal cleanup can exceed the old three-second cutoff and is not classified as a crash',async()=>{
  assert.equal(shutdownGraceMs,50000);const process=child();let stops=0;process.kill=()=>{stops++;process.emit('close',1);};
  const completion=waitForCliExit(process,failure,5,{terminal:()=> 'complete'});setTimeout(()=>{process.emit('exit',0);process.emit('close',0);},3150);
  const result=await completion;assert.equal(stops,0);assert.equal(result.forced,false);assert.equal(result.shutdown.reason,'normal');assert(result.shutdown.afterTerminalMs>=3100);
});
test('An exited CLI with inherited pipes is never killed by the cleanup watchdog during drain',async()=>{
  const process=child();let stops=0;process.kill=()=>{stops++;process.emit('close',null);};
  const completion=waitForCliExit(process,failure,70,{terminal:()=> 'complete',shutdownMs:10,pollMs:2});process.emit('exit',0);
  const result=await completion;assert.equal(stops,0);assert.equal(result.exitCode,0);assert.equal(result.shutdown.reason,'normal');
});
test('Post-completion nonzero exits and signals retain evidence separate from forced cleanup',async()=>{
  for(const [code,signal,reason]of [[7,null,'nonzero_exit'],[null,'SIGTERM','signal_exit']]){
    const process=child(),completion=waitForCliExit(process,failure,10,{terminal:()=> 'complete'});process.emit('exit',code,signal);process.emit('close',code,signal);
    const result=await completion;assert.equal(result.protocolComplete,true);assert.equal(result.forced,false);assert.equal(result.shutdown.reason,reason);assert.equal(result.shutdown.exitSignal,signal);
  }
});

test('A final answer or long silence alone never marks a generating turn as completed',async()=>{
  const process=child();let stops=0,settled=false;process.kill=()=>stops++;
  const completion=waitForCliExit(process,failure,5,{terminal:()=>'',shutdownMs:5,pollMs:2}).then(()=>settled=true);
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Looks final"}}\n');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(stops,0);assert.equal(settled,false);process.emit('close',0);await completion;
});

test('A native failure is released but never converted to successful completion',async()=>{
  const process=child();process.kill=()=>process.emit('close',137);
  await assert.rejects(waitForCliExit(process,failure,5,{terminal:()=> 'failed',shutdownMs:5,pollMs:2}),/CLI exit 1/);
});

test('A new native turn cancels the preceding completion shutdown deadline',async()=>{
  const process=child();let state='complete',stops=0;process.kill=()=>{stops++;process.emit('close',0);};
  const completion=waitForCliExit(process,failure,5,{terminal:()=>state,shutdownMs:30,pollMs:2});state='';await new Promise(resolve=>setTimeout(resolve,50));assert.equal(stops,0);state='complete';await completion;assert.equal(stops,1);
});

test('An unclosable process is an explicit failure rather than an automatic retry or false success',async()=>{
  const process=child();process.kill=()=>false;
  await assert.rejects(waitForCliExit(process,failure,5,{terminal:()=> 'complete',shutdownMs:5,stopTimeoutMs:5,pollMs:2}),error=>error.code==='CLI_SHUTDOWN_STALLED');
});

test('Closing a completed CLI does not kill a service process it started',async t=>{
  const {spawn}=require('node:child_process');let servicePid;
  const source='const cp=require("node:child_process");const service=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true,detached:true});service.unref();process.stdout.write(JSON.stringify({service:service.pid})+"\\n");process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");setInterval(()=>{},1000);';
  const process=spawn(global.process.execPath,['-e',source],{windowsHide:true,stdio:['pipe','pipe','pipe']});t.after(()=>{process.kill();if(servicePid)try{global.process.kill(servicePid);}catch{}});
  let buffer='',state='';process.stdout.on('data',chunk=>{buffer+=chunk;let split;while((split=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,split));buffer=buffer.slice(split+1);if(event.service)servicePid=event.service;if(event.type==='turn.completed')state='complete';}});
  const result=await waitForCliExit(process,failure,50,{terminal:()=>state,shutdownMs:50,pollMs:5});assert.equal(result.protocolComplete,true);assert.equal(result.forced,true);assert(servicePid);assert.doesNotThrow(()=>global.process.kill(servicePid,0));
});
