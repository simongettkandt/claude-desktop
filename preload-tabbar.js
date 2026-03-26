const { contextBridge, ipcRenderer } = require('electron');

function validIndex(i) {
  return typeof i === 'number' && Number.isInteger(i) && i >= 0;
}

contextBridge.exposeInMainWorld('tabAPI', {
  onTabsUpdate: (cb) => ipcRenderer.on('tabs-update', (_, data) => cb(data)),
  onThemeUpdate: (cb) => ipcRenderer.on('theme-update', (_, dark) => cb(dark)),
  onDesignUpdate: (cb) => ipcRenderer.on('design-update', (_, custom) => cb(custom)),
  newTab: () => ipcRenderer.send('tab-new'),
  switchTab: (i) => { if (validIndex(i)) ipcRenderer.send('tab-switch', i); },
  closeTab: (i) => { if (validIndex(i)) ipcRenderer.send('tab-close', i); },
  toggleTheme: () => ipcRenderer.send('theme-toggle'),
  toggleDesign: () => ipcRenderer.send('design-toggle')
});
