const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const maxImageBytes = 2 * 1024 * 1024;
const maxCacheBytes = 128 * 1024 * 1024;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const imageNamePattern = /^[a-f0-9-]{36}\.(png|jpg)$/;
const maxSourceImageBytes = 32 * 1024 * 1024;

async function readClipboardImage(clipboard, nativeImage) {
  // Legacy clipboard.read(format) is not the new asynchronous read() API.
  if (typeof clipboard.readImage === 'function') return clipboard.readImage();
  if (typeof clipboard.read === 'function') {
    const items = await clipboard.read();
    for (const item of items) {
      for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
        if (!item.types.includes(type)) continue;
        const blob = await item.getType(type);
        if (!Number.isSafeInteger(blob.size) || blob.size <= 0) continue;
        if (blob.size > maxSourceImageBytes) throw new Error('Clipboard image source exceeds 32 MiB. Copy a smaller region.');
        const bytes = Buffer.from(await blob.arrayBuffer());
        if (bytes.length > maxSourceImageBytes) throw new Error('Clipboard image source exceeds 32 MiB. Copy a smaller region.');
        const image = nativeImage.createFromBuffer(bytes);
        if (!image.isEmpty()) return image;
      }
    }
    throw new Error('The clipboard does not contain a readable image.');
  }
  throw new Error('The clipboard image API is unavailable in this runtime.');
}

class ClipboardImages {
  constructor(directory) { this.directory = directory; }

  prepare(protectedPaths = new Set()) {
    fs.mkdirSync(this.directory, { recursive: true });
    let bytes = 0;
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !imageNamePattern.test(entry.name)) continue;
      const filePath = path.join(this.directory, entry.name);
      const info = fs.lstatSync(filePath);
      if (Date.now() - info.mtimeMs > retentionMs && !protectedPaths.has(filePath)) fs.unlinkSync(filePath);
      else bytes += info.size;
    }
    return bytes;
  }

  stage(image, protectedPaths) {
    if (image.isEmpty()) throw new Error('The clipboard does not contain a readable image.');
    const original = image.getSize();
    if (!original.width || !original.height || original.width * original.height > 64000000 || Math.max(original.width, original.height) > 32768) {
      throw new Error('Clipboard image exceeds the local decoding limit. Copy a smaller region.');
    }
    const scale = Math.min(1, 1568 / Math.max(original.width, original.height), Math.sqrt(1500000 / (original.width * original.height)));
    const size = { width: Math.max(1, Math.round(original.width * scale)), height: Math.max(1, Math.round(original.height * scale)), quality: 'best' };
    const normalized = image.resize(size);
    let bytes = normalized.toPNG();
    let extension = 'png';
    if (bytes.length > maxImageBytes) {
      extension = 'jpg';
      for (const quality of [85, 70, 55]) {
        bytes = normalized.toJPEG(quality);
        if (bytes.length <= maxImageBytes) break;
      }
    }
    if (!bytes.length || bytes.length > maxImageBytes) throw new Error('Unable to compress this image below 2 MiB. Copy a smaller region.');
    if (this.prepare(protectedPaths) + bytes.length > maxCacheBytes) throw new Error('The local image cache is full. Remove pending images or try again after old images expire.');
    const name = `${crypto.randomUUID()}.${extension}`;
    const filePath = path.join(this.directory, name);
    fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 });
    const thumbnailScale = Math.min(1, 112 / size.width, 72 / size.height);
    const thumbnail = normalized.resize({ width: Math.max(1, Math.round(size.width * thumbnailScale)), height: Math.max(1, Math.round(size.height * thumbnailScale)), quality: 'good' }).toDataURL();
    return { path: filePath, name, sizeBytes: bytes.length, kind: 'clipboard-image', width: size.width, height: size.height, format: extension === 'png' ? 'PNG' : 'JPEG', thumbnail };
  }

  remove(file) {
    if (file?.kind !== 'clipboard-image' || path.dirname(file.path) !== this.directory || !imageNamePattern.test(path.basename(file.path))) return;
    // Cleanup failures must not turn an already submitted message into a retry.
    try { fs.unlinkSync(file.path); } catch {}
  }
}

module.exports = { ClipboardImages, maxImageBytes, imageNamePattern, readClipboardImage };
