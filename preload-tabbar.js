const { contextBridge, ipcRenderer } = require('electron');

function validIndex(i) {
  return typeof i === 'number' && Number.isInteger(i) && i >= 0;
}

contextBridge.exposeInMainWorld('tabAPI', {
  onTabsUpdate: (cb) => ipcRenderer.on('tabs-update', (_, data) => cb(data)),
  onThemeUpdate: (cb) => ipcRenderer.on('theme-update', (_, dark) => cb(dark)),
  newTab: () => ipcRenderer.send('tab-new'),
  switchTab: (i) => { if (validIndex(i)) ipcRenderer.send('tab-switch', i); },
  closeTab: (i) => { if (validIndex(i)) ipcRenderer.send('tab-close', i); },
  toggleTheme: () => ipcRenderer.send('theme-toggle')
});
