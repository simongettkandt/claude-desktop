const { app, BrowserWindow, BrowserView, shell, Menu, nativeTheme, dialog, Notification, session, ipcMain, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// ── Performance-Flags ──
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoEncoder,CanvasOopRasterization');
app.commandLine.appendSwitch('disk-cache-size', '209715200');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('enable-smooth-scrolling');

nativeTheme.themeSource = 'dark';

// ── Single Instance ──
if (!app.requestSingleInstanceLock()) { app.quit(); }

const isDev = !app.isPackaged;
const chromeUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const TAB_BAR_HEIGHT = 40;
const PRELOAD_POOL_SIZE = 2;

let mainWindow;
let tabs = [];
let activeTabIndex = 0;
let isOnline = true;
let windowState = {};
let isDarkMode = true;

// ── Tab-Preload-Pool ──
const viewPool = [];

// ── Debounce/Throttle ──
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function throttle(fn, ms) {
  let last = 0, timer;
  return (...args) => {
    const now = Date.now();
    clearTimeout(timer);
    if (now - last >= ms) { last = now; fn(...args); }
    else { timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last)); }
  };
}

// ── Fensterzustand ──
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) windowState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  return {
    width: windowState.width || 1200, height: windowState.height || 800,
    x: windowState.x, y: windowState.y, isMaximized: windowState.isMaximized || false
  };
}

const saveWindowState = debounce(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    windowState = { ...bounds, isMaximized: mainWindow.isMaximized() };
    fs.writeFileSync(stateFile, JSON.stringify(windowState));
  } catch {}
}, 500);

// ── Domain-Prüfung ──
const domainCache = new Map();

function isAllowedDomain(url) {
  let r = domainCache.get(url);
  if (r !== undefined) return r;
  try { const h = new URL(url).hostname; r = h === 'claude.ai' || h.endsWith('.claude.ai'); }
  catch { r = false; }
  if (domainCache.size > 200) domainCache.clear();
  domainCache.set(url, r);
  return r;
}

function isGoogleAuthDomain(url) {
  try { const h = new URL(url).hostname; return h === 'accounts.google.com' || h === 'oauth2.googleapis.com'; }
  catch { return false; }
}

// OAuth-Domains für Konnektoren (GitHub, Google Drive, etc.)
function isOAuthDomain(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'accounts.google.com' || h === 'oauth2.googleapis.com'
      || h === 'github.com' || h === 'www.github.com'
      || h === 'drive.google.com' || h === 'docs.google.com'
      || h === 'login.microsoftonline.com'
      || h === 'gitlab.com' || h === 'bitbucket.org'
      || h.endsWith('.auth0.com')
      || h.endsWith('.claude.ai');
  } catch { return false; }
}

// ── Theme-Farben ──
const THEME = {
  dark:  { bg: '#262624', bgHover: '#333330', bgActive: '#3a3a37', text: '#9a9a96', textActive: '#e8e8e4', border: '#333330' },
  light: { bg: '#ece7e1', bgHover: '#e2dbd4', bgActive: '#f5f0eb', text: '#7a7068', textActive: '#2a2420', border: '#e0d8ce' }
};

function currentTheme() { return isDarkMode ? THEME.dark : THEME.light; }

// ── Pool wegwerfen (bei Theme-Wechsel) ──
function drainPool() {
  while (viewPool.length > 0) {
    const v = viewPool.pop();
    if (!v.webContents.isDestroyed()) v.webContents.destroy();
  }
}

// ── Tab-Bar HTML ──
function getTabBarHTML() {
  const t = currentTheme();
  return `<!DOCTYPE html><html><head><style>
  :root{--bg:${t.bg};--bgh:${t.bgHover};--bga:${t.bgActive};--t:${t.text};--ta:${t.textActive};--ac:#d4734c;--bd:${t.border}}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    color:var(--t);overflow:hidden;user-select:none;-webkit-app-region:drag;
    height:${TAB_BAR_HEIGHT}px;display:flex;align-items:flex-end;border-bottom:1px solid var(--bd);contain:layout style}
  #tabs{display:flex;align-items:flex-end;height:100%;flex:1;padding:0 8px;gap:1px;
    -webkit-app-region:no-drag;overflow-x:auto}
  #tabs::-webkit-scrollbar{height:0}
  .tab{display:flex;align-items:center;height:34px;padding:0 14px;border-radius:8px 8px 0 0;
    cursor:pointer;white-space:nowrap;max-width:220px;min-width:60px;gap:8px;
    position:relative;color:var(--t);contain:layout style}
  .tab:hover{background:var(--bgh);color:var(--ta)}
  .tab.active{background:var(--bga);color:var(--ta)}
  .tab.active::after{content:'';position:absolute;bottom:0;left:12px;right:12px;height:2px;background:var(--ac);border-radius:2px 2px 0 0}
  .tab-title{flex:1;overflow:hidden;text-overflow:ellipsis}
  .tab-close{width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;
    font-size:15px;line-height:1;opacity:0;flex-shrink:0}
  .tab:hover .tab-close{opacity:.5}
  .tab-close:hover{opacity:1!important;background:var(--bgh);color:var(--ac)}
  .controls{display:flex;align-items:center;gap:2px;padding:0 6px 6px;-webkit-app-region:no-drag}
  .ctrl-btn{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;
    cursor:pointer;color:var(--ta);font-size:16px;opacity:.85}
  .ctrl-btn:hover{background:var(--bgh);color:var(--ac);opacity:1}
  .ctrl-btn svg{width:16px;height:16px}
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
  const tabsEl=document.getElementById('tabs'),escDiv=document.createElement('div');
  function esc(t){escDiv.textContent=t;return escDiv.innerHTML}
  let tabEls=[];
  document.getElementById('new-tab').addEventListener('click',()=>window.tabAPI.newTab());
  document.getElementById('theme-toggle').addEventListener('click',()=>window.tabAPI.toggleTheme());

  window.tabAPI.onTabsUpdate((data)=>{
    const c=data.tabs.length;
    while(tabEls.length>c)tabsEl.removeChild(tabEls.pop());
    for(let i=0;i<c;i++){
      let el=tabEls[i];
      if(!el){
        el=document.createElement('div');el.className='tab';
        el.innerHTML='<span class="tab-title"></span><span class="tab-close">&times;</span>';
        el.addEventListener('click',(e)=>{
          const idx=tabEls.indexOf(el);
          if(e.target.classList.contains('tab-close'))window.tabAPI.closeTab(idx);
          else window.tabAPI.switchTab(idx);
        });
        tabsEl.appendChild(el);tabEls.push(el);
      }
      const ts=el.firstChild,t=esc(data.tabs[i].title);
      if(ts.innerHTML!==t)ts.innerHTML=t;
      const a=i===data.activeIndex;
      if(el.classList.contains('active')!==a)el.classList.toggle('active',a);
      el.lastChild.style.display=c>1?'':'none';
    }
  });

  window.tabAPI.onThemeUpdate((dark)=>{
    const r=document.documentElement.style;
    if(dark){
      r.setProperty('--bg','#262624');r.setProperty('--bgh','#333330');r.setProperty('--bga','#3a3a37');
      r.setProperty('--t','#9a9a96');r.setProperty('--ta','#e8e8e4');r.setProperty('--bd','#333330');
    }else{
      r.setProperty('--bg','#ece7e1');r.setProperty('--bgh','#e2dbd4');r.setProperty('--bga','#f5f0eb');
      r.setProperty('--t','#7a7068');r.setProperty('--ta','#2a2420');r.setProperty('--bd','#e0d8ce');
    }
    document.body.style.background=dark?'#262624':'#ece7e1';
    document.getElementById('theme-icon-dark').style.display=dark?'':'none';
    document.getElementById('theme-icon-light').style.display=dark?'none':'';
  });
</script></body></html>`;
}

// ── Tab-Bar Sync ──
const sendTabsUpdate = throttle(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tabs-update', {
    tabs: tabs.map((t, i) => ({ title: t.title || `Tab ${i + 1}` })),
    activeIndex: activeTabIndex
  });
}, 32);

function sendThemeUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('theme-update', isDarkMode);
}

// ── Menü (Cache) ──
let lastMenuHash = '';

function updateMenu(force = false) {
  const hash = `${tabs.length}:${activeTabIndex}`;
  if (!force && hash === lastMenuHash) return;
  lastMenuHash = hash;

  const tabItems = tabs.map((_, i) => ({
    label: `Tab ${i + 1}${i === activeTabIndex ? ' \u25cf' : ''}`,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => switchToTab(i)
  }));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Claude', submenu: [
      { label: 'Neuer Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
      { label: 'Tab schlie\u00dfen', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
      { type: 'separator' }, ...tabItems, { type: 'separator' },
      { label: 'Einstellungen', accelerator: 'CmdOrCtrl+,', click: () => {
        if (tabs[activeTabIndex]) tabs[activeTabIndex].view.webContents.loadURL('https://claude.ai/settings');
      }},
      { type: 'separator' },
      { label: 'Nach Updates suchen\u2026', click: () => {
        if (!isDev) { autoUpdater.checkForUpdates().catch(() => {}); new Notification({ title: 'Claude', body: 'Suche\u2026' }).show(); }
      }},
      { type: 'separator' },
      { role: 'quit', label: 'Beenden' }
    ]},
    { label: 'Bearbeiten', submenu: [
      { role: 'undo', label: 'R\u00fcckg\u00e4ngig' }, { role: 'redo', label: 'Wiederholen' },
      { type: 'separator' },
      { role: 'cut', label: 'Ausschneiden' }, { role: 'copy', label: 'Kopieren' },
      { role: 'paste', label: 'Einf\u00fcgen' }, { role: 'selectAll', label: 'Alles ausw\u00e4hlen' }
    ]},
    { label: 'Ansicht', submenu: [
      { label: 'Neu laden', accelerator: 'CmdOrCtrl+R', click: () => tabs[activeTabIndex]?.view.webContents.reload() },
      { label: 'Erzwungen neu laden', accelerator: 'CmdOrCtrl+Shift+R', click: () => tabs[activeTabIndex]?.view.webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Zoom zur\u00fccksetzen' },
      { role: 'zoomIn', label: 'Vergr\u00f6\u00dfern' }, { role: 'zoomOut', label: 'Verkleinern' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Vollbild' },
      ...(isDev ? [{ type: 'separator' }, { label: 'DevTools', accelerator: 'F12', click: () => tabs[activeTabIndex]?.view.webContents.toggleDevTools() }] : [])
    ]},
    { label: 'Tabs', submenu: [
      { label: 'Neuer Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
      { label: 'Tab schlie\u00dfen', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
      { type: 'separator' },
      { label: 'N\u00e4chster Tab', accelerator: 'CmdOrCtrl+Tab', click: () => switchToTab((activeTabIndex + 1) % tabs.length) },
      { label: 'Vorheriger Tab', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => switchToTab((activeTabIndex - 1 + tabs.length) % tabs.length) },
      { type: 'separator' }, ...tabItems
    ]},
    { label: 'Fenster', submenu: [
      { role: 'minimize', label: 'Minimieren' }, { role: 'close', label: 'Schlie\u00dfen' }
    ]}
  ]));
}

// ── View Setup ──
function setupView(view) {
  const wc = view.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    // OAuth-Popups (GitHub, Google Drive, etc.) in-app öffnen
    if (isOAuthDomain(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 600, height: 750, title: 'Anmeldung',
        parent: mainWindow, modal: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:claude' }
      }};
    }
    if (isAllowedDomain(url)) return { action: 'allow' };
    try {
      const p = new URL(url).protocol;
      if (p === 'https:' || p === 'http:' || p === 'mailto:') shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });

  // OAuth-Popups: Navigation innerhalb des Popup-Fensters erlauben
  // (OAuth redirected zwischen Domains hin und her)
  wc.on('did-create-window', (childWindow) => {
    childWindow.webContents.on('will-navigate', (event, navUrl) => {
      // Im OAuth-Popup: Navigation zu OAuth-Domains und zurück zu claude.ai erlauben
      if (!isOAuthDomain(navUrl) && !isAllowedDomain(navUrl)) {
        try {
          const p = new URL(navUrl).protocol;
          if (p !== 'https:' && p !== 'http:') event.preventDefault();
        } catch { event.preventDefault(); }
      }
    });
    // Wenn OAuth fertig ist und zu claude.ai redirected → Popup schließen
    childWindow.webContents.on('will-redirect', (event, navUrl) => {
      if (isAllowedDomain(navUrl)) {
        childWindow.close();
      }
    });
  });

  wc.on('will-navigate', (event, navUrl) => {
    if (!isAllowedDomain(navUrl) && !isOAuthDomain(navUrl)) event.preventDefault();
  });

  wc.on('page-title-updated', (_, title) => {
    const idx = tabs.findIndex(t => t.view === view);
    if (idx >= 0) {
      const clean = title.replace(/\s*[-\u2013]\s*Claude.*$/, '') || 'Neuer Chat';
      if (tabs[idx].title !== clean) { tabs[idx].title = clean; sendTabsUpdate(); }
    }
  });

  wc.on('did-finish-load', () => updateTitle());

  wc.on('render-process-gone', (_, details) => {
    if (details.reason !== 'clean-exit' && !wc.isDestroyed()) {
      console.error(`Tab crashed (${details.reason}), reloading...`);
      setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 300);
    }
  });
}

function createBrowserView() {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      partition: 'persist:claude',
      backgroundThrottling: true,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck',
    }
  });
  view.setBackgroundColor(currentTheme().bg);
  view.webContents.setUserAgent(chromeUA);
  return view;
}

// ── Tab-Pool: Hält fertig geladene Views bereit ──
function fillPool() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  while (viewPool.length < PRELOAD_POOL_SIZE) {
    const view = createBrowserView();
    setupView(view);
    view.webContents.loadURL('https://claude.ai');
    viewPool.push(view);
  }
}

function getPooledView() {
  if (viewPool.length > 0) {
    const view = viewPool.shift();
    // Pool sofort nachfüllen
    setImmediate(fillPool);
    return view;
  }
  return null;
}

// ── Tab-Operationen ──
function createTab(url = 'https://claude.ai') {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  let view;
  if (url === 'https://claude.ai') {
    view = getPooledView();
  }
  if (!view) {
    view = createBrowserView();
    setupView(view);
    view.webContents.loadURL(url);
  }

  tabs.push({ view, title: 'Neuer Chat', url });
  switchToTab(tabs.length - 1);
  updateMenu();
  return tabs[tabs.length - 1];
}

function switchToTab(index) {
  if (index < 0 || index >= tabs.length || !mainWindow) return;
  if (index === activeTabIndex && mainWindow.getBrowserView() === tabs[index].view) {
    sendTabsUpdate();
    return;
  }
  // Inaktiven Tab drosseln
  const prev = tabs[activeTabIndex]?.view;
  if (prev && !prev.webContents.isDestroyed()) prev.webContents.setBackgroundThrottling(true);

  activeTabIndex = index;
  const cur = tabs[index].view;
  mainWindow.setBrowserView(cur);
  if (!cur.webContents.isDestroyed()) cur.webContents.setBackgroundThrottling(false);
  resizeActiveView();
  updateTitle();
  updateMenu();
  sendTabsUpdate();
}

function closeTab(index) {
  if (tabs.length <= 1) return;
  const tab = tabs[index];
  mainWindow.removeBrowserView(tab.view);

  if (activeTabIndex === index) {
    const newIdx = index > 0 ? index - 1 : 0;
    tabs.splice(index, 1);
    activeTabIndex = Math.min(newIdx, tabs.length - 1);
    switchToTab(activeTabIndex);
  } else {
    tabs.splice(index, 1);
    if (activeTabIndex > index) activeTabIndex--;
    if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1;
  }

  setImmediate(() => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.destroy(); });
  updateMenu();
  sendTabsUpdate();
}

const resizeActiveView = throttle(() => {
  if (!mainWindow || mainWindow.isDestroyed() || !tabs[activeTabIndex]) return;
  const b = mainWindow.getContentBounds();
  tabs[activeTabIndex].view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: b.width, height: b.height - TAB_BAR_HEIGHT });
}, 16);

function updateTitle() {
  if (!mainWindow || mainWindow.isDestroyed() || !tabs[activeTabIndex]) return;
  const wc = tabs[activeTabIndex].view.webContents;
  if (wc.isDestroyed()) return;
  const loading = wc.isLoading();
  const info = tabs.length > 1 ? ` (${activeTabIndex + 1}/${tabs.length})` : '';
  const t = !isOnline ? 'Claude \u2013 Offline' : loading ? 'Claude \u2013 Laden\u2026' + info : 'Claude' + info;
  if (mainWindow.getTitle() !== t) mainWindow.setTitle(t);
}

// ── Offline ──
function handleOnlineChange(online) {
  if (online === isOnline) return;
  isOnline = online;
  updateTitle();
  if (!online) {
    showOfflinePage();
    new Notification({ title: 'Claude', body: 'Keine Internetverbindung.' }).show();
  } else {
    if (tabs[activeTabIndex] && !tabs[activeTabIndex].view.webContents.isDestroyed())
      tabs[activeTabIndex].view.webContents.reload();
    new Notification({ title: 'Claude', body: 'Verbindung wiederhergestellt!' }).show();
  }
}

function showOfflinePage() {
  if (!tabs[activeTabIndex]) return;
  tabs[activeTabIndex].view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html><html><head><style>
    body{background:#171310;color:#e8e0d8;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
    h1{font-size:22px;font-weight:600;margin-bottom:8px}
    p{color:#8a7e72;font-size:14px;max-width:360px;text-align:center;line-height:1.6}
    button{margin-top:20px;background:#d4734c;color:#fff;border:none;padding:10px 28px;border-radius:10px;font-size:14px;cursor:pointer;font-weight:500}
    button:hover{background:#e07d55}
    .pulse{animation:p 2s ease-in-out infinite}@keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
  </style></head><body><h1>Keine Verbindung</h1><p>Pruefe deine Netzwerkverbindung.</p>
    <p class="pulse" style="font-size:12px">Automatische Wiederverbindung...</p>
    <button onclick="location.href='https://claude.ai'">Erneut versuchen</button></body></html>`));
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
      if (state === 'progressing' && !item.isPaused() && mainWindow && !mainWindow.isDestroyed()) {
        const total = item.getTotalBytes();
        if (total > 0) {
          const pct = Math.round((item.getReceivedBytes() / total) * 100);
          mainWindow.setTitle(`Claude \u2013 Download ${pct}%`);
          mainWindow.setProgressBar(pct / 100);
        }
      }
    });
    item.once('done', (_, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setProgressBar(-1); updateTitle(); }
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
    new Notification({ title: 'Update verf\u00fcgbar', body: `v${info.version} wird geladen\u2026` }).show();
  });
  autoUpdater.on('download-progress', (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`Claude \u2013 Update ${Math.round(p.percent)}%`);
      mainWindow.setProgressBar(p.percent / 100);
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setTitle('Claude'); mainWindow.setProgressBar(-1); }
    if (dialog.showMessageBoxSync(mainWindow, {
      type: 'info', title: 'Update bereit',
      message: `v${info.version} heruntergeladen. Jetzt neu starten?`,
      buttons: ['Neu starten', 'Sp\u00e4ter'], defaultId: 0
    }) === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => console.error('Update-Fehler:', err.message));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 3600000);
}

// ── Session-Optimierung ──
function optimizeSession() {
  const ses = session.fromPartition('persist:claude');

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen'];
    callback(allowed.includes(permission));
  });

  // DNS-Prefetch + Preconnect zu claude.ai
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.claude.ai/*'] }, (details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, 'DNT': '1' } });
  });

  // Preconnect bei Session-Start
  ses.preconnect({ url: 'https://claude.ai', numSockets: 4 });
}

// ── IPC ──
ipcMain.on('tab-new', () => createTab());
ipcMain.on('tab-switch', (_, i) => switchToTab(i));
ipcMain.on('tab-close', (_, i) => closeTab(i));
ipcMain.on('theme-toggle', () => {
  isDarkMode = !isDarkMode;
  // 1) Pool-Views zerstören – die würden sonst im gleichen Renderer mit re-rendern
  drainPool();
  // 2) Aktiven Tab Background sofort setzen
  const bg = currentTheme().bg;
  const active = tabs[activeTabIndex]?.view;
  if (active && !active.webContents.isDestroyed()) active.setBackgroundColor(bg);
  // 3) nativeTheme umschalten (claude.ai reagiert via prefers-color-scheme)
  nativeTheme.themeSource = isDarkMode ? 'dark' : 'light';
  // 4) Tab-Bar updaten
  sendThemeUpdate();
  // 5) Inaktive Tabs Background setzen (niedrige Priorität)
  for (const tab of tabs) {
    if (tab.view !== active && !tab.view.webContents.isDestroyed()) tab.view.setBackgroundColor(bg);
  }
  // 6) Pool nach Delay neu füllen (im neuen Theme)
  setTimeout(fillPool, 2000);
});

// ── Fenster ──
function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width, height: state.height, x: state.x, y: state.y,
    minWidth: 480, minHeight: 600, title: 'Claude',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: currentTheme().bg,
    show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: false,
      preload: path.join(__dirname, 'preload-tabbar.js'),
      backgroundThrottling: false,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck',
    }
  });

  if (state.isMaximized) mainWindow.maximize();

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getTabBarHTML()));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);
  mainWindow.on('resize', resizeActiveView);

  mainWindow.on('blur', () => {
    const v = tabs[activeTabIndex]?.view;
    if (v && !v.webContents.isDestroyed()) {
      v.webContents.executeJavaScript('document.activeElement?.blur()').catch(() => {});
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    tabs.forEach(t => { if (!t.view.webContents.isDestroyed()) t.view.webContents.destroy(); });
    tabs = [];
    viewPool.forEach(v => { if (!v.webContents.isDestroyed()) v.webContents.destroy(); });
    viewPool.length = 0;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    createTab('https://claude.ai');
    // Pool nach erstem Tab füllen (sofort, nicht warten)
    setTimeout(fillPool, 500);
  });
}

// ── Start ──
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.whenReady().then(() => {
  optimizeSession();
  createWindow();
  updateMenu(true);
  setupDownloadManager();
  setupAutoUpdater();
  handleOnlineChange(net.isOnline());
  setInterval(() => handleOnlineChange(net.isOnline()), 60000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const bounds = mainWindow.getBounds();
      windowState = { ...bounds, isMaximized: mainWindow.isMaximized() };
      fs.writeFileSync(stateFile, JSON.stringify(windowState));
    } catch {}
  }
});
