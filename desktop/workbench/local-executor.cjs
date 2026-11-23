const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { atomic } = require('./store.cjs');

const taskIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const cancelGraceMs = 12000;

function taskDirectory(workspace, id) {
  if (!taskIdPattern.test(id)) throw new Error('Invalid local task ID.');
  return path.join(workspace, 'local-executor', id);
}

function readRecord(directory, name) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function createProgressWriter(directory, write = atomic) {
  let retryAt = 0;
  return record => {
    if (!record.finished && Date.now() < retryAt) return false;
    // An existing progress file can be readable but locked against replacement on Windows.
    const names = record.finished ? ['progress.json', 'result.json'] : ['progress.json'];
    for (const name of names) {
      try {
        write(path.join(directory, name), record);
        retryAt = 0;
        return true;
      } catch (error) {
        if (!error.syscall) throw error;
        retryAt = Date.now() + 1000;
      }
    }
    return false;
  };
}

function readProgress(directory) {
  try {
    if (fs.existsSync(path.join(directory, 'result.json'))) {
      const result = readRecord(directory, 'result.json');
      if (result?.finished) return result;
    }
    return readRecord(directory, 'progress.json');
  } catch (error) {
    if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return null;
    throw error;
  }
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

function stopOwnedWorker(directory, pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) return Promise.resolve(false);
  // Only reclaim a worker whose executable and task argument still match.
  const script = `
    $ProgressPreference = 'SilentlyContinue'
    $worker = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:RELAY_STOP_PID) -ErrorAction Stop
    $argument = [regex]::Escape($env:RELAY_STOP_DIRECTORY)
    if (!$worker -or $worker.ExecutablePath -ne $env:RELAY_STOP_EXECUTABLE -or
        $worker.CommandLine -notmatch ('(?:^|\\s)--local-task-executor\\s+(?:"' + $argument + '"|' + $argument + ')(?:\\s|$)')) { exit 1 }
    & taskkill.exe /PID $env:RELAY_STOP_PID /T /F | Out-Null
    exit $LASTEXITCODE`;
  return new Promise(resolve => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true, timeout: 12000,
      env: {...process.env, RELAY_STOP_PID:String(pid), RELAY_STOP_DIRECTORY:directory, RELAY_STOP_EXECUTABLE:process.execPath},
    }, error => resolve(!error));
  });
}

function requestStop(workspace, id, force = false) {
  const directory = taskDirectory(workspace, id);
  const prior = readRecord(directory, 'cancel.json');
  const request = {requested:true, requestedAt:prior?.requestedAt ?? Date.now(), force:Boolean(force || prior?.force)};
  atomic(path.join(directory, 'cancel.json'), request);
  return request;
}

async function follow(workspace, task, signal, onProgress, {stopWorker = stopOwnedWorker, cancelMs = cancelGraceMs, pollMs = 250, force = () => false} = {}) {
  const directory = taskDirectory(workspace, task.id);
  let sequence = 0;
  let cancel = readRecord(directory, 'cancel.json');
  const savedAt = Date.now();
  for (;;) {
    const progress = readProgress(directory);
    if (progress && progress.sequence > sequence) {
      sequence = progress.sequence;
      onProgress(progress);
    }
    if (progress?.finished) return progress;
    const forceRequested = force();
    if ((signal.aborted && !cancel) || (forceRequested && !cancel?.force)) cancel = requestStop(workspace, task.id, forceRequested);
    if (cancel && (cancel.force || Date.now() - (cancel.requestedAt ?? savedAt) >= cancelMs || progress?.result?.stopConfirmed === false)) {
      const pid = progress?.pid ?? readRecord(directory, 'launch.json')?.pid;
      const stopConfirmed = await stopWorker(directory, pid);
      const final = readProgress(directory);
      if (final?.finished) { if (final.sequence > sequence) onProgress(final); return final; }
      if (stopConfirmed) {
        const receipt = {...final, pid, sequence:sequence+1, at:Date.now(), finished:true,
          messages:(final?.messages || []).map(message => message.status === 'running' ? {...message, status:'cancelled', stopConfirmed:true} : message),
          result:{status:'cancelled', stopConfirmed:true, forced:true}};
        if (!createProgressWriter(directory)(receipt)) throw new Error('后台任务已结束，但无法保存结束记录。请检查项目数据目录的磁盘空间和写入权限。');
        onProgress(receipt);
        return receipt;
      }
      const error = new Error('后台任务未能确认停止。请检查任务输出和进程后再继续。');
      error.code = 'LOCAL_EXECUTOR_STOP_UNCONFIRMED';
      throw error;
    }
    if (!cancel && Date.now() - (progress?.at ?? task.createdAt) > 15000) {
      const pid = progress?.pid ?? readRecord(directory, 'launch.json')?.pid;
      try {
        if (!Number.isInteger(pid) || pid < 1) throw new Error('The local task did not start.');
        process.kill(pid, 0);
      } catch (error) {
        if (error.code !== 'EPERM') {
          const final = readProgress(directory);
          if (final?.finished) { if (final.sequence > sequence) onProgress(final); return final; }
          throw new Error('后台执行器已退出，未能读取结束记录。请检查已有回复和任务输出。');
        }
      }
    }
    await delay(pollMs);
  }
}

function clear(workspace, id) {
  const directory = taskDirectory(workspace, id);
  for (const name of ['request.json', 'launch.json', 'progress.json', 'result.json', 'cancel.json']) {
    try { fs.unlinkSync(path.join(directory, name)); } catch {}
  }
  try { fs.rmdirSync(directory); } catch {}
}

module.exports = { taskDirectory, readRecord, createProgressWriter, start, requestStop, follow, clear };
