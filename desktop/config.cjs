const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function parseEnv(text) {
  const values = {};
  for (const [index, source] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env syntax on line ${index + 1}.`);
    const [, key, raw] = match;
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate .env key: ${key}`);
    let value = raw.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}
function shellQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid shell argument.');
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
function configFromEnv(root) {
  const envPath = path.join(root, '.env');
  const values = parseEnv(fs.readFileSync(envPath, 'utf8'));
  const match = /^([\w][\w.-]*)@([\w][\w.-]*)$/.exec(values.SSH_TARGET || '');
  if (!match) throw new Error('Set SSH_TARGET=user@host in .env.');
  if (!/^[a-f0-9]{64}$/.test(values.WINDOWS_MCP_SECRET || '')) throw new Error('Generate a secret with New-Secret.ps1 first.');
  const ports = ['SSH_PORT', 'LOCAL_MCP_PORT', 'REMOTE_MCP_PORT'].map((key, index) => {
    const port = Number(values[key]);
    if (!Number.isInteger(port) || port < (index ? 1024 : 1) || port > 65535) throw new Error(`Invalid ${key}.`);
    return port;
  });
  const maxSessions = Number(values.MAX_DESKTOP_SESSIONS || 3);
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 8) throw new Error('The session limit must be between 1 and 8.');
  let key = values.SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_ed25519');
  if (/^~[/\\]/.test(key)) key = path.join(os.homedir(), key.slice(2));
  if (!path.isAbsolute(key)) key = path.resolve(root, key);
  return { envPath, username: match[1], host: match[2], sshPort: ports[0], localPort: ports[1], remotePort: ports[2], secret: values.WINDOWS_MCP_SECRET, keyPath: key, maxSessions };
}
function connectionSettings(root) {
  const cfg = configFromEnv(root);
  return { target: `${cfg.username}@${cfg.host}`, sshPort: cfg.sshPort, keyPath: cfg.keyPath,
    localPort: cfg.localPort, remotePort: cfg.remotePort, maxSessions: cfg.maxSessions, secretConfigured: true };
}
function saveConnectionSettings(root, value) {
  if (!value || typeof value.target !== 'string' || !/^[\w][\w.-]*@[\w][\w.-]*$/.test(value.target.trim())) throw new Error('Enter an SSH address in user@host format.');
  if (!Number.isInteger(value.sshPort) || value.sshPort < 1 || value.sshPort > 65535) throw new Error('SSH port must be between 1 and 65535.');
  if (!Number.isInteger(value.maxSessions) || value.maxSessions < 1 || value.maxSessions > 8) throw new Error('The session limit must be between 1 and 8.');
  if (typeof value.keyPath !== 'string' || !value.keyPath.trim() || value.keyPath.length > 2048 || /[\r\n\0"]/.test(value.keyPath)) throw new Error('Choose a valid SSH private key file.');
  let keyPath = value.keyPath.trim();
  if (/^~[/\\]/.test(keyPath)) keyPath = path.join(os.homedir(), keyPath.slice(2));
  if (!path.isAbsolute(keyPath)) keyPath = path.resolve(root, keyPath);
  let keyInfo;
  try { keyInfo = fs.statSync(keyPath); } catch { throw new Error('Choose a valid SSH private key file.'); }
  if (!keyInfo.isFile()) throw new Error('Choose a valid SSH private key file.');
  const filename = path.join(root, '.env');
  const original = fs.readFileSync(filename, 'utf8');
  parseEnv(original);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const changes = new Map(Object.entries({ SSH_TARGET: value.target.trim(), SSH_PORT: String(value.sshPort),
    SSH_KEY_PATH: `"${keyPath}"`, MAX_DESKTOP_SESSIONS: String(value.maxSessions) }));
  const lines = original.split(/\r?\n/).map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !changes.has(match[1])) return line;
    const replacement = `${match[1]}=${changes.get(match[1])}`;
    changes.delete(match[1]);
    return replacement;
  });
  while (lines.at(-1) === '') lines.pop();
  for (const [key, text] of changes) lines.push(`${key}=${text}`);
  const temporary = filename + '.settings-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, lines.join(newline) + newline, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return connectionSettings(root);
}
function knownHostKeys(config) {
  const host = config.sshPort === 22 ? config.host : `[${config.host}]:${config.sshPort}`;
  const known = path.join(os.homedir(), '.ssh', 'known_hosts');
  let output;
  try { output = execFileSync('ssh-keygen.exe', ['-F', host, '-f', known], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); }
  catch { throw new Error('SSH host is not trusted yet. Run setup-ssh.cmd first.'); }
  const keys = output.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && !line.startsWith('@')).map((line) => line.trim().split(/\s+/)[2]).filter(Boolean).map((key) => Buffer.from(key, 'base64'));
  if (!keys.length) throw new Error('No usable SSH host key found in known_hosts.');
  return keys;
}
function hostMatches(key, trusted) {
  return trusted.some((known) => known.length === key.length && crypto.timingSafeEqual(key, known));
}
module.exports = { parseEnv, shellQuote, configFromEnv, knownHostKeys, hostMatches, connectionSettings, saveConnectionSettings };
