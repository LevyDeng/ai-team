const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('login', {
  input: value => ipcRenderer.send('login:input', value),
  authorize: () => ipcRenderer.send('login:authorize'),
  onData: callback => ipcRenderer.on('login:data', (_event, value) => callback(value)),
  onRemote: callback => ipcRenderer.on('login:remote', (_event, hasUrl) => callback(hasUrl)),
  onAuthorizeReady: callback => ipcRenderer.on('login:authorize-ready', () => callback()),
  onStatus: callback => ipcRenderer.on('login:status', (_event, value) => callback(value)),
});
