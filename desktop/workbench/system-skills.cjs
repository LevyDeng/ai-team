const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shellQuote } = require('../config.cjs');

const definitions = {
  codex: { label: 'Codex', prefix: 'co', home: '.codex', env: 'CODEX_HOME', roots: ['skills', 'skills/.system'], managed: 'codex' },
  claude: { label: 'Claude Code', prefix: 'cl', home: '.claude', env: 'CLAUDE_CONFIG_DIR', roots: ['skills'], managed: 'claude', synced: true },
  deepseek: { label: 'DeepSeek', prefix: 'ds', home: '.deepseek', roots: ['skills'] },
  antigravity: { label: 'Antigravity', prefix: 'ag', home: '.gemini', roots: ['antigravity-cli/skills', 'skills', 'config/skills', 'antigravity/skills'] }
};
const prefixPattern = /^[a-z](?:[a-z0-9-]{0,14}[a-z0-9])?$/;
const maxSkillBytes = 128 * 1024;
const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n((?:[^\n]*\n)*?)---[ \t]*(?:\r?\n|$)/;

function directoriesIn(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name)).map(entry => path.join(root, entry.name));
  } catch { return []; }
}

function parseSkill(folder, markdown) {
  const header = frontmatter.exec(markdown);
  const metadata = header ? require('yaml').parse(header[1], { maxAliasCount: 0, logLevel: 'silent' }) : {};
  const instructions = markdown.slice(header?.[0].length || 0).trim();
  if (!instructions) return null;
  const name = typeof metadata?.name === 'string' ? metadata.name.trim().slice(0, 100) : '';
  const description = typeof metadata?.description === 'string' ? metadata.description.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return {
    name: name || folder,
    description,
    instructions,
    modelInvocable: !/^(?:true|on|yes|1)$/i.test(String(metadata?.['disable-model-invocation'] ?? '')),
    userInvocable: !/^(?:false|off|no|0)$/i.test(String(metadata?.['user-invocable'] ?? ''))
  };
}

function scanLocal(roots, synced) {
  const files = [];
  for (const root of roots) {
    const directories = directoriesIn(root);
    if (synced) directories.push(...directoriesIn(path.join(root, 'synced')).flatMap(directoriesIn));
    for (const folder of directories) {
      const filename = path.join(folder, 'SKILL.md');
      try {
        const file = fs.lstatSync(filename);
        if (!file.isFile() || file.size > maxSkillBytes) continue;
        files.push({ name: path.basename(folder), folder, markdown: fs.readFileSync(filename, 'utf8') });
      } catch { continue; }
    }
  }
  return files;
}

async function readRemoteSkills(locations, location, source) {
  const config = { managed: Boolean(location.managed), definition: definitions[source.id], directory: source.directory };
  const script = fs.readFileSync(path.join(__dirname, 'read-system-skills.py'), 'utf8');
  const command = 'python3 -c ' + shellQuote(script) + ' ' + shellQuote(JSON.stringify(config));
  const result = await locations.readSkillCatalog(location.id, command);
  return JSON.parse(result).map(({ contents, ...file }) => ({ ...file, markdown: Buffer.from(contents, 'base64').toString('utf8') }));
}

function catalogEntries(files, source) {
  const items = new Map();
  for (const { name, folder, runtimeFolder, markdown } of files) {
    const key = name.toLowerCase();
    if (items.has(key)) continue;
    try {
      const skill = parseSkill(name, markdown);
      if (!skill) continue;
      const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill';
      const locationKey = source.locationId === 'local' ? '' : source.locationId + ':';
      items.set(key, {
        ...skill, slug, id: `system:${source.id}:${locationKey}${name}`, source: source.id,
        sourceLabel: source.label, locationId: source.locationId, locationName: source.locationName,
        kind: 'prompt', folder, runtimeFolder
      });
    } catch { continue; }
  }
  return [...items.values()];
}

class SystemSkills {
  constructor(store, directories, locations) {
    this.store = store;
    this.directories = directories;
    this.locations = locations;
    this.catalog = new Map();
    this.generation = 0;
    this.refresh(false);
  }

  locationsForSkills() {
    return this.store.state.locations.filter(location => location.id === 'local' || location.type === 'ssh' && location.os === 'linux');
  }

  sources() {
    const saved = this.store.state.settings.systemSkillSources || {};
    const locations = this.locationsForSkills();
    return Object.entries(definitions).map(([id, definition]) => {
      const value = saved[id];
      const enabled = value === true || value?.enabled === true;
      const locationId = value?.locationId || 'local';
      const directory = value?.directory || '';
      const location = locations.find(item => item.id === locationId);
      const cached = this.catalog.get(id);
      const current = cached?.locationId === locationId && cached.directory === directory ? cached : null;
      return { id, label: definition.label, defaultPrefix: definition.prefix, enabled, locationId, directory, locationName: location?.name,
        prefix: value?.prefix || definition.prefix, count: current?.entries.length || 0, error: current?.error || '' };
    });
  }

  async saveSources(value) {
    const locations = this.locationsForSkills();
    const prefixes = new Set();
    const settings = {};
    for (const [id, definition] of Object.entries(definitions)) {
      const choice = value?.[id];
      if (typeof choice?.enabled !== 'boolean' || typeof choice.locationId !== 'string' ||
          typeof choice.prefix !== 'string' || typeof choice.directory !== 'string') {
        throw new Error('Choose one location and a slash prefix for each skill source.');
      }
      const { enabled, locationId } = choice;
      const prefix = choice.prefix.trim().toLowerCase() || definition.prefix;
      const directory = choice.directory.trim();
      if (!prefixPattern.test(prefix)) throw new Error('Use a slash prefix of up to 16 letters, digits or hyphens, starting with a letter.');
      if (enabled && prefixes.has(prefix)) throw new Error('Enabled skill sources must have distinct slash prefixes.');
      if (enabled) prefixes.add(prefix);
      if (!locations.some(location => location.id === locationId)) throw new Error('Choose an available skill location.');
      const paths = locationId === 'local' ? path : path.posix;
      if (directory && (directory.length > 2048 || /[\0\r\n]/.test(directory) ||
          !paths.isAbsolute(directory) && !directory.startsWith('~/'))) {
        throw new Error('Use an absolute skill folder or a path beginning with ~/ on the selected machine.');
      }
      settings[id] = { enabled, locationId, prefix, directory };
    }
    this.store.state.settings.systemSkillSources = settings;
    this.store.save();
    await this.refresh();
  }

  async refresh(includeRemote = true) {
    const generation = ++this.generation;
    const locations = this.locationsForSkills();
    await Promise.all(this.sources().map(async source => {
      const location = locations.find(item => item.id === source.locationId);
      if (!source.enabled || !location) {
        this.catalog.delete(source.id);
        return;
      }
      const old = this.catalog.get(source.id);
      const state = {
        locationId: source.locationId, directory: source.directory,
        entries: old?.locationId === source.locationId && old.directory === source.directory ? old.entries : [], error: ''
      };
      this.catalog.set(source.id, state);
      try {
        const definition = definitions[source.id];
        let files;
        if (location.type === 'local') {
          const home = os.homedir();
          const base = path.resolve((definition.env && process.env[definition.env]) || path.join(home, definition.home));
          const roots = source.directory ? [source.directory.startsWith('~/') ? path.join(home, source.directory.slice(2)) : source.directory]
            : this.directories?.[source.id] || definition.roots.map(root => path.join(base, root));
          files = scanLocal(roots, definition.synced);
        } else {
          if (!includeRemote) return;
          files = await readRemoteSkills(this.locations, location, source);
        }
        if (this.generation === generation) state.entries = catalogEntries(files, source);
      } catch (error) {
        if (this.generation === generation) state.error = error.message.slice(0, 240);
      }
    }));
  }

  list(appSkills, disabledIds = this.store.state.settings.disabledSystemSkills) {
    const used = new Set(appSkills.flatMap(skill => [skill.command, skill.name]));
    const disabled = new Set(disabledIds || []);
    return this.sources().flatMap(source => {
      const cached = this.catalog.get(source.id);
      if (!source.enabled || !source.locationName || cached?.locationId !== source.locationId || cached.directory !== source.directory) return [];
      return cached.entries.map(({ instructions, folder, runtimeFolder, slug, ...skill }) => {
        const base = `${source.prefix}-${slug}`.slice(0, 63).replace(/-$/, '');
        let command = base;
        for (let n = 2; used.has(command); n++) {
          const suffix = '-' + n;
          command = base.slice(0, 63 - suffix.length) + suffix;
        }
        used.add(command);
        return { ...skill, command, enabled: !disabled.has(skill.id), ready: true, hasKey: false };
      });
    });
  }

  read(skill) {
    const entry = skill && this.catalog.get(skill.source)?.entries.find(item => item.id === skill.id);
    if (!entry) throw new Error('System skill not found. Refresh skill sources.');
    return { ...skill, instructions: entry.instructions, folder: entry.folder, runtimeFolder: entry.runtimeFolder };
  }

  setEnabled(skill, enabled) {
    this.read(skill);
    if (typeof enabled !== 'boolean') throw new Error('Choose whether to enable this skill.');
    const previous = this.store.state.settings.disabledSystemSkills;
    const disabled = new Set(previous || []);
    if (enabled) disabled.delete(skill.id);
    else disabled.add(skill.id);
    this.store.state.settings.disabledSystemSkills = [...disabled];
    try {
      this.store.save();
    } catch (error) {
      this.store.state.settings.disabledSystemSkills = previous;
      throw error;
    }
  }
}

module.exports = { SystemSkills };
