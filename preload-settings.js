const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings-get'),
  setMinimize: (v) => ipcRenderer.send('settings-minimize', v === true),
  setHotkey: (a) => ipcRenderer.invoke('settings-hotkey', typeof a === 'string' ? a : null),
  close: () => ipcRenderer.send('settings-close')
});
