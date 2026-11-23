const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),path=require('node:path');
const {quote,launchDetails,configureWindowsLaunch}=require('../windows-launch.cjs');
test('Classic and workbench taskbar launches explicitly select different application entries and identities',()=>{
  const root=path.resolve('Fixture Project'),executable=path.join(root,'electron.exe');
  const classic=launchDetails({root,executable,classic:true}),workbench=launchDetails({root,executable});
  assert.equal(classic.appId,'local.ai-team.client');assert.equal(workbench.appId,'local.ai-team.workbench');
  assert.equal(classic.shortcut.args,quote(path.join(root,'desktop','main.cjs')));assert.equal(workbench.shortcut.args,quote(path.join(root,'desktop','workbench','main.cjs')));
  for(const result of [classic,workbench]){
    assert.equal(result.window.relaunchCommand,quote(executable)+' '+result.shortcut.args);
    assert.equal(result.window.relaunchDisplayName,result.name);assert.equal(result.shortcut.appUserModelId,result.window.appId);assert.equal(result.shortcut.cwd,root);
  }
});
test('Every window receives taskbar metadata, including secondary windows',()=>{
  const app=new EventEmitter();app.setName=value=>app.name=value;app.setAppUserModelId=value=>app.appId=value;
  const config=configureWindowsLaunch(app,{root:path.resolve('fixture'),platform:'win32',executable:'fixture.exe',classic:true}),received=[];
  app.emit('browser-window-created',{}, {setAppDetails:value=>received.push(value)});app.emit('browser-window-created',{}, {setAppDetails:value=>received.push(value)});
  assert.equal(received.length,2);assert.deepEqual(received[0],config.window);assert.equal(app.appId,config.appId);
});
test('Packaged launches use their own entry point and classic switch; smoke runs do not register taskbar metadata',()=>{
  const root=path.resolve('fixture'),executable='ai-team.exe';
  assert.equal(launchDetails({root,executable,packaged:true}).shortcut.args,'');assert.equal(launchDetails({root,executable,packaged:true,classic:true}).shortcut.args,'--legacy');
  for(const options of [{platform:'linux'},{platform:'win32',disabled:true}]){const app=new EventEmitter();app.setName=()=>{};app.setAppUserModelId=()=>{};configureWindowsLaunch(app,{root,executable,...options});assert.equal(app.listenerCount('browser-window-created'),0);}
});
test('Windows argument quoting preserves spaces, quotation marks and trailing backslashes',()=>{
  assert.equal(quote('C:\\Program Files\\ai-team\\main.cjs'),'"C:\\Program Files\\ai-team\\main.cjs"');
  assert.equal(quote('a"b'),'"a\\"b"');assert.equal(quote('C:\\fixture\\'),'"C:\\fixture\\\\"');
  assert.throws(()=>quote('bad\rargument'),/Invalid/);assert.throws(()=>quote('bad\0argument'),/Invalid/);
});
