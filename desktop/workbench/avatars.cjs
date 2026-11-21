const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const idPattern = /^[a-f0-9]{32}$/;

class Avatars {
  constructor(directory, nativeImage, presetDirectory = path.join(__dirname, '../assets/model-avatars')) {
    this.directory = directory; this.nativeImage = nativeImage; this.cache = new Map();
    this.presetDirectory = presetDirectory;
    this.presets = JSON.parse(fs.readFileSync(path.join(presetDirectory, 'presets.json'), 'utf8'));
    fs.mkdirSync(directory, { recursive: true });
  }
  defaultId(engine) { return engine === 'claude' ? 'preset-claude' : engine === 'opencode' ? 'preset-deepseek' : 'preset-gpt'; }
  defaults() { return this.presets.map(item => ({ id: item.id, name: item.name, src: this.get(item.id) })); }
  get(id) {
    const preset = this.presets.find(item => item.id === id);
    if (!preset && !idPattern.test(id || '')) return '';
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const file = preset ? path.join(this.presetDirectory, preset.file) : path.join(this.directory, id + '.jpg');
      if (fs.statSync(file).size > 128 * 1024) return '';
      const bytes = fs.readFileSync(file);
      const value = 'data:image/jpeg;base64,' + bytes.toString('base64');
      this.cache.set(id, value); return value;
    } catch { return ''; }
  }
  list() {
    return fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{32}\.jpg$/.test(name))
      .map(name => ({ id: name.slice(0, -4), src: this.get(name.slice(0, -4)) })).filter(item => item.src);
  }
  async import(filename) {
    const info = await fs.promises.stat(filename);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Choose an image smaller than 16 MiB.');
    if (!/\.(png|jpe?g|webp)$/i.test(filename)) throw new Error('Choose a PNG, JPEG or WebP image.');
    const image = this.nativeImage.createFromBuffer(await fs.promises.readFile(filename));
    if (image.isEmpty()) throw new Error('The selected image could not be decoded. Try PNG or JPEG.');
    const { width, height } = image.getSize();
    if (!width || !height || width * height > 25000000 || Math.max(width, height) > 16384) throw new Error('Choose an image smaller than 25 megapixels.');
    const side = Math.min(width, height);
    const cropped = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
    const bytes = cropped.resize({ width: 256, height: 256, quality: 'best' }).toJPEG(88);
    if (!bytes.length || bytes.length > 128 * 1024) throw new Error('The image could not be compressed for an avatar.');
    const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const file = path.join(this.directory, id + '.jpg');
    if (!fs.existsSync(file)) {
      if (this.list().length >= 128) throw new Error('The local avatar library is full (128 images).');
      await fs.promises.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    return { id, src: this.get(id) };
  }
}
module.exports = { Avatars, idPattern };
