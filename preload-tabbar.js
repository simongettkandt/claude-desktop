const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabAPI', {
  onTabsUpdate: (cb) => ipcRenderer.on('tabs-update', (_, data) => cb(data)),
  onThemeUpdate: (cb) => ipcRenderer.on('theme-update', (_, dark) => cb(dark)),
  newTab: () => ipcRenderer.send('tab-new'),
  switchTab: (i) => ipcRenderer.send('tab-switch', i),
  closeTab: (i) => ipcRenderer.send('tab-close', i),
  toggleTheme: () => ipcRenderer.send('theme-toggle')
});
