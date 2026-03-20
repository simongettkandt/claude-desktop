const { app, BrowserWindow, BrowserView, shell, Menu, nativeTheme, dialog, Notification, session, ipcMain, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// ── Performance ──
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disk-cache-size', '104857600');

nativeTheme.themeSource = 'dark';

// ── Single Instance ──
if (!app.requestSingleInstanceLock()) { app.quit(); }

const isDev = !app.isPackaged;
const chromeUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const TAB_BAR_HEIGHT = 40;

let mainWindow;
let tabs = [];
let activeTabIndex = 0;
let isOnline = true;
let windowState = {};
let isDarkMode = true;
let saveStateTimer;
let preloadedView = null;

// ── Fensterzustand ──
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) {
      windowState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch {}
  return {
    width: windowState.width || 1200,
    height: windowState.height || 800,
    x: windowState.x,
    y: windowState.y,
    isMaximized: windowState.isMaximized || false
  };
}

function saveWindowState() {
  if (!mainWindow) return;
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    try {
      const bounds = mainWindow.getBounds();
      windowState = { ...bounds, isMaximized: mainWindow.isMaximized() };
      fs.writeFileSync(stateFile, JSON.stringify(windowState));
    } catch {}
  }, 300);
}

// ── Domain-Prüfung ──
function isAllowedDomain(url) {
  try { const h = new URL(url).hostname; return h === 'claude.ai' || h.endsWith('.claude.ai'); }
  catch { return false; }
}

function isGoogleAuthDomain(url) {
  try { const h = new URL(url).hostname; return h === 'accounts.google.com' || h === 'oauth2.googleapis.com'; }
  catch { return false; }
}

// ── Tab-Bar ──
function getTabBarHTML() {
  return `<!DOCTYPE html><html><head><style>
  :root {
    --bg: #262624; --bg-hover: #333330; --bg-active: #3a3a37;
    --text: #9a9a96; --text-active: #e8e8e4; --accent: #d4734c;
    --border: #333330;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 12px; font-weight: 500; letter-spacing: 0.01em;
    color: var(--text); overflow: hidden; user-select: none;
    -webkit-app-region: drag;
    height: ${TAB_BAR_HEIGHT}px; display: flex; align-items: flex-end;
    border-bottom: 1px solid var(--border);
    transition: background 0.2s, border-color 0.2s;
  }
  #tabs {
    display: flex; align-items: flex-end; height: 100%;
    flex: 1; padding: 0 8px; gap: 1px;
    -webkit-app-region: no-drag; overflow-x: auto;
  }
  #tabs::-webkit-scrollbar { height: 0; }
  .tab {
    display: flex; align-items: center; height: 34px;
    padding: 0 14px; border-radius: 8px 8px 0 0;
    cursor: pointer; white-space: nowrap;
    max-width: 220px; min-width: 60px;
    transition: all 0.15s ease; gap: 8px;
    position: relative; color: var(--text);
  }
  .tab:hover { background: var(--bg-hover); color: var(--text-active); }
  .tab.active {
    background: var(--bg-active); color: var(--text-active);
  }
  .tab.active::after {
    content: ''; position: absolute; bottom: 0; left: 12px; right: 12px;
    height: 2px; background: var(--accent); border-radius: 2px 2px 0 0;
  }
  .tab-title { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .tab-close {
    width: 18px; height: 18px; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; line-height: 1; opacity: 0;
    transition: all 0.1s; flex-shrink: 0;
  }
  .tab:hover .tab-close { opacity: 0.5; }
  .tab-close:hover { opacity: 1 !important; background: var(--bg-hover); color: var(--accent); }
  .controls {
    display: flex; align-items: center; gap: 2px;
    padding: 0 6px 6px; -webkit-app-region: no-drag;
  }
  .ctrl-btn {
    width: 30px; height: 30px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--text-active);
    transition: all 0.15s; font-size: 16px; opacity: 0.85;
  }
  .ctrl-btn:hover { background: var(--bg-hover); color: var(--accent); opacity: 1; }
  .ctrl-btn svg { width: 16px; height: 16px; }
</style></head><body>
  <div id="tabs"></div>
  <div class="controls">
    <div class="ctrl-btn" id="new-tab" title="Neuer Tab (Ctrl+T)">
      <svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>
    </div>
    <div class="ctrl-btn" id="theme-toggle" title="Theme wechseln">
      <svg id="theme-icon-dark" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      <svg id="theme-icon-light" viewBox="0 0 24 24" style="display:none"><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
    </div>
  </div>
<script>
  const tabsEl = document.getElementById('tabs');
  document.getElementById('new-tab').addEventListener('click', () => window.tabAPI.newTab());
  document.getElementById('theme-toggle').addEventListener('click', () => window.tabAPI.toggleTheme());

  window.tabAPI.onTabsUpdate((data) => {
    tabsEl.innerHTML = '';
    data.tabs.forEach((tab, i) => {
      const el = document.createElement('div');
      el.className = 'tab' + (i === data.activeIndex ? ' active' : '');
      el.innerHTML = '<span class="tab-title">' + esc(tab.title) + '</span>'
        + (data.tabs.length > 1 ? '<span class="tab-close" data-close="' + i + '">&times;</span>' : '');
      el.addEventListener('click', (e) => {
        if (e.target.dataset.close !== undefined) window.tabAPI.closeTab(parseInt(e.target.dataset.close));
        else window.tabAPI.switchTab(i);
      });
      tabsEl.appendChild(el);
    });
  });

  window.tabAPI.onThemeUpdate((dark) => {
    const r = document.documentElement.style;
    if (dark) {
      r.setProperty('--bg', '#262624'); r.setProperty('--bg-hover', '#333330');
      r.setProperty('--bg-active', '#3a3a37'); r.setProperty('--text', '#9a9a96');
      r.setProperty('--text-active', '#e8e8e4'); r.setProperty('--border', '#333330');
    } else {
      r.setProperty('--bg', '#ece7e1'); r.setProperty('--bg-hover', '#e2dbd4');
      r.setProperty('--bg-active', '#f5f0eb'); r.setProperty('--text', '#7a7068');
      r.setProperty('--text-active', '#2a2420'); r.setProperty('--border', '#e0d8ce');
    }
    document.getElementById('theme-icon-dark').style.display = dark ? '' : 'none';
    document.getElementById('theme-icon-light').style.display = dark ? 'none' : '';
  });

  function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
</script></body></html>`;
}

// ── Tab-Bar Sync ──
function sendTabsUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tabs-update', {
    tabs: tabs.map((t, i) => ({ title: t.title || `Tab ${i + 1}` })),
    activeIndex: activeTabIndex
  });
}

function sendThemeUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('theme-update', isDarkMode);
}

// ── Tab-System ──
function setupView(view) {
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleAuthDomain(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 500, height: 700, title: 'Google Anmeldung',
        parent: mainWindow, modal: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
      }};
    }
    if (isAllowedDomain(url)) return { action: 'allow' };
    try {
      const p = new URL(url).protocol;
      if (p === 'https:' || p === 'http:' || p === 'mailto:') shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, navUrl) => {
    if (!isAllowedDomain(navUrl) && !isGoogleAuthDomain(navUrl)) event.preventDefault();
  });

  view.webContents.on('page-title-updated', (_, title) => {
    const idx = tabs.findIndex(t => t.view === view);
    if (idx >= 0) {
      tabs[idx].title = title.replace(/\s*[-–]\s*Claude.*$/, '') || 'Neuer Chat';
      sendTabsUpdate();
    }
  });

  view.webContents.on('did-finish-load', () => updateTitle());
  view.webContents.on('did-start-loading', () => updateTitle());
}

function createBrowserView() {
  const isDark = nativeTheme.shouldUseDarkColors;
  const view = new BrowserView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:claude' }
  });
  view.setBackgroundColor(isDark ? '#262624' : '#ece7e1');
  view.webContents.setUserAgent(chromeUA);
  return view;
}

function warmUpNextTab() {
  if (preloadedView || !mainWindow) return;
  preloadedView = createBrowserView();
  setupView(preloadedView);
  preloadedView.webContents.loadURL('https://claude.ai');
}

function createTab(url = 'https://claude.ai') {
  if (!mainWindow) return;

  let view;
  if (preloadedView && url === 'https://claude.ai') {
    view = preloadedView;
    preloadedView = null;
  } else {
    view = createBrowserView();
    setupView(view);
    view.webContents.loadURL(url);
  }

  const tab = { view, title: 'Neuer Chat', url };
  tabs.push(tab);
  switchToTab(tabs.length - 1);
  updateMenu();

  setTimeout(warmUpNextTab, 2000);
  return tab;
}

function switchToTab(index) {
  if (index < 0 || index >= tabs.length || !mainWindow) return;
  activeTabIndex = index;
  mainWindow.setBrowserView(tabs[index].view);
  resizeActiveView();
  updateTitle();
  updateMenu();
  sendTabsUpdate();
}

function closeTab(index) {
  if (tabs.length <= 1) return;
  const tab = tabs[index];

  mainWindow.removeBrowserView(tab.view);

  if (mainWindow.getBrowserView() === tab.view || activeTabIndex === index) {
    const newIdx = index > 0 ? index - 1 : 0;
    tabs.splice(index, 1);
    activeTabIndex = Math.min(newIdx, tabs.length - 1);
    switchToTab(activeTabIndex);
  } else {
    tabs.splice(index, 1);
    if (activeTabIndex > index) activeTabIndex--;
    if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1;
  }
  tab.view.webContents.destroy();
  updateMenu();
  sendTabsUpdate();
}

function resizeActiveView() {
  if (!mainWindow || !tabs[activeTabIndex]) return;
  const b = mainWindow.getContentBounds();
  tabs[activeTabIndex].view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: b.width, height: b.height - TAB_BAR_HEIGHT });
}

function updateTitle() {
  if (!mainWindow || !tabs[activeTabIndex]) return;
  const loading = tabs[activeTabIndex].view.webContents.isLoading();
  const info = tabs.length > 1 ? ` (${activeTabIndex + 1}/${tabs.length})` : '';
  mainWindow.setTitle(!isOnline ? 'Claude – Offline' : loading ? 'Claude – Laden…' + info : 'Claude' + info);
}


// ── Offline ──
function checkOnlineStatus() {
  const online = net.isOnline();
  if (online !== isOnline) {
    isOnline = online;
    updateTitle();
    if (!online) {
      showOfflinePage();
      new Notification({ title: 'Claude', body: 'Keine Internetverbindung.' }).show();
    } else {
      if (tabs[activeTabIndex]) tabs[activeTabIndex].view.webContents.reload();
      new Notification({ title: 'Claude', body: 'Verbindung wiederhergestellt!' }).show();
    }
  }
}

function showOfflinePage() {
  if (!tabs[activeTabIndex]) return;
  tabs[activeTabIndex].view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html><html><head><style>
    body { background:#171310; color:#e8e0d8; font-family:system-ui,sans-serif;
      display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; }
    h1 { font-size:22px; font-weight:600; margin-bottom:8px; }
    p { color:#8a7e72; font-size:14px; max-width:360px; text-align:center; line-height:1.6; }
    button { margin-top:20px; background:#d4734c; color:#fff; border:none;
      padding:10px 28px; border-radius:10px; font-size:14px; cursor:pointer; font-weight:500; }
    button:hover { background:#e07d55; }
    .pulse { animation:p 2s ease-in-out infinite; }
    @keyframes p { 0%,100% { opacity:.3 } 50% { opacity:1 } }
  </style></head><body>
    <h1>Keine Verbindung</h1>
    <p>Pruefe deine Netzwerkverbindung.</p>
    <p class="pulse" style="font-size:12px">Automatische Wiederverbindung...</p>
    <button onclick="location.href='https://claude.ai'">Erneut versuchen</button>
  </body></html>`));
}

// ── Downloads ──
function setupDownloadManager() {
  session.defaultSession.on('will-download', (_, item) => {
    const fileName = item.getFilename();
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: 'Alle Dateien', extensions: ['*'] }]
    });
    if (!savePath) { item.cancel(); return; }
    item.setSavePath(savePath);
    item.on('updated', (_, state) => {
      if (state === 'progressing' && !item.isPaused() && mainWindow) {
        const pct = Math.round((item.getReceivedBytes() / item.getTotalBytes()) * 100);
        mainWindow.setTitle(`Claude – Download ${pct}%`);
        mainWindow.setProgressBar(pct / 100);
      }
    });
    item.once('done', (_, state) => {
      if (mainWindow) { mainWindow.setProgressBar(-1); updateTitle(); }
      if (state === 'completed') new Notification({ title: 'Download fertig', body: fileName }).show();
      else if (state !== 'cancelled') new Notification({ title: 'Download fehlgeschlagen', body: fileName }).show();
    });
  });
}

// ── Auto-Updater ──
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  if (isDev) return;
  autoUpdater.on('update-available', (info) => {
    new Notification({ title: 'Update verfügbar', body: `v${info.version} wird geladen…` }).show();
  });
  autoUpdater.on('download-progress', (p) => {
    if (mainWindow) { mainWindow.setTitle(`Claude – Update ${Math.round(p.percent)}%`); mainWindow.setProgressBar(p.percent / 100); }
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) { mainWindow.setTitle('Claude'); mainWindow.setProgressBar(-1); }
    if (dialog.showMessageBoxSync(mainWindow, {
      type: 'info', title: 'Update bereit',
      message: `v${info.version} heruntergeladen. Jetzt neu starten?`,
      buttons: ['Neu starten', 'Später'], defaultId: 0
    }) === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => console.error('Update-Fehler:', err.message));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);
}

// ── IPC ──
ipcMain.on('tab-new', () => createTab());
ipcMain.on('tab-switch', (_, i) => switchToTab(i));
ipcMain.on('tab-close', (_, i) => closeTab(i));
ipcMain.on('theme-toggle', () => {
  isDarkMode = !isDarkMode;
  nativeTheme.themeSource = isDarkMode ? 'dark' : 'light';
  sendThemeUpdate();
});

// ── Fenster ──
function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width, height: state.height, x: state.x, y: state.y,
    minWidth: 480, minHeight: 600, title: 'Claude',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#262624',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: false,
      preload: path.join(__dirname, 'preload-tabbar.js')
    }
  });

  if (state.isMaximized) mainWindow.maximize();

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getTabBarHTML()));

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);
  mainWindow.on('resize', resizeActiveView);

  mainWindow.on('blur', () => {
    const v = tabs[activeTabIndex]?.view;
    if (v) v.webContents.executeJavaScript('document.activeElement?.blur()').catch(() => {});
  });

  mainWindow.on('closed', () => {
    mainWindow = null; tabs = [];
    if (preloadedView) { preloadedView.webContents.destroy(); preloadedView = null; }
  });

  mainWindow.webContents.once('did-finish-load', () => {
    createTab('https://claude.ai');
  });
}

// ── Menü ──
function updateMenu() {
  const tabItems = tabs.map((_, i) => ({
    label: `Tab ${i + 1}${i === activeTabIndex ? ' ●' : ''}`,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => switchToTab(i)
  }));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Claude', submenu: [
      { label: 'Neuer Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
      { label: 'Tab schließen', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
      { type: 'separator' }, ...tabItems, { type: 'separator' },
      { label: 'Einstellungen', accelerator: 'CmdOrCtrl+,', click: () => {
        if (tabs[activeTabIndex]) tabs[activeTabIndex].view.webContents.loadURL('https://claude.ai/settings');
      }},
      { type: 'separator' },
      { label: 'Nach Updates suchen…', click: () => {
        if (!isDev) { autoUpdater.checkForUpdates().catch(() => {}); new Notification({ title: 'Claude', body: 'Suche…' }).show(); }
      }},
      { type: 'separator' },
      { role: 'quit', label: 'Beenden' }
    ]},
    { label: 'Bearbeiten', submenu: [
      { role: 'undo', label: 'Rückgängig' }, { role: 'redo', label: 'Wiederholen' },
      { type: 'separator' },
      { role: 'cut', label: 'Ausschneiden' }, { role: 'copy', label: 'Kopieren' },
      { role: 'paste', label: 'Einfügen' }, { role: 'selectAll', label: 'Alles auswählen' }
    ]},
    { label: 'Ansicht', submenu: [
      { label: 'Neu laden', accelerator: 'CmdOrCtrl+R', click: () => tabs[activeTabIndex]?.view.webContents.reload() },
      { label: 'Erzwungen neu laden', accelerator: 'CmdOrCtrl+Shift+R', click: () => tabs[activeTabIndex]?.view.webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Zoom zurücksetzen' },
      { role: 'zoomIn', label: 'Vergrößern' }, { role: 'zoomOut', label: 'Verkleinern' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Vollbild' },
      ...(isDev ? [{ type: 'separator' }, { label: 'DevTools', accelerator: 'F12', click: () => tabs[activeTabIndex]?.view.webContents.toggleDevTools() }] : [])
    ]},
    { label: 'Tabs', submenu: [
      { label: 'Neuer Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
      { label: 'Tab schließen', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
      { type: 'separator' },
      { label: 'Nächster Tab', accelerator: 'CmdOrCtrl+Tab', click: () => switchToTab((activeTabIndex + 1) % tabs.length) },
      { label: 'Vorheriger Tab', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => switchToTab((activeTabIndex - 1 + tabs.length) % tabs.length) },
      { type: 'separator' }, ...tabItems
    ]},
    { label: 'Fenster', submenu: [
      { role: 'minimize', label: 'Minimieren' }, { role: 'close', label: 'Schließen' }
    ]}
  ]));
}

// ── Start ──
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.whenReady().then(() => {
  createWindow();
  updateMenu();
  setupDownloadManager();
  setupAutoUpdater();
  checkOnlineStatus();
  setInterval(checkOnlineStatus, 30000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  clearTimeout(saveStateTimer);
  if (mainWindow) {
    try {
      const bounds = mainWindow.getBounds();
      windowState = { ...bounds, isMaximized: mainWindow.isMaximized() };
      fs.writeFileSync(stateFile, JSON.stringify(windowState));
    } catch {}
  }
});
