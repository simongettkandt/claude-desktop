const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whatsNewAPI', {
  close: () => ipcRenderer.send('whatsnew-close'),
  openSettings: () => ipcRenderer.send('whatsnew-open-settings')
});
