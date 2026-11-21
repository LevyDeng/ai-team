const { spawn } = require('node:child_process');

const fileAuthArgs = ['-c', 'cli_auth_credentials_store="file"'];
function problem(code, message) { const error = new Error(message); error.code = code; return error; }
function requireCodexLogin(executable, env, { timeout = 10000, launch = spawn, authArgs = fileAuthArgs, desktop = false } = {}) {
  return new Promise((resolve, reject) => {
    const checkCode = desktop ? 'CODEX_DESKTOP_LOGIN_CHECK_FAILED' : 'CODEX_LOGIN_CHECK_FAILED';
    let child;
    try { child = launch(executable, [...authArgs, 'login', 'status'], { env, windowsHide:true, stdio:['ignore','pipe','pipe'] }); }
    catch { reject(problem(checkCode, 'Could not check the selected Codex login. Verify its agent executable.')); return; }
    let done = false, output = '';
    const finish = error => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => {
      finish(problem(checkCode, 'Checking the selected Codex login timed out. Try signing in again.'));
      child.kill();
    }, timeout);
    const consume = chunk => { output = (output + chunk.toString('utf8')).slice(-8192); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', () => finish(problem(checkCode, 'Could not check the selected Codex login. Verify its agent executable.')));
    child.once('close', code => {
      if (code === 0) finish();
      else if (/not logged in/i.test(output)) finish(problem(desktop ? 'CODEX_DESKTOP_LOGIN_REQUIRED' : 'CODEX_LOGIN_REQUIRED', desktop ? 'Sign in to desktop Codex, then retry. This role reuses the desktop account.' : 'This role is not signed in to Codex. Click Sign in to this role, or use Roles > Connection > Sign in. Desktop Codex uses a separate login.'));
      else finish(problem(checkCode, 'Could not verify the selected Codex login. Sign in again at its selected source.'));
      output = '';
    });
  });
}
module.exports = { requireCodexLogin, fileAuthArgs };
