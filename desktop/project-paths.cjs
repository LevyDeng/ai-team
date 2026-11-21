const fs = require('node:fs/promises');
const path = require('node:path');

async function localRoot(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('Invalid local project folder.');
  const folder = value.trim();
  if (!folder) return '';
  if (!/^[a-z]:[\\/]/i.test(folder)) throw new Error('Choose an absolute local drive folder.');
  try {
    const resolved = await fs.realpath(folder);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Not a folder.');
    return resolved;
  } catch { throw new Error('Local project folder does not exist.'); }
}

async function resolveProjectPath(root, value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value) || /^[\\/]{2}/.test(value)) throw new Error('Invalid local project path.');
  const filename = require('./path-links.js').normalize(value);
  const absolute = /^[a-z]:[\\/]/i.test(filename);
  if (!absolute && !root) throw new Error('Set a local project folder first.');
  const candidate = absolute ? path.normalize(filename) : path.resolve(await localRoot(root), filename);
  let target;
  try { target = await fs.realpath(candidate); } catch { throw new Error('This path does not exist on this computer.'); }
  return target;
}

module.exports = { localRoot, resolveProjectPath };
