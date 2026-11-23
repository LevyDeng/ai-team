const fs = require('node:fs/promises');
const path = require('node:path');
const { localRoot } = require('../project-paths.cjs');
const { links, normalize } = require('../path-links.js');

const drivePath = /^[a-z]:[\\/]/i;
const elsewhere = /^(?:[\\/]|~[\\/])/;
const ignored = new Set(['.git', '.hg', '.svn', '.runtime', '.next', '.venv', '__pycache__',
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor', 'obj']);

function reference(value) {
  const filename = normalize(value);
  const localPart = drivePath.test(filename) ? filename.slice(2) : filename;
  if (/[<>:"|?*\x00-\x1f]/.test(localPart)) throw new Error('Invalid file reference.');
  return filename;
}

const folded = value => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const contained = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

async function existing(filename, root) {
  try {
    const resolved = await fs.realpath(filename);
    if (root && !contained(root, resolved)) return;
    const stat = await fs.stat(resolved);
    if (stat.isFile() || stat.isDirectory()) return {
      path: resolved, directory: stat.isDirectory(),
      ...(root && { root, relative: path.relative(root, resolved) || '.' }),
    };
  } catch {}
}

function messagePaths(message, activities = []) {
  const results = new Set();
  const add = value => { if (typeof value === 'string' && results.size < 96) results.add(value); };
  for (const value of message?.imagePaths || []) add(value);
  for (const activity of activities || []) {
    if (activity.status === 'failed') continue;
    for (const value of activity.paths || []) add(value);
    // Older tool records stored file paths only in their display title.
    if (!activity.paths?.length && activity.title?.startsWith('Files: ')) {
      for (const value of activity.title.slice(7).split(', ')) add(value);
    }
  }
  const text = (message?.text || '').slice(0, 65536);
  for (const link of links(text)) if (link.kind === 'local') add(link.value);
  return results;
}

async function scan(roots, suffix, results, { maxEntries, maxMatches, timeoutMs }) {
  const queue = roots.map(root => ({ root, directory: root }));
  const basename = path.posix.basename(suffix);
  const deadline = performance.now() + timeoutMs;
  let visited = 0, incomplete = false;
  for (let index = 0; index < queue.length; index++) {
    if (performance.now() >= deadline) return true;
    const { root, directory } = queue[index];
    try {
      const folder = await fs.opendir(directory);
      for await (const entry of folder) {
        if (++visited > maxEntries || performance.now() >= deadline) return true;
        if (entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) queue.push({ root, directory: filename });
        if (entry.name.toLowerCase() !== basename) continue;
        const relative = folded(path.relative(root, filename));
        if (relative !== suffix && !relative.endsWith('/' + suffix)) continue;
        const match = await existing(filename, root);
        if (match) results.set(folded(match.path), match);
        if (results.size >= maxMatches) return true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') incomplete = true;
    }
  }
  return incomplete;
}

async function findProjectPaths(value, directories, { getHints, search = true,
  maxEntries = 18000, maxMatches = 32, timeoutMs = 1200 } = {}) {
  const filename = reference(value);
  const results = new Map();
  const add = candidate => { if (candidate) results.set(folded(candidate.path), candidate); };
  const result = (incomplete = false) => ({ candidates: [...results.values()], incomplete });
  if (drivePath.test(filename)) {
    add(await existing(filename));
    return result();
  }
  if (elsewhere.test(filename)) return result();

  const relative = path.win32.normalize(filename).replace(/\\+$/, '');
  if (!relative || relative === '..' || relative.startsWith('..\\')) return result();
  const roots = [...new Set((await Promise.all(directories.map(directory => localRoot(directory).catch(() => '')))).filter(Boolean))];
  const suffix = folded(relative);
  const direct = value => Promise.all(roots.map(root => {
    const target = path.resolve(root, value);
    return contained(root, target) ? existing(target, root) : undefined;
  }));

  for (const match of await direct(relative)) add(match);
  const exact = results.size > 0;
  const nameOnly = !/[\\/]/.test(filename) && suffix !== '.';
  if (exact && (!nameOnly || !search)) return result();

  if (getHints) {
    const contextual = [];
    for (const hint of getHints()) {
      let candidate;
      try { candidate = reference(hint); } catch { continue; }
      if (!folded(candidate).endsWith('/' + suffix)) continue;
      if (drivePath.test(candidate)) {
        for (const root of roots) if (contained(root, candidate)) contextual.push(existing(candidate, root));
      } else if (!elsewhere.test(candidate)) contextual.push(...await direct(candidate));
    }
    const found = (await Promise.all(contextual)).filter(Boolean);
    if (found.length) {
      results.clear();
      for (const match of found) add(match);
      return result();
    }
  }
  if (!search || suffix === '.') return result();
  const incomplete = await scan(roots, suffix, results, { maxEntries, maxMatches, timeoutMs });
  return result(incomplete);
}

module.exports = { findProjectPaths, messagePaths };
