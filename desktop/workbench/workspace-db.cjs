const { DatabaseSync } = require('node:sqlite');

const entityKinds = ['projects', 'roles', 'locations'];
const detailFields = ['terminal', 'activities'];
const unread = Symbol('unread detail');
const details = new WeakMap();

function messageData(message) {
  const data = {};
  for (const key of Object.keys(message)) {
    if (!detailFields.includes(key)) data[key] = message[key];
  }
  return data;
}

function messageView(message) {
  const data = messageData(message);
  const cell = detailCell(message, 'activities');
  data.activityCount = cell?.value === unread ? cell.count : (message.activities?.length || 0);
  return data;
}

function detailCell(message, field) {
  const cell = details.get(message)?.[field];
  return cell && Object.getOwnPropertyDescriptor(message, field)?.get === cell.get ? cell : undefined;
}

function readMessageDetail(message, field) {
  const cell = detailCell(message, field);
  return cell?.value === unread ? JSON.parse(cell.read()) : message[field];
}

class WorkspaceDatabase {
  constructor(file, { keepOpen = false } = {}) {
    this.file = file;
    this.rows = new Map();
    if (keepOpen) this.connection = this.open();
    try {
      this.use(db => {
        const { user_version: version } = db.prepare('PRAGMA user_version').get();
        if (version > 1) throw new Error('This workspace requires a newer version of AI Team.');
        db.exec(`
          PRAGMA journal_mode = WAL;
          BEGIN;
          CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS entities (
            kind TEXT, id TEXT, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id)
          ) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS messages (
            chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE, position INTEGER,
            data TEXT NOT NULL, activity_count INTEGER NOT NULL, has_terminal INTEGER NOT NULL,
            PRIMARY KEY (chat_id, position)
          ) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS message_details (
            chat_id TEXT, position INTEGER, field TEXT, data TEXT NOT NULL,
            PRIMARY KEY (chat_id, position, field),
            FOREIGN KEY (chat_id, position) REFERENCES messages(chat_id, position) ON DELETE CASCADE
          ) WITHOUT ROWID;
          PRAGMA user_version = 1;
          COMMIT;
        `);
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  open() {
    const db = new DatabaseSync(this.file);
    db.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1500');
    return db;
  }

  use(fn) {
    if (this.connection) return fn(this.connection);
    const db = this.open();
    this.connection = db;
    try { return fn(db); }
    finally { db.close(); this.connection = undefined; }
  }

  close() {
    this.connection?.close();
    this.connection = undefined;
  }

  load({ cache = true, eager = false } = {}) {
    return this.use(db => {
      const root = db.prepare('SELECT data FROM workspace WHERE id = 1').get();
      if (!root) return undefined;
      const state = JSON.parse(root.data);
      const rows = new Map([['workspace', root.data]]);
      const entities = db.prepare('SELECT id, position, data FROM entities WHERE kind = ? ORDER BY position');
      for (const kind of entityKinds) {
        state[kind] = entities.all(kind).map(row => {
          rows.set(JSON.stringify([kind, row.id]), row);
          return JSON.parse(row.data);
        });
      }
      const messages = db.prepare('SELECT position, data, activity_count, has_terminal FROM messages WHERE chat_id = ? ORDER BY position');
      state.chats = db.prepare('SELECT id, position, data FROM chats ORDER BY position').all().map(row => {
        const chat = JSON.parse(row.data);
        const stored = [];
        chat.messages = messages.all(row.id).map(entry => {
          const message = JSON.parse(entry.data);
          stored.push({ message, data: entry.data, counts: [entry.has_terminal ? 1 : -1, entry.activity_count] });
          if (entry.has_terminal) this.bind(message, 'terminal', row.id, entry.position, 1);
          if (entry.activity_count >= 0) this.bind(message, 'activities', row.id, entry.position, entry.activity_count);
          if (eager) for (const field of detailFields) {
            if (field in message) Object.defineProperty(message, field, { value: message[field], enumerable: true, writable: true, configurable: true });
          }
          return message;
        });
        rows.set(JSON.stringify(['chats', row.id]), { ...row, messages: stored });
        return chat;
      });
      if (cache) this.rows = rows;
      return state;
    });
  }

  bind(message, field, chatId, position, count, current = unread, encoded = unread) {
    const cell = { value: current, encoded, chatId, position, count };
    cell.read = () => this.use(db => db.prepare('SELECT data FROM message_details WHERE chat_id = ? AND position = ? AND field = ?').get(chatId, position, field)).data;
    cell.get = () => {
      if (cell.value === unread) {
        cell.encoded = cell.read();
        cell.value = JSON.parse(cell.encoded);
      }
      return cell.value;
    };
    const fields = details.get(message) || {};
    fields[field] = cell;
    details.set(message, fields);
    Object.defineProperty(message, field, {
      enumerable: true, configurable: true, get: cell.get, set: value => { cell.value = value; },
    });
  }

  saveDraft(chatId, draft) {
    const row = this.rows.get(JSON.stringify(['chats', chatId]));
    const data = JSON.stringify({ ...JSON.parse(row.data), draft });
    if (data === row.data) return;
    this.use(db => db.prepare('UPDATE chats SET data = ? WHERE id = ?').run(data, chatId));
    row.data = data;
  }

  historyVersion(chatId) {
    return this.rows.get(JSON.stringify(['chats', chatId]))?.revision || 0;
  }

  save(state) {
    const { projects, roles, locations, chats, ...workspace } = state;
    const next = new Map();
    const bindings = [];
    this.use(db => {
      // Materialize details before rewriting positions that a lazy getter still points to.
      for (const chat of chats) chat.messages.forEach((message, index) => {
        for (const field of detailFields) {
          const cell = detailCell(message, field);
          if (cell && (cell.position !== index || cell.chatId !== chat.id)) cell.get();
        }
      });
      const put = (table, columns, keys) => {
        const fields = columns.split(', ');
        return db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${fields.map(() => '?').join(', ')})
          ON CONFLICT (${keys}) DO UPDATE SET ${fields.map(name => `${name} = excluded.${name}`).join(', ')}`);
      };
      const workspaceData = JSON.stringify(workspace);
      const putEntity = put('entities', 'kind, id, position, data', 'kind, id');
      const putChat = put('chats', 'id, position, data', 'id');
      const putMessage = put('messages', 'chat_id, position, data, activity_count, has_terminal', 'chat_id, position');
      const putDetail = put('message_details', 'chat_id, position, field, data', 'chat_id, position, field');
      const deleteDetail = db.prepare('DELETE FROM message_details WHERE chat_id = ? AND position = ? AND field = ?');
      const deleteTail = db.prepare('DELETE FROM messages WHERE chat_id = ? AND position >= ?');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (this.rows.get('workspace') !== workspaceData) put('workspace', 'id, data', 'id').run(1, workspaceData);
        next.set('workspace', workspaceData);
        for (const [kind, records] of Object.entries({ projects, roles, locations })) {
          records.forEach((record, position) => {
            const key = JSON.stringify([kind, record.id]);
            const data = JSON.stringify(record);
            const previous = this.rows.get(key);
            if (data !== previous?.data || position !== previous.position) putEntity.run(kind, record.id, position, data);
            next.set(key, { position, data });
          });
        }
        chats.forEach((chat, position) => {
          const { messages, ...metadata } = chat;
          const key = JSON.stringify(['chats', chat.id]);
          const previous = this.rows.get(key);
          const data = JSON.stringify(metadata);
          if (data !== previous?.data || position !== previous.position) putChat.run(chat.id, position, data);
          let historyChanged = messages.length !== (previous?.messages.length || 0);
          const stored = messages.map((message, index) => {
            const prior = previous?.messages[index];
            const hot = JSON.stringify(messageData(message));
            const counts = [-1, -1];
            const changes = [];
            for (const [i, field] of detailFields.entries()) {
              const cell = detailCell(message, field);
              const sameRow = prior?.message === message && cell?.chatId === chat.id && cell.position === index;
              if (sameRow && cell.value === unread) {
                counts[i] = cell.count;
                continue;
              }
              const value = message[field];
              const encoded = JSON.stringify(value);
              counts[i] = encoded === undefined ? -1 : (field === 'activities' ? value?.length || 0 : 1);
              const changed = encoded === undefined ? prior?.counts[i] >= 0 : (!sameRow || cell.encoded !== encoded);
              if (changed) changes.push([field, value, encoded, counts[i]]);
            }
            if (hot !== prior?.data || changes.length) {
              putMessage.run(chat.id, index, hot, counts[1], Number(counts[0] >= 0));
              historyChanged = true;
            }
            for (const [field, value, encoded, count] of changes) {
              if (encoded === undefined) {
                if (prior) deleteDetail.run(chat.id, index, field);
              } else {
                putDetail.run(chat.id, index, field, encoded);
                bindings.push([message, field, chat.id, index, count, field === 'terminal' ? unread : value, field === 'terminal' ? unread : encoded]);
              }
            }
            return { message, data: hot, counts };
          });
          if (messages.length < (previous?.messages.length || 0)) deleteTail.run(chat.id, messages.length);
          next.set(key, { position, data, messages: stored, revision: (previous?.revision || 0) + Number(historyChanged) });
        });
        const removeChat = db.prepare('DELETE FROM chats WHERE id = ?');
        const removeEntity = db.prepare('DELETE FROM entities WHERE kind = ? AND id = ?');
        for (const key of this.rows.keys()) {
          if (next.has(key)) continue;
          const [kind, id] = JSON.parse(key);
          if (kind === 'chats') removeChat.run(id);
          else removeEntity.run(kind, id);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    for (const args of bindings) this.bind(...args);
    this.rows = next;
  }
}

module.exports = { WorkspaceDatabase, messageData, messageView, readMessageDetail };
