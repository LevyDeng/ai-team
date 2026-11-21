const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sessionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const phases = new Set(['saved', 'sending', 'submitted', 'unconfirmed', 'accepted', 'failed']);

class MessageOutbox {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
  }
  filename(sessionId) {
    if (!sessionPattern.test(sessionId)) throw new Error('Invalid session ID.');
    return path.join(this.directory, sessionId + '.json');
  }
  list(sessionId) {
    const filename = this.filename(sessionId);
    try {
      const records = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Array.isArray(records) || records.some((item) => !sessionPattern.test(item.id) || item.sessionId !== sessionId || typeof item.text !== 'string' || !phases.has(item.status))) throw new Error('Invalid outgoing message backup.');
      return records;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('Unable to read outgoing message backups. Sending is paused to protect existing text.');
    }
  }
  write(sessionId, records) {
    const filename = this.filename(sessionId);
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(records)); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, filename);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  prepare(sessionId, provider, text, attachments) {
    if (typeof text !== 'string' || text.length > 60000 || !['claude', 'codex'].includes(provider)) throw new Error('Invalid outgoing message.');
    const records = this.list(sessionId);
    // Retain failed or uncertain submissions; bound ordinary sent-message backups.
    const record = { id: crypto.randomUUID(), sessionId, provider, text, attachments, createdAt: Date.now(), updatedAt: Date.now(), status: 'saved' };
    const completed = new Set(records.filter((item) => ['submitted', 'accepted'].includes(item.status)).slice(-9).map((item) => item.id));
    this.write(sessionId, [...records.filter((item) => !['submitted', 'accepted'].includes(item.status) || completed.has(item.id)), record]);
    return record;
  }
  update(sessionId, id, change) {
    const records = this.list(sessionId);
    const record = records.find((item) => item.id === id);
    if (!record) throw new Error('Outgoing message backup not found.');
    Object.assign(record, change, { updatedAt: Date.now() });
    this.write(sessionId, records);
    return record;
  }
  publicRecords(sessionId) {
    return this.list(sessionId).map(({ digest, checkpoint, ...record }) => record);
  }
}

module.exports = { MessageOutbox };
