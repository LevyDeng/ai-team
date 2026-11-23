const { shellQuote } = require('../config.cjs');
const { stripVTControlCharacters } = require('node:util');
const { AcpClient } = require('./acp-client.cjs');
const { environment } = require('./proxy.cjs');
const { openRemoteCommand, waitForRemoteExit, waitForRemotePreparation } = require('./remote-exit.cjs');
const { args, supportsRemote } = require('./vendor-agents.cjs');

const proxyNames = 'HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy';
const accountVariables = ['AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function withProxy(command, policy) {
  if (!policy || policy.mode === 'system') return command;
  const values = Object.entries(environment({}, policy)).map(([key, value]) => key + '=' + shellQuote(value));
  return 'unset ' + proxyNames + '; export ' + values.join(' ') + '; ' + command;
}

async function runtime(locations, location, executable = '') {
  if (!supportsRemote('antigravity', location)) throw new Error('请选择可通过 SSH 连接的 Linux VPS。');
  if (executable && !/^(?:\/|~\/)[^\0\r\n]+$/.test(executable)) throw new Error('VPS 上的 agy 路径必须以 / 或 ~/ 开头。留空可自动检测。');
  const candidate = !executable ? 'entry="$(command -v agy)"; if [ ! -f "$entry" ] || [ ! -x "$entry" ]; then entry="$HOME/.local/bin/agy"; fi' :
    'entry=' + (executable.startsWith('~/') ? '"$HOME"/' + shellQuote(executable.slice(2)) : shellQuote(executable));
  try {
    const found = (await locations.exec(location.id, candidate + '\nif [ -f "$entry" ] && [ -x "$entry" ]; then printf "%s" "$entry"; fi')).trim();
    const installed = found.startsWith('/');
    return { installed, executable: installed ? found : '' };
  } catch (error) {
    throw new Error('无法通过 SSH 检测 VPS 上的 agy。\n' + error.message, { cause: error });
  }
}

async function ensureRuntime(locations, location, executable, proxy) {
  let result = await runtime(locations, location, executable);
  if (!result.installed) {
    if (executable) throw new Error('指定的 VPS agy 文件不存在或无法执行。检查路径，或清空路径后自动安装。');
    const command = [
      'set -eu',
      'installer=$(mktemp)',
      'trap \'rm -f -- "$installer"\' EXIT',
      'curl -fsSL --proto "=https" --max-time 90 https://antigravity.google/cli/install.sh -o "$installer"',
      'bash "$installer" >&2'
    ].join('\n');
    try { await locations.exec(location.id, withProxy(command, proxy), 180000); }
    catch (error) { throw new Error('无法在 VPS 上安装官方 agy。请检查服务器的网络、代理、curl 和 bash。' + (error.message ? '\n' + error.message : ''), { cause: error }); }
    result = await runtime(locations, location);
  }
  if (!result.installed) throw new Error('未检测到 VPS 上的 agy。请检查官方安装结果。');
  return result.executable;
}

function openLogin(client, executable, proxy, signal) {
  const command = withProxy('cd "$HOME" && exec env ' +
    accountVariables.map(name => '-u ' + name).join(' ') + ' ' + shellQuote(executable) + ' acp --login', proxy);
  return waitForRemotePreparation(
    () => new Promise((resolve, reject) => client.exec(command, { pty: { term: 'xterm-256color', cols: 100, rows: 28 } },
      (error, stream) => error ? reject(error) : resolve(stream))),
    signal, stream => stream.close()
  );
}

function authorizationUrl(output) {
  for (const value of stripVTControlCharacters(output).match(/https:\/\/[^\s<>"'\x00-\x1f]+(?=[\s<>"'])/g) || []) {
    try {
      const url = new URL(value);
      if (url.origin === 'https://accounts.google.com' && !url.username && !url.password && /^\/o\/oauth2\/(?:v2\/)?auth\/?$/.test(url.pathname) && url.searchParams.has('client_id')) return url.href;
    } catch {}
  }
  return '';
}

function keyringError(output) {
  return /keyring (?:is )?locked|failed to (?:unlock|open) (?:the |correct )?(?:keyring|collection)|(?:cannot|could not) (?:connect to|autolaunch) (?:the )?d-bus|org\.freedesktop\.secrets[^\n]*(?:not provided|not found|unavailable)/i.test(output);
}

async function openAcp(remote, role, cwd, jobId, { state, update, proxy, signal, stderr }) {
  const stream = await openRemoteCommand(remote.client, 'python3 ' + shellQuote(remote.file), signal);
  const stop = new AbortController();
  let confirmed = false, forced = false, failure;
  const completion = waitForRemoteExit(stream, () => '', { signal: stop.signal }).then(
    () => { confirmed = true; client.close(); },
    error => {
      confirmed = stop.signal.aborted ? error.exitCode === 130 : Number.isInteger(error.exitCode) && ![124, 137].includes(error.exitCode);
      failure = error;
      client.close(error);
    }
  );
  const client = new AcpClient({ stdin: stream, stdout: stream, once: stream.once.bind(stream) }, state, update, role);
  stream.stderr.on('data', stderr || (() => {}));
  function cancel(force = false) {
    if (forced || (stop.signal.aborted && !force)) return;
    forced = force;
    if (!stop.signal.aborted) stop.abort();
    client.close(new Error('VPS 上的 Antigravity 已收到结束请求。'));
    try { stream.write(force ? 'force\n' : 'cancel\n'); } catch {}
  }
  const abort = () => cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    stream.write(JSON.stringify({ acp: true, engine: 'antigravity', cwd, jobId, proxy,
      command: [remote.executable, ...args(role)] }) + '\n');
    if (signal.aborted) cancel();
  } catch (error) {
    signal.removeEventListener('abort', abort);
    stream.close();
    client.close(error);
    throw error;
  }
  return { client, cancel, async finish() {
    signal.removeEventListener('abort', abort);
    if (!failure) cancel();
    await completion;
    return confirmed;
  } };
}

async function probe(locations, location, role, proxy, executable = '') {
  const signal = AbortSignal.timeout(180000);
  const found = executable || (await runtime(locations, location, role.executable)).executable;
  if (!found) throw new Error('未检测到 VPS 上的 agy。请在角色设置中点击「配置并登录 VPS」。');
  const remote = await waitForRemotePreparation(() => locations.runner(location.id, '~/.local/share/relay-desk/antigravity-check'), signal);
  let diagnostic = '';
  const transport = await openAcp({ ...remote, executable: found }, { ...role, permission: 'workspace-write' },
    remote.cwd, require('node:crypto').randomUUID(), { state: { text: '' }, update: () => {}, proxy, signal,
      stderr: chunk => { diagnostic = (diagnostic + chunk).slice(-4000); } });
  try {
    await transport.client.initialize();
    return await transport.client.session(remote.cwd, {});
  } catch (error) {
    if (keyringError(diagnostic + error.message)) error.message = 'VPS 的系统密钥环无法打开。请检查该 SSH 用户的 D-Bus 和密钥环服务后重试。';
    throw error;
  } finally {
    await transport.finish();
  }
}

async function configure(locations, location, role, proxy, login) {
  const executable = await ensureRuntime(locations, location, role.executable, proxy);
  try {
    await probe(locations, location, role, proxy, executable);
    return true;
  } catch (error) {
    if (error.code !== 'VENDOR_LOGIN_REQUIRED') throw new Error('VPS 上已找到 agy，但无法验证登录。\n' + error.message, { cause: error });
  }
  if (!await login(executable)) return false;
  try { await probe(locations, location, role, proxy, executable); }
  catch (error) { throw new Error('Google 授权已返回，但 VPS 上的 agy 未能通过登录验证。\n' + error.message, { cause: error }); }
  return true;
}

module.exports = { runtime, configure, openLogin, authorizationUrl, keyringError, openAcp, probe };
