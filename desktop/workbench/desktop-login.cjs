const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

function desktopHome() { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')); }
function usesDesktopLogin(role) { return role.engine === 'codex' && role.provider === 'native' && role.locationId === 'local' && role.codexLoginSource === 'desktop'; }
const sharedProcessArgs = ['-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false', '-c', 'notify=[]', '-c', 'check_for_update_on_startup=false'];
const desktopTaskArgs = ['-c', 'features.hooks=false', '-c', 'notify=[]', '-c', 'check_for_update_on_startup=false'];
function usesDesktopTools(role){return usesDesktopLogin(role)&&role.codexDesktopTools!==false;}

// Ask the installed CLI to resolve its configuration layers; never parse or copy account credentials.
function sharedTaskArgs(executable, env, cwd, { timeout = 10000, inheritTools = true } = {}) {
  // Participant and moderator tasks share the same explicit role preference.
  // Metadata probes retain their restricted configuration without editing settings.
  if(inheritTools)return Promise.resolve([...desktopTaskArgs]);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...sharedProcessArgs, 'app-server', '--listen', 'stdio://'], { env, cwd, windowsHide:true, stdio:['pipe','pipe','ignore'] });
    let done = false, buffer = '', bytes = 0; const decoder = new StringDecoder('utf8');
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); child.stdin.end(); child.kill(); error ? reject(error) : resolve(value); };
    const fail = () => finish(new Error('Could not isolate the desktop Codex tool configuration. Check its configuration and retry.'));
    const timer = setTimeout(fail, timeout);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => {}); child.once('error', fail); child.once('exit', () => { if (!done) fail(); });
    child.stdout.on('data', chunk => {
      if (done) return; bytes += chunk.length; if (bytes > 4 * 1024 * 1024) return fail();
      buffer += decoder.write(chunk);
      try {
        let index;
        while ((index = buffer.indexOf('\n')) >= 0 && !done) {
          const line = buffer.slice(0,index); buffer = buffer.slice(index+1); if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (![1,2].includes(message.id)) continue;
          if (message.error) return fail();
          if (message.id === 1) { send({method:'initialized',params:{}}); send({id:2,method:'config/read',params:{includeLayers:false,cwd}}); }
          else {
            if (!message.result?.config) return fail();
            const names = Object.keys(message.result.config.mcp_servers || {});
            // Empty map overrides merge with existing tables. Disable every resolved entry explicitly.
            const disabled = '{' + names.map(name => JSON.stringify(name) + '={enabled=false}').join(',') + '}';
            finish(null, [...sharedProcessArgs, '-c', 'mcp_servers=' + disabled]);
          }
        }
      } catch { fail(); }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'relay_login_configuration',version:'0.1.0'}}});
  });
}
module.exports = { desktopHome, usesDesktopLogin, usesDesktopTools, sharedProcessArgs, desktopTaskArgs, sharedTaskArgs };
