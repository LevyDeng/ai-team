const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const MAX_FILE_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const APPROVAL_TIMEOUT = 120_000;
const MAX_REQUESTS = 64;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const privateName = /^(?:\.git|\.git-credentials|\.ssh|\.gnupg|\.aws|\.azure|\.config|\.kube|\.codex|\.claude|\.gemini|\.runtime|\.env(?:rc|\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519|ecdsa|dsa)|credentials(?:\..*)?|secrets(?:\..*)?|appdata|system volume information|\$recycle\.bin|\.ai-team-write-.*)$/i;
const privateExtension = /\.(?:pem|key|pfx|p12|ppk|kdbx)$/i;
const reservedWindowsName = /^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function permittedName(name) {
  return Boolean(name) && name !== '.' && name !== '..' && !/[<>:"|?*\\/\p{Cc}\p{Cf}]/u.test(name) &&
    !/[. ]$/.test(name) && !privateName.test(name) && !privateExtension.test(name) &&
    !reservedWindowsName.test(name) && !/~[0-9]/.test(name);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function inspect(target, missingAllowed = false) {
  const root = path.parse(target).root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  let stat = fs.lstatSync(root);
  for (const [index, segment] of segments.entries()) {
    if (!stat.isDirectory() || !permittedName(segment)) throw new Error('此路径不在允许的文件范围内。');
    current = path.join(current, segment);
    stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && missingAllowed && index === segments.length - 1) return undefined;
    if (!stat) throw new Error('文件或目录不存在。');
    if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(current), current) ||
        !(stat.isDirectory() || (stat.isFile() && stat.nlink === 1))) {
      throw new Error('此路径包含链接或不支持的文件类型。');
    }
  }
  return stat;
}

function validateDirectory(input) {
  if (typeof input !== 'string' || input.length > 1024 || !path.isAbsolute(input) ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(input))) {
    throw new Error('请输入本机项目目录的绝对路径。');
  }
  const raw = input.slice(path.parse(input).root.length).split(/[\\/]/).filter(Boolean);
  if (!raw.length || !raw.every(permittedName)) throw new Error('此目录不允许申请。');
  const directory = path.resolve(input);
  const blocked = [os.homedir(), process.env.SystemRoot, process.env.ProgramData, process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean);
  if (blocked.some(value => inside(directory, value)) || blocked.slice(1).some(value => inside(value, directory))) {
    throw new Error('请选择具体的项目目录，个人主目录和系统目录不能授权。');
  }
  const stat = inspect(directory);
  if (!stat.isDirectory()) throw new Error('申请路径必须是现有目录。');
  return { directory, stat };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function revision(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readText(target, stat) {
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('只能读取不超过 128 KiB 的 UTF-8 文本文件。');
  const fd = fs.openSync(target, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!sameFile(stat, opened) || opened.nlink !== 1 || !sameFile(opened, inspect(target))) {
      throw new Error('文件在打开时发生了变化，请重试。');
    }
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const data = bytes.subarray(0, length);
    if (length > MAX_FILE_BYTES || data.includes(0)) throw new Error('只能读取不超过 128 KiB 的 UTF-8 文本文件。');
    return { content: utf8.decode(data), revision: revision(data) };
  } finally {
    fs.closeSync(fd);
  }
}

function projectPath(grant, input, allowDirectory) {
  if (typeof input !== 'string' || input.length > 1024) throw new Error('请输入项目内的相对路径。');
  if (allowDirectory && input === '.') return grant.directory;
  const parts = input.split(/[\\/]/);
  if (!parts.every(permittedName)) throw new Error('请选择获准目录内的相对路径。');
  return path.join(grant.directory, ...parts);
}

function unchanged(target, expected) {
  const current = inspect(target, true);
  return expected ? current && sameFile(expected, current) : !current;
}

function directoryStillExists({ directory, stat }) {
  try { return unchanged(directory, stat); } catch { return false; }
}

function writeText(target, stat, args) {
  if (typeof args.content !== 'string' || args.content.includes('\0') ||
      Buffer.byteLength(args.content) > MAX_FILE_BYTES) {
    throw new Error('只能写入不超过 128 KiB 的 UTF-8 文本。');
  }
  if (stat ? args.revision !== readText(target, stat).revision : args.revision !== 'create') {
    throw new Error('文件版本已变更。请重新读取文件，新建文件时请使用 create 作为版本。');
  }
  const temporary = path.join(path.dirname(target), '.ai-team-write-' + randomUUID());
  try {
    fs.writeFileSync(temporary, args.content, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o600 });
    if (!unchanged(target, stat) || (stat && readText(target, stat).revision !== args.revision)) {
      throw new Error('文件在写入前发生了变化，请重新读取。');
    }
    if (stat) fs.renameSync(temporary, target);
    else fs.linkSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return { status: 'written', revision: revision(args.content) };
}

function children(directory, limit = 200) {
  const entries = fs.opendirSync(directory);
  const visible = [];
  try {
    for (let count = 0; count < 1000 && visible.length < limit; count++) {
      const entry = entries.readSync();
      if (!entry) break;
      if (!permittedName(entry.name) || !(entry.isFile() || entry.isDirectory())) continue;
      try {
        const stat = inspect(path.join(directory, entry.name));
        visible.push({ name: entry.name, type: stat.isDirectory() ? 'directory' : 'file' });
      } catch {}
    }
  } finally {
    entries.closeSync();
  }
  return visible;
}

function searchText(target, query) {
  if (typeof query !== 'string' || !query.length || query.length > 200) throw new Error('请输入不超过 200 个字符的搜索词。');
  const matches = [];
  const paths = [target];
  const limit = 100;
  let limited = false;
  for (let index = 0; index < paths.length && matches.length < 30; index++) {
    const current = paths[index];
    try {
      const stat = inspect(current);
      if (stat.isDirectory()) {
        const remaining = limit - paths.length;
        const entries = children(current, remaining + 1);
        limited ||= entries.length > remaining;
        for (const entry of entries.slice(0, remaining)) paths.push(path.join(current, entry.name));
        continue;
      }
      const lines = readText(current, stat).content.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < 30; index++) {
        const start = lines[index].indexOf(query);
        if (start !== -1) matches.push({ path: path.relative(target, current) || path.basename(current),
          line: index + 1, text: lines[index].slice(Math.max(0, start - 80), start + 240) });
      }
    } catch {}
  }
  return { matches, limited: limited || matches.length === 30 };
}

class DirectoryAccess {
  constructor({ approve, changed }) {
    this.approve = approve;
    this.changed = changed;
    this.requests = new Map();
    this.closed = false;
  }

  request(principal, args) {
    if (this.closed) throw new Error('本机目录权限通道已关闭。');
    const { directory, stat } = validateDirectory(args.directory);
    if (!['read', 'read-write'].includes(args.access) || typeof args.reason !== 'string' ||
        !args.reason.trim() || args.reason.length > 500) throw new Error('请填写权限类型和申请原因。');
    if ([...this.requests.values()].some(request => request.status === 'pending')) {
      throw new Error('已有一项目录申请等待本机确认。');
    }
    if (this.requests.size >= MAX_REQUESTS) {
      const expired = [...this.requests].find(([, request]) => request.status === 'denied');
      if (expired) this.requests.delete(expired[0]);
    }
    if (this.requests.size >= MAX_REQUESTS) throw new Error('请先在 AI 小队收回不再使用的目录权限。');
    const id = randomUUID();
    const controller = new AbortController();
    const request = { directory, stat, access: args.access, principal, controller, status: 'pending' };
    this.requests.set(id, request);
    const timer = setTimeout(() => controller.abort(), APPROVAL_TIMEOUT);
    timer.unref();
    const reject = () => {
      if (request.status !== 'pending') return;
      request.status = 'denied';
      this.changed();
    };
    controller.signal.addEventListener('abort', reject, { once: true });
    Promise.resolve().then(() => controller.signal.aborted ? false : this.approve({
      directory, access: args.access, reason: args.reason.replace(/[\p{Cc}\p{Cf}]/gu, ' '),
      signal: controller.signal,
    })).then(allowed => {
      if (controller.signal.aborted || this.closed) return;
      request.status = allowed && directoryStillExists(request) ? 'approved' : 'denied';
      this.changed();
    }).catch(reject).finally(() => clearTimeout(timer));
    this.changed();
    return { requestId: id, status: 'pending' };
  }

  call(principal, name, args) {
    if (this.closed) throw new Error('本机目录权限通道已关闭。');
    if (name === 'RequestDirectoryAccess') return this.request(principal, args);
    const grant = this.requests.get(args.requestId);
    if (!grant || grant.principal !== principal) throw new Error('目录授权不存在或已收回，请重新申请。');
    if (grant.status === 'approved' && !directoryStillExists(grant)) {
      grant.status = 'denied';
      this.changed();
    }
    if (name === 'CheckDirectoryAccess') return { status: grant.status, directory: grant.directory, access: grant.access };
    if (grant.status !== 'approved') throw new Error('目录授权尚未批准或已经失效。');
    const write = name === 'WriteProjectFile';
    if (write && grant.access !== 'read-write') throw new Error('该目录当前只授予了读取权限。');
    const target = projectPath(grant, args.path, !write);
    const stat = inspect(target, write);
    if (write) return writeText(target, stat, args);
    if (args.operation === 'read') return readText(target, stat);
    if (args.operation === 'info') return { type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtime.toISOString() };
    if (args.operation === 'list' && stat.isDirectory()) return { entries: children(target) };
    if (args.operation === 'search') return searchText(target, args.query);
    throw new Error('不支持该文件操作或所选路径类型。');
  }

  summary() {
    return [...this.requests.values()].filter(request => request.status === 'approved' || request.status === 'pending')
      .map(({ directory, access, status }) => ({ directory, access, status }));
  }

  revoke() {
    const requests = [...this.requests.values()];
    this.requests.clear();
    for (const request of requests) request.controller.abort();
    this.changed();
  }

  close() {
    this.closed = true;
    this.revoke();
  }
}

async function createDirectoryAccessBridge(access) {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from('Bearer ' + token);
  const server = http.createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const received = Buffer.from(request.headers.authorization || '');
    if (received.length !== authorization.length || !timingSafeEqual(received, authorization)) return reply(401, {});
    if (request.method !== 'POST' || request.url !== '/rpc') return reply(404, {});
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) return reply(413, {});
        chunks.push(chunk);
      }
      const { principal, name, args } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof principal !== 'string' || principal.length > 128 ||
          !['RequestDirectoryAccess', 'CheckDirectoryAccess', 'ReadProjectFiles', 'WriteProjectFile'].includes(name) ||
          !args || typeof args !== 'object' || Array.isArray(args)) return reply(400, {});
      return reply(200, { value: access.call(principal, name, args) });
    } catch (error) {
      return reply(200, { error: error.code || error instanceof SyntaxError || error instanceof TypeError
        ? '无法处理文件请求，请检查路径、文本编码和文件状态。' : error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { token, url: 'http://127.0.0.1:' + server.address().port + '/rpc', close() {
    access.close();
    server.close();
    server.closeAllConnections();
  } };
}

module.exports = { DirectoryAccess, createDirectoryAccessBridge };
