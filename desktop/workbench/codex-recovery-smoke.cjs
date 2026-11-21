const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,services,js,errors}){
  const copied=[];services.clipboard.writeText=text=>copied.push(text);
  const chatId=await js('chat().id'),chat=store.get('chats',chatId),role=store.get('roles',chat.roleIds[0]);
  const message=store.message(chatId,{kind:'assistant',roleId:role.id,roleName:role.name,locationId:'local',text:'Preserved partial progress',status:'running',recovery:{attempt:1,maxRetries:2,reason:'bad_request',state:'waiting',transport:'uncompressed'}});
  message.activity='Finishing agent';store.save();await js(`(async()=>{state=await api.snapshot();state.running[${JSON.stringify(chatId)}]={roleId:${JSON.stringify(role.id)},round:1,rounds:1};renderMessages();})()`);
  assert((await js('document.querySelector("#chat-banner").textContent')).includes('已完成，正在收尾'));
  assert.equal(await js(`document.querySelector('#msg-${message.id} .message-state').textContent`),'正在收尾');
  message.status='complete';message.warningCode='CODEX_SHUTDOWN_WARNING';store.save();await js('(async()=>{state=await api.snapshot();renderMessages();})()');
  assert((await js(`document.querySelector('#msg-${message.id} .message-note').textContent`)).includes('旧记录未区分'));assert.equal(await js('document.querySelector("#chat-banner").hidden'),true);
  message.cliShutdown={reason:'cleanup_timeout',graceMs:50000,afterTerminalMs:50102,exitCode:null,exitSignal:'SIGTERM',forced:true,exitObserved:true};store.save();
  await js('(async()=>{state=await api.snapshot();renderMessages();})()');let note=await js(`document.querySelector('#msg-${message.id} .message-note').textContent`);assert(note.includes('50 秒'));assert(!note.includes('收尾异常'));assert(note.includes('不表示回答失败'));
  await wait(120);fs.writeFileSync(path.join(directory,'codex-shutdown-timeout.png'),(await window.webContents.capturePage()).toPNG());
  message.cliShutdown={reason:'nonzero_exit',graceMs:50000,afterTerminalMs:1000,exitCode:7,exitSignal:null,forced:false,exitObserved:true};store.save();
  await js('(async()=>{state=await api.snapshot();renderMessages();})()');note=await js(`document.querySelector('#msg-${message.id} .message-note').textContent`);assert(note.includes('非零退出码 7'));assert(!note.includes('等待内未退出'));
  message.cliShutdown={...message.cliShutdown,reason:'signal_exit',exitCode:null,exitSignal:'SIGTERM'};store.save();await js('(async()=>{state=await api.snapshot();renderMessages();})()');assert((await js(`document.querySelector('#msg-${message.id} .message-note').textContent`)).includes('SIGTERM'));delete message.cliShutdown;
  delete message.warningCode;message.activity='Running agent';
  message.status='failed';message.errorCode='CODEX_CAPACITY';message.note='Selected model is at capacity.';message.diagnostics={traceId:'fixture-diagnostic-trace',model:'fixture-model',metadataOnly:true,failure:{category:'capacity',httpStatus:503,requestIds:['req_fixture_capacity']}};store.save();
  await js('(async()=>{state=await api.snapshot();renderMessages();})()');assert((await js(`document.querySelector('#msg-${message.id} .message-note').textContent`)).includes('明确报告模型容量'));
  await js(`document.querySelector('#msg-${message.id} .diagnostic-copy').click()`);await wait(100);assert(copied.at(-1).includes('fixture-diagnostic-trace'));assert(!copied.at(-1).includes(message.text));delete message.errorCode;delete message.note;delete message.diagnostics;
  for(const state of ['waiting','resuming','recovered','stopped']){
    message.recovery.state=state;message.status=state==='recovered'?'complete':state==='stopped'?'failed':'running';if(state==='stopped'){message.errorCode='CODEX_BAD_REQUEST';message.note='Agent exited with code 1. {"detail":"Bad Request"}';}store.save();
    await js('(async()=>{state=await api.snapshot();renderMessages();})()');await wait(50);
    const text=await js(`document.getElementById('msg-${message.id}').textContent`);assert(text.includes('Preserved partial progress'));assert(text.includes('1/2'));assert(text.includes('已关闭本次请求压缩'));assert.equal(await js(`document.querySelectorAll('#msg-${message.id} .message-recovery').length`),1);
    if(state==='stopped')assert(text.includes('模型列表刷新超时不等于这些命令执行失败'));
  }
  fs.writeFileSync(path.join(directory,'codex-recovery-message.png'),(await window.webContents.capturePage()).toPNG());assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'codex-recovery-checks.json'),JSON.stringify({passed:true,states:['waiting','resuming','recovered','stopped'],preservedPartial:true,errors},null,2));app.exit(0);
}
module.exports={run};
