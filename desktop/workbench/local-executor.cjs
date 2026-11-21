const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { atomic } = require('./store.cjs');

const taskIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function taskDirectory(workspace, id) {
  if (!taskIdPattern.test(id)) throw new Error('Invalid local task ID.');
  return path.join(workspace, 'local-executor', id);
}

function readRecord(directory, name) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function start(workspace, task, request, app) {
  const directory = taskDirectory(workspace, task.id);
  fs.mkdirSync(path.dirname(directory), {recursive:true});
  fs.mkdirSync(directory);
  atomic(path.join(directory, 'request.json'), request);
  const args = [...(app.isPackaged ? [] : [path.resolve(__dirname, '..')]), '--local-task-executor', directory];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {detached:true, windowsHide:true, stdio:'ignore'});
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      try { atomic(path.join(directory, 'launch.json'), {pid:child.pid}); }
      catch (error) { console.error('Could not save the local executor PID:', error); }
      resolve();
    });
  });
}

async function follow(workspace, task, signal, onProgress) {
  const directory = taskDirectory(workspace, task.id);
  let sequence = 0, cancelRequested = false;
  for (;;) {
    const progress = readRecord(directory, 'progress.json');
    if (progress && progress.sequence > sequence) {
      sequence = progress.sequence;
      onProgress(progress);
    }
    if (progress?.finished) return progress;
    if (signal.aborted && !cancelRequested) {
      atomic(path.join(directory, 'cancel.json'), {requested:true});
      cancelRequested = true;
    }
    if (Date.now() - (progress?.at ?? task.createdAt) > 15000) {
      const pid = progress?.pid ?? readRecord(directory, 'launch.json')?.pid;
      try {
        if (!Number.isInteger(pid) || pid < 1) throw new Error('The local task did not start.');
        process.kill(pid, 0);
      } catch (error) {
        if (error.code !== 'EPERM') throw new Error('The local executor stopped reporting. Check the partial output before retrying.');
      }
    }
    await delay(250);
  }
}

function clear(workspace, id) {
  const directory = taskDirectory(workspace, id);
  for (const name of ['request.json', 'launch.json', 'progress.json', 'cancel.json']) {
    try { fs.unlinkSync(path.join(directory, name)); } catch {}
  }
  try { fs.rmdirSync(directory); } catch {}
}

module.exports = { taskDirectory, readRecord, start, follow, clear };
