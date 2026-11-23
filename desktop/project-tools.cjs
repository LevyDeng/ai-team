const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { shellQuote } = require('./config.cjs');
const { localRoot } = require('./project-paths.cjs');

const listingLimit = 600;
const previewLimit = 96 * 1024;

function projectLocations(project) {
  if (project.locations?.length) return project.locations;
  const locations = [];
  if (project.localPath) locations.push({ kind: 'local', path: project.localPath });
  locations.push({ kind: 'remote', path: project.path });
  return locations;
}

async function validateLocations(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 12) throw new Error('Configure between 1 and 12 project directories.');
  const locations = [];
  const seen = new Set();
  for (const entry of entries) {
    const value = typeof entry?.path === 'string' ? entry.path.trim() : '';
    if (!value || /[\0\r\n]/.test(value)) throw new Error('Enter a path for every project directory.');
    let folder;
    if (entry.kind === 'local') folder = await localRoot(value);
    else if (entry.kind === 'remote' && /^(?:~\/|\/)/.test(value) && value.length <= 1000) folder = value;
    else throw new Error('Remote directories must start with / or ~/.');
    const key = entry.kind === 'local' ? folder.toLowerCase() : path.posix.normalize(folder);
    if (seen.has(`${entry.kind}:${key}`)) throw new Error('Project directories must be unique.');
    seen.add(`${entry.kind}:${key}`);
    locations.push({ kind: entry.kind, path: folder });
  }
  return locations;
}

function getLocation(project, location) {
  const entry = projectLocations(project).find((item) => item.kind === location?.kind && item.path === location.path);
  if (!entry) throw new Error('Select a configured project directory.');
  return entry;
}

function remoteFolder(backend, folder) {
  if (!backend.client || backend.status.ssh !== 'ready' || !backend.remoteDir) throw new Error('Connect to the server first.');
  return folder.startsWith('~/') ? path.posix.join(path.posix.dirname(backend.remoteDir), folder.slice(2)) : folder;
}

const remoteFileScript = `
import itertools, json, os, stat, sys
operation, filename, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
if operation == 'list':
    with os.scandir(filename) as directory:
        entries = list(itertools.islice(directory, limit + 1))
        result = {'entries': [{'name': entry.name, 'directory': entry.is_dir()} for entry in entries[:limit]], 'truncated': len(entries) > limit}
else:
    fd = os.open(filename, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError('Not a regular file.')
        data = source.read(limit + 1)
    result = {'binary': b'\\0' in data, 'truncated': len(data) > limit, 'text': '' if b'\\0' in data else data[:limit].decode('utf-8', 'replace')}
print(json.dumps(result, ensure_ascii=False).encode('utf-8', 'backslashreplace').decode('utf-8'))
`;

async function projectFiles(backend, project, location, parts, operation) {
  const entry = getLocation(project, location);
  if (!Array.isArray(parts) || parts.length > 100 || parts.some((part) => typeof part !== 'string' || !part || part.length > 255 || part === '.' || part === '..' || /[\0/]/.test(part) || (entry.kind === 'local' && /[\\:]/.test(part)))) throw new Error('Invalid file path.');
  if (entry.kind === 'remote') {
    const filename = path.posix.join(remoteFolder(backend, entry.path), ...parts);
    const limit = operation === 'list' ? listingLimit : previewLimit;
    const result = await backend.exec(`python3 -c ${shellQuote(remoteFileScript)} ${operation} ${shellQuote(filename)} ${limit}`);
    return { ...JSON.parse(result), path: filename };
  }
  const filename = path.join(await localRoot(entry.path), ...parts);
  if (operation === 'list') {
    const entries = [];
    let truncated = false;
    for await (const item of await fs.opendir(filename)) {
      if (entries.length === listingLimit) { truncated = true; break; }
      const directory = item.isDirectory() || (item.isSymbolicLink() && Boolean((await fs.stat(path.join(filename, item.name)).catch(() => null))?.isDirectory()));
      entries.push({ name: item.name, directory });
    }
    return { entries, truncated, path: filename };
  }
  if (operation === 'open') return { path: await fs.realpath(filename) };
  if (!(await fs.stat(filename)).isFile()) throw new Error('Not a regular file.');
  const file = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(previewLimit + 1);
    const { bytesRead } = await file.read(buffer);
    const data = buffer.subarray(0, bytesRead);
    const binary = data.includes(0);
    return { binary, truncated: bytesRead > previewLimit, text: binary ? '' : data.subarray(0, previewLimit).toString('utf8'), path: filename };
  } finally { await file.close(); }
}

class ProjectTerminals {
  constructor(backend, emit) {
    this.backend = backend;
    this.emit = emit;
    this.entries = new Map();
  }

  list() { return [...this.entries.values()].map(({ info, output, sequence }) => ({ ...info, output, sequence })); }

  async open(project, location) {
    const entry = getLocation(project, location);
    const cwd = entry.kind === 'local' ? await localRoot(entry.path) : remoteFolder(this.backend, entry.path);
    if (this.closed) throw new Error('ai-team is closing.');
    const existing = [...this.entries.values()].filter((item) => item.info.projectId === project.id);
    if (existing.length >= 8 || this.entries.size >= 24) throw new Error('Close a project terminal before opening another.');
    const id = crypto.randomUUID();
    const number = 1 + Math.max(0, ...existing.map((item) => item.info.number));
    const info = { id, projectId: project.id, kind: entry.kind, cwd, number, state: 'opening' };
    const item = { info, sequence: 0, output: '', pending: '', timer: null, transport: null };
    this.entries.set(id, item);
    const publish = () => this.emit({ type: 'state', info: { ...info } });
    const flush = () => {
      clearTimeout(item.timer);
      item.timer = null;
      if (!item.pending || !this.entries.has(id)) return;
      const data = item.pending;
      item.pending = '';
      item.output = (item.output + data).slice(-160000);
      this.emit({ type: 'data', id, sequence: ++item.sequence, data });
    };
    const write = (data) => {
      if (!this.entries.has(id)) return;
      item.pending += data;
      if (item.pending.length >= 65536) flush();
      else if (!item.timer) item.timer = setTimeout(flush, 24);
    };
    const ended = (error) => {
      if (!this.entries.has(id) || info.state === 'ended') return;
      if (error) write(`\r\n${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}\r\n`);
      flush();
      info.state = 'ended';
      item.transport = null;
      publish();
    };
    publish();
    try {
      if (entry.kind === 'local') {
        const { spawn } = require('node-pty');
        const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const pty = spawn(exe, ['-NoLogo'], { cwd, cols: 80, rows: 24, name: 'xterm-256color', env: process.env, useConptyDll: true });
        item.transport = { write: (data) => pty.write(data), resize: (cols, rows) => pty.resize(cols, rows), close: () => pty.kill() };
        pty.onData(write);
        pty.onExit(() => ended());
      } else {
        const client = this.backend.client;
        const stream = await new Promise((resolve, reject) => client.exec(`cd -- ${shellQuote(cwd)} && exec bash -i`, { pty: { term: 'xterm-256color', cols: 80, rows: 24 } }, (error, value) => error ? reject(error) : resolve(value)));
        if (!this.entries.has(id) || client !== this.backend.client) { stream.close(); throw new Error('SSH is disconnected.'); }
        const decoder = new StringDecoder('utf8');
        item.transport = { write: (data) => stream.write(data), resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0), close: () => stream.close() };
        stream.on('data', (chunk) => write(decoder.write(chunk)));
        stream.stderr.on('data', (chunk) => write(chunk.toString('utf8')));
        stream.on('error', (error) => ended(error));
        stream.on('close', () => { write(decoder.end()); ended(); });
      }
      info.state = 'ready';
      publish();
    } catch (error) { ended(error); }
    return id;
  }

  input(id, data) {
    if (typeof data !== 'string' || data.length > 100000) throw new Error('Invalid terminal input.');
    this.entries.get(id)?.transport?.write(data);
  }

  resize(id, cols, rows) {
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 500 && rows >= 1 && rows <= 250) this.entries.get(id)?.transport?.resize(cols, rows);
  }

  close(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    try { entry.transport?.close(); }
    catch (error) { this.backend.log(error.message); }
    finally { this.emit({ type: 'closed', id }); }
  }

  closeProject(projectId) {
    for (const [id, { info }] of this.entries) if (info.projectId === projectId) this.close(id);
  }

  closeAll() {
    this.closed = true;
    for (const id of this.entries.keys()) this.close(id);
  }
}

module.exports = { ProjectTerminals, projectLocations, validateLocations, projectFiles };
