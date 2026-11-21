const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { requireCodexLogin } = require('../workbench/native-auth.cjs');

function launchFixture(code, text, inspect) {
  return (executable,args,options) => {
    inspect?.(executable,args,options);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = ()=>{};
    queueMicrotask(()=>{child.stderr.write(text);child.emit('close',code);});
    return child;
  };
}
test('The login probe uses the isolated environment and the same file credential store as sign-in', async()=>{
  const env={CODEX_HOME:'C:/fixture/profile/codex'};
  await requireCodexLogin('fixture.exe',env,{launch:launchFixture(0,'Logged in using an API key - fixture-secret',(exe,args,options)=>{
    assert.equal(exe,'fixture.exe');assert.deepEqual(args,['-c','cli_auth_credentials_store="file"','login','status']);assert.equal(options.env,env);assert.equal(options.windowsHide,true);
  })});
});
test('Missing and unverified credentials produce actionable codes without exposing diagnostic secrets',async()=>{
  await assert.rejects(requireCodexLogin('fixture.exe',{}, {launch:launchFixture(1,'Not logged in')}), error=>error.code==='CODEX_LOGIN_REQUIRED'&&/role/.test(error.message));
  await assert.rejects(requireCodexLogin('fixture.exe',{}, {launch:launchFixture(2,'failure fixture-secret')}), error=>error.code==='CODEX_LOGIN_CHECK_FAILED'&&!error.message.includes('fixture-secret'));
});
test('A stalled login check is bounded and its child is stopped',async()=>{
  let killed=false;
  const launch=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed=true;};return child;};
  await assert.rejects(requireCodexLogin('fixture.exe',{}, {launch,timeout:20}),error=>error.code==='CODEX_LOGIN_CHECK_FAILED');assert(killed);
});

test('Desktop login probes honor its configured credential store and explain a missing shared login',async()=>{
  await requireCodexLogin('fixture.exe',{}, {desktop:true,authArgs:[],launch:launchFixture(0,'Logged in using ChatGPT',(_exe,args)=>assert.deepEqual(args,['login','status']))});
  await assert.rejects(requireCodexLogin('fixture.exe',{}, {desktop:true,authArgs:[],launch:launchFixture(1,'Not logged in')}),error=>error.code==='CODEX_DESKTOP_LOGIN_REQUIRED'&&/desktop Codex/.test(error.message));
});
