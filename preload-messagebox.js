const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('msgboxAPI', {
  respond: (channel, index) => ipcRenderer.send(channel, index)
});
