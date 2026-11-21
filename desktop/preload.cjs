const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke('relay:' + name, ...args);
const droppedFileListeners = new Set();
window.addEventListener('drop', (event) => {
  const data = event.dataTransfer;
  const files = Array.from(data?.files || []);
  const hasFiles = files.length || Array.from(data?.types || []).includes('Files') || Array.from(data?.items || []).some((item) => item.kind === 'file');
  if (!hasFiles) return;
  event.preventDefault();
  event.stopPropagation();
  const paths = [];
  for (const file of files) {
    try {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) paths.push(filePath);
    } catch {}
  }
  for (const listener of droppedFileListeners) listener(paths);
}, true);
contextBridge.exposeInMainWorld('relay', {
  snapshot: invoke('snapshot'), connect: invoke('connect'), disconnect: invoke('disconnect'),
  keepAwake: invoke('keep-awake'),
  refreshUsage: invoke('refresh-usage'),
  connectionSettings: invoke('settings-get'), saveConnectionSettings: invoke('settings-save'), pickSshKey: invoke('settings-key-pick'),
  activeSessions: invoke('active-sessions'), releaseSession: invoke('release-session'),
  forceControl: invoke('force-control'),
  reconnectMcp: invoke('mcp-reconnect'),
  addProject: invoke('project-add'), addSession: invoke('session-add'), openSession: invoke('session-open'),
  pickProjectFolder: invoke('project-folder-pick'), saveProjectFolder: invoke('project-folder-save'), openProjectPath: invoke('project-path-open'),
  moveProject: invoke('project-move'), projectFiles: invoke('project-files'),
  projectTerminals: invoke('project-terminals'), openProjectTerminal: invoke('project-terminal-open'),
  inputProjectTerminal: invoke('project-terminal-input'), resizeProjectTerminal: invoke('project-terminal-resize'), closeProjectTerminal: invoke('project-terminal-close'),
  previewProjectDelete: invoke('project-delete-preview'), deleteProject: invoke('project-delete'),
  readSession: invoke('session-read'), sessionHistory: invoke('session-history'),
  renameSession: invoke('session-rename'), endSession: invoke('session-end'),
  setAssistantDefaults: invoke('assistant-defaults'), setSessionSettings: invoke('session-settings'),
  input: invoke('input'), resize: invoke('resize'), newWindow: invoke('new-window'),
  copyText: invoke('clipboard-write'),
  readClipboardText: invoke('clipboard-read-text'),
  openLink: invoke('open-link'),
  pasteClipboardImage: invoke('clipboard-image'),
  pickLocalFiles: invoke('file-pick'),
  stageDroppedFiles: invoke('file-stage'),
  onDroppedFiles: (callback) => {
    if (typeof callback !== 'function') throw new Error('Invalid drop listener.');
    droppedFileListeners.add(callback);
    return () => droppedFileListeners.delete(callback);
  },
  discardLocalFiles: invoke('file-discard'), sendMessage: invoke('send-message'),
  prepareMessage: invoke('message-prepare'), messageRecords: invoke('message-records'),
  showEnv: invoke('show-env'), showLogs: invoke('show-logs'),
  on: (event, callback) => {
    if (!['status', 'log', 'workspace', 'data', 'ended', 'completed', 'unread', 'keep-awake', 'capacity', 'monitor', 'session-connections', 'project-terminal'].includes(event)) throw new Error('Invalid event.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('relay:' + event, listener);
    return () => ipcRenderer.removeListener('relay:' + event, listener);
  }
});
