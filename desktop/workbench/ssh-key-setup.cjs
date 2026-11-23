const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { utils } = require('ssh2');
const { shellQuote } = require('../config.cjs');
const { execOn, sshAgent } = require('./locations.cjs');

function readKey(filename, passphrase, required = false) {
  try {
    const privateKey = fs.readFileSync(filename);
    const parsed = utils.parseKey(privateKey, passphrase);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key?.isPrivateKey?.()) throw new Error('The file is not a usable SSH private key.');
    return {
      filename,
      credentials: { privateKey, passphrase, authHandler: ['publickey'] },
      type: key.type,
      blob: key.getPublicSSH().toString('base64'),
    };
  } catch (error) {
    if (required) throw new Error('无法读取 SSH 私钥，请检查文件路径和私钥口令。', { cause: error });
  }
}

function createKey(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  // OpenSSH key generation can occasionally produce an unreadable Ed25519 key in ssh2.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { private: privateKey } = utils.generateKeyPairSync('ed25519', { comment: 'ai-team' });
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error) continue;
    fs.writeFileSync(filename, privateKey, { flag: 'wx', mode: 0o600 });
    return readKey(filename, undefined, true);
  }
  throw new Error('无法生成可用的 SSH 密钥，请重试。');
}

async function tryKey(locations, location, credentials) {
  try {
    const client = await locations.openClient(location, credentials);
    client.end();
    return true;
  } catch (error) {
    if (error.level === 'client-authentication' || error.level === 'agent') return false;
    throw error;
  }
}

async function passwordClient(locations, location, password) {
  let attempted = false;
  const authHandler = (methods, partial) => {
    if (methods === null) return 'none';
    if (attempted || partial) return false;
    attempted = true;
    if (methods.includes('password')) return 'password';
    if (methods.includes('keyboard-interactive')) return 'keyboard-interactive';
    return false;
  };
  try {
    return await locations.openClient(location, { password, tryKeyboard: true, authHandler }, client => {
      let answered = false;
      client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
        if (!answered && prompts.length === 1 && !prompts[0].echo && /\bpassword\b/i.test(prompts[0].prompt)) {
          answered = true;
          finish([password]);
        } else {
          client.end();
        }
      });
    });
  } catch (error) {
    if (error.level !== 'client-authentication') throw error;
    throw new Error('SSH 密码验证失败。请检查服务器密码，以及服务器是否允许该账号使用密码登录。', { cause: error });
  }
}

function installPublicKey(client, { type, blob }) {
  const find = '!/^[[:space:]]*#/ { for (i = 1; i < NF; i++) if ($i == type && $(i + 1) == blob) { print 1; exit } }';
  const command = [
    'set -eu',
    'umask 077',
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    'existing=$(awk -v type=' + shellQuote(type) + ' -v blob=' + shellQuote(blob) + ' ' + shellQuote(find) + ' ~/.ssh/authorized_keys)',
    'if [ -z "$existing" ]; then printf "\\n%s\\n" ' + shellQuote(type + ' ' + blob + ' ai-team') + ' >> ~/.ssh/authorized_keys; fi',
  ].join('\n');
  return execOn(client, command, 15000);
}

async function setupSshKey(locations, location, { passphrase, password }) {
  const home = os.homedir();
  const sshDir = path.join(home, '.ssh');
  const identity = JSON.stringify([location.host.toLowerCase(), location.port, location.username]);
  const filename = path.join(sshDir, 'ai-team', createHash('sha256').update(identity).digest('hex') + '-ed25519');
  const explicit = location.keyPath
    ? path.resolve(location.keyPath.replace(/^~[/\\]/, () => home + path.sep))
    : '';
  const candidates = explicit ? [explicit] : [filename, ...['id_ed25519', 'id_ecdsa', 'id_rsa'].map(name => path.join(sshDir, name))];
  let enrollmentKey;
  for (const candidate of candidates) {
    const key = readKey(candidate, explicit ? passphrase : undefined, Boolean(explicit));
    if (!key) continue;
    if (await tryKey(locations, location, key.credentials)) return { keyPath: key.filename };
    if (explicit || candidate === filename) enrollmentKey = key;
  }
  if (!explicit && await tryKey(locations, location, { agent: sshAgent(), authHandler: ['agent'] })) return { keyPath: '' };
  if (!password) return { needsPassword: true };

  const client = await passwordClient(locations, location, password);
  try {
    enrollmentKey ||= createKey(filename);
    try {
      await installPublicKey(client, enrollmentKey);
    } catch (error) {
      throw new Error('无法写入服务器的 ~/.ssh/authorized_keys，请检查该账号的主目录和文件权限。', { cause: error });
    }
  } finally {
    client.end();
  }

  if (!await tryKey(locations, location, enrollmentKey.credentials)) {
    throw new Error('已检查服务器公钥文件，但密钥登录验证失败。请检查服务器是否允许公钥登录。');
  }
  return { keyPath: enrollmentKey.filename };
}

module.exports = { setupSshKey };
