const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('native file drops become paths before crossing the renderer bridge', async () => {
  let api;
  let dropHandler;
  const calls = [];
  const electron = {
    contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return []; }, on() {}, removeListener() {} },
    webUtils: { getPathForFile: (file) => file.nativePath }
  };
  const browserWindow = {
    addEventListener(name, handler, capture) {
      if (name === 'drop') { assert.equal(capture, true); dropHandler = handler; }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8'), {
    require: (name) => { assert.equal(name, 'electron'); return electron; },
    window: browserWindow,
    Set,
    Array,
    Error
  });
  const received = [];
  api.onDroppedFiles((paths) => received.push(paths));
  let prevented = false;
  let stopped = false;
  dropHandler({
    dataTransfer: { files: { 0: { nativePath: 'C:/work/photo.png' }, length: 1 } },
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; }
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(received.length, 1);
  assert.deepEqual(Array.from(received[0]), ['C:/work/photo.png']);
  await api.stageDroppedFiles('session-id', received[0]);
  assert.deepEqual(Array.from(calls[0]), ['relay:file-stage', 'session-id', received[0]]);
  dropHandler({
    dataTransfer: { files: { length: 0 }, types: ['Files'] },
    preventDefault() {},
    stopPropagation() {}
  });
  assert.deepEqual(Array.from(received[1]), []);
});
