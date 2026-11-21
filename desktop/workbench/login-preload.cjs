const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('login', { input: value => ipcRenderer.send('login:input', value), onData: callback => ipcRenderer.on('login:data', (_event, value) => callback(value)) });
