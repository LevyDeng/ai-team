const crypto = require('node:crypto');
const maxEntries = 20;
const successful = new Set(['complete', 'limit', 'answered', 'summary']);

function initialize(chat) {
  chat.inputQueue = (Array.isArray(chat.inputQueue) ? chat.inputQueue : []).filter(entry => {
    // A crash after submission must not replay an already accepted task.
    return entry?.id && entry.value && !chat.messages.some(message => message.inputQueueId === entry.id);
  });
  for (const entry of chat.inputQueue) entry.state = 'pending';
  if (chat.inputQueue.length) { chat.queuePaused = true; chat.queueReason = 'restart'; }
}

class InputQueue {
  constructor({ store, busy, start, interrupt, accept = () => {}, changed = () => {} }) {
    Object.assign(this, { store, busy, start, interrupt, accept, changed });
    this.dispatching = new Set(); this.interrupting = new Map(); this.closed = false;
  }
  chat(id) { return this.store.get('chats', id); }
  save() { this.store.save(); this.changed(); }
  kick(id) { if (!this.closed) queueMicrotask(() => this.pump(id)); }
  submit(id, value, mode = 'queue') {
    if (this.closed) throw new Error('Relay Desk is closing.');
    if (!['queue', 'interrupt'].includes(mode)) throw new Error('Choose a valid input queue mode.');
    const chat = this.chat(id); chat.inputQueue ||= [];
    if (chat.inputQueue.length >= maxEntries) throw new Error('The input queue is full (20 messages). Remove an entry before sending.');
    const wasEmpty = !chat.inputQueue.length;
    const entry = { id: crypto.randomUUID(), at: Date.now(), state: 'pending', value: structuredClone(value) };
    if (mode === 'interrupt' && this.dispatching.has(id)) throw new Error('Wait for the pending message to finish submitting before interrupting.');
    chat.inputQueue[mode === 'interrupt' ? 'unshift' : 'push'](entry);
    if (wasEmpty) { chat.queuePaused = false; chat.queueReason = ''; chat.queueError = ''; }
    this.accept(chat, entry.value);
    if (mode === 'interrupt') this.requestInterrupt(id);
    this.save(); this.kick(id);
    return { accepted: true, queued: true, queueId: entry.id };
  }
  requestInterrupt(id) {
    const chat = this.chat(id); chat.queuePaused = false; chat.queueReason = ''; chat.queueError = '';
    if (!this.busy(id)) return;
    this.clearInterrupt(id);
    const timer = setTimeout(() => {
      this.interrupting.delete(id);
      if (this.closed || !this.store.state.chats.some(chat => chat.id === id)) return;
      this.pause(id, 'interrupt_timeout');
    }, 30000); timer.unref?.();
    this.interrupting.set(id, timer);
    try { this.interrupt(id); }
    catch (error) { this.clearInterrupt(id); chat.queuePaused = true; chat.queueReason = 'blocked'; chat.queueError = error.message; }
  }
  clearInterrupt(id) { clearTimeout(this.interrupting.get(id)); this.interrupting.delete(id); }
  settled(id, state) {
    if (this.closed) return;
    const chat = this.store.state.chats.find(chat => chat.id === id); if (!chat) return;
    const priority = this.interrupting.has(id); this.clearInterrupt(id);
    if (!successful.has(state) && !(priority && state === 'paused')) {
      chat.queuePaused = true; chat.queueReason = state || 'unknown';
    }
    this.save(); this.kick(id);
  }
  pause(id, reason = 'manual') {
    this.clearInterrupt(id); const chat = this.chat(id);
    chat.queuePaused = true; chat.queueReason = reason; this.save();
  }
  resume(id) {
    if (this.closed) throw new Error('Relay Desk is closing.');
    const chat = this.chat(id); chat.queuePaused = false; chat.queueReason = ''; chat.queueError = '';
    this.save(); this.kick(id);
  }
  entry(id, entryId) {
    const chat = this.chat(id), entry = chat.inputQueue?.find(entry => entry.id === entryId);
    if (!entry) throw new Error('This queued message no longer exists.');
    if (entry.state === 'dispatching') throw new Error('This message is being submitted. Wait a moment.');
    return { chat, entry };
  }
  remove(id, entryId) {
    const { chat, entry } = this.entry(id, entryId);
    chat.inputQueue = chat.inputQueue.filter(item => item !== entry); this.save(); return entry;
  }
  move(id, entryId, offset) {
    if (![-1, 1].includes(offset)) throw new Error('Choose an adjacent queue position.');
    const { chat, entry } = this.entry(id, entryId), index = chat.inputQueue.indexOf(entry), target = index + offset;
    if (target >= 0 && target < chat.inputQueue.length && chat.inputQueue[target].state !== 'dispatching') {
      chat.inputQueue.splice(index, 1); chat.inputQueue.splice(target, 0, entry); this.save();
    }
  }
  now(id, entryId) {
    if (this.dispatching.has(id)) throw new Error('Wait for the pending message to finish submitting before interrupting.');
    const { chat, entry } = this.entry(id, entryId);
    chat.inputQueue = [entry, ...chat.inputQueue.filter(item => item !== entry)];
    this.requestInterrupt(id); this.save(); this.kick(id);
  }
  async pump(id) {
    if (this.closed || this.dispatching.has(id)) return;
    const chat = this.store.state.chats.find(chat => chat.id === id);
    if (!chat || chat.queuePaused || !chat.inputQueue?.length || this.busy(id)) return;
    const entry = chat.inputQueue[0]; this.dispatching.add(id); entry.state = 'dispatching'; this.save();
    try {
      const result = await this.start(entry.value, entry.id);
      if (!result?.accepted) throw new Error('The queued message was not accepted.');
      chat.inputQueue = chat.inputQueue.filter(item => item !== entry);
    } catch (error) {
      // Submission can become uncertain after writing to a native terminal.
      // Preserve its history entry instead of automatically submitting it twice.
      if (chat.messages.some(message => message.inputQueueId === entry.id)) chat.inputQueue = chat.inputQueue.filter(item => item !== entry);
      else entry.state = 'pending';
      chat.queuePaused = true; chat.queueReason = 'blocked'; chat.queueError = error.message;
    } finally {
      this.dispatching.delete(id); this.save(); this.kick(id);
    }
  }
  close() {
    this.closed = true;
    for (const id of this.interrupting.keys()) this.clearInterrupt(id);
    for (const chat of this.store.state.chats) if (chat.inputQueue?.length) { chat.queuePaused = true; chat.queueReason = 'restart'; }
    this.store.save();
  }
}
module.exports = { InputQueue, initialize, maxEntries };
