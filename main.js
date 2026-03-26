const { app, BrowserWindow, WebContentsView, shell, Menu, nativeTheme, dialog, Notification, session, ipcMain, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

// ── Electron Security-Warnings nur im Dev-Modus ──
if (app.isPackaged) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// ── Electron Error-Dialog auf JS-Ebene abfangen ──
// Electron zeigt "Object has been destroyed" bei OAuth-Popup-Close über dialog.showErrorBox.
// Wir patchen die Funktion direkt, weil process.on('uncaughtException') zu spät greift.
const _origErrorBox = dialog.showErrorBox;
dialog.showErrorBox = (title, content) => {
  if (typeof content === 'string' && content.includes('Object has been destroyed')) return;
  _origErrorBox(title, content);
};

// ── Performance-Flags (Chromium 134+) ──
// GPU-Rasterization, zero-copy, smooth-scrolling, VaapiVideoDecoder: alles Standard seit Chromium ~130
// AcceleratedVideoEncoder (ex VaapiVideoEncoder): noch nicht Standard auf Linux
app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoEncoder');
app.commandLine.appendSwitch('disk-cache-size', '209715200');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// nativeTheme wird nach loadWindowState() gesetzt (s. createWindow)

// ── Single Instance ──
if (!app.requestSingleInstanceLock()) { app.quit(); }

const isDev = !app.isPackaged;
const chromeUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const TAB_BAR_HEIGHT = 40;
const PRELOAD_POOL_SIZE = 1;
const RELOAD_DELAY_MS = 300;
const MAX_CRASH_RELOADS = 3;
const ONLINE_CHECK_INTERVAL_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 3_600_000;
const DOMAIN_CACHE_MAX = 50;

let mainWindow;
let tabs = [];
let activeTabIndex = 0;
let isOnline = true;
let windowState = {};
let isDarkMode = true;
let customDesign = true;

// ── Lokalisierung (DE/EN) ──
const isDE = (() => {
  const l = (process.env.LANG || process.env.LANGUAGE || '').toLowerCase();
  return l.startsWith('de');
})();
function t(de, en) { return isDE ? de : en; }

// ── Tab-Preload-Pool ──
const viewPool = [];

// ── Crash-Counter (max Reloads pro Tab) ──
const crashCounts = new WeakMap();

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
  } catch (e) { if (isDev) console.debug('Window-State laden fehlgeschlagen:', e.message); }
  if (windowState.customDesign !== undefined) customDesign = windowState.customDesign;
  if (windowState.isDarkMode !== undefined) isDarkMode = windowState.isDarkMode;
  return {
    width: windowState.width || 1200, height: windowState.height || 800,
    x: windowState.x, y: windowState.y, isMaximized: windowState.isMaximized || false
  };
}

let lastSavedState = '';
const saveWindowState = debounce(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    const newState = { ...bounds, isMaximized: mainWindow.isMaximized(), customDesign, isDarkMode };
    const json = JSON.stringify(newState);
    if (json === lastSavedState) return;
    lastSavedState = json;
    windowState = newState;
    fsp.writeFile(stateFile, json).catch(e => { if (isDev) console.debug('Window-State speichern fehlgeschlagen:', e.message); });
  } catch (e) { if (isDev) console.debug('Window-State speichern fehlgeschlagen:', e.message); }
}, 500);

// ── Domain-Prüfung ──
const domainCache = new Map();

function isAllowedDomain(url) {
  let r = domainCache.get(url);
  if (r !== undefined) return r;
  try { const h = new URL(url).hostname; r = h === 'claude.ai' || h.endsWith('.claude.ai'); }
  catch { r = false; }
  if (domainCache.size >= DOMAIN_CACHE_MAX) {
    // Ältesten Eintrag entfernen (Map behält Einfügereihenfolge)
    domainCache.delete(domainCache.keys().next().value);
  }
  domainCache.set(url, r);
  return r;
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
  light: { bg: '#f5f2ef', bgHover: '#ede9e4', bgActive: '#faf8f6', text: '#8a7e72', textActive: '#2a2420', border: '#e8e4de' }
};

const ACCENT = {
  custom:   { from: '#F26A3F', to: '#E83B6E' },
  original: { from: '#d4734c', to: '#d4734c' }
};

function currentTheme() { return isDarkMode ? THEME.dark : THEME.light; }
function currentAccent() { return customDesign ? ACCENT.custom : ACCENT.original; }
function currentIcon() { return path.join(__dirname, customDesign ? 'icon.png' : 'icon-original.png'); }

// ── Custom Design Script für claude.ai ──
const BRAND_SCRIPT = [
  '(function() {',
  '  if (window._cdActive) return;',
  '  window._cdActive = true;',
  '  var MID = "#E8524F";',
  '',
  '  function rgb(s) {',
  '    if (!s || s.length < 10) return null;',
  '    var i = s.indexOf("rgb"); if (i < 0) return null;',
  '    var a = s.indexOf("(", i); if (a < 0) return null;',
  '    var b = s.indexOf(")", a); if (b < 0) return null;',
  '    var p = s.substring(a+1, b).split(",");',
  '    return p.length >= 3 ? [parseInt(p[0]), parseInt(p[1]), parseInt(p[2])] : null;',
  '  }',
  '',
  '  function isOrange(c) {',
  '    return c[0]>=175 && c[0]<=235 && c[1]>=75 && c[1]<=135 && c[2]>=40 && c[2]<=105',
  '      && c[0]-c[1]>=55 && c[0]-c[2]>=85;',
  '  }',
  '',
  '  // --- CSS-Variable Override (cached) ---',
  '  var _varsCached = false;',
  '  function overrideVars() {',
  '    if (_varsCached) return;',
  '    var sheet = document.getElementById("cd-vars");',
  '    if (!sheet) { sheet = document.createElement("style"); sheet.id = "cd-vars"; document.head.appendChild(sheet); }',
  '    var rules = ":root{";',
  '    try {',
  '      for (var i = 0; i < document.styleSheets.length; i++) {',
  '        try {',
  '          var cr = document.styleSheets[i].cssRules;',
  '          for (var j = 0; j < cr.length; j++) {',
  '            if (cr[j].style) {',
  '              for (var k = 0; k < cr[j].style.length; k++) {',
  '                var prop = cr[j].style[k];',
  '                if (prop.startsWith("--")) {',
  '                  var val = cr[j].style.getPropertyValue(prop);',
  '                  var c = rgb(val); if (c && isOrange(c)) rules += prop + ":" + MID + " !important;";',
  '                }',
  '              }',
  '            }',
  '          }',
  '        } catch(e) {}',
  '      }',
  '    } catch(e) {}',
  '    rules += "}";',
  '    if (rules.length > 8) { sheet.textContent = rules; _varsCached = true; }',
  '  }',
  '',
  '  // --- Recolor: SVGs, Buttons, Links + inline-styled Elemente ---',
  '  function recolor() {',
  '    overrideVars();',
  '    document.querySelectorAll("svg, svg *").forEach(function(el) {',
  '      try {',
  '        var cs = getComputedStyle(el);',
  '        var f = rgb(cs.fill); if (f && isOrange(f)) el.style.fill = MID;',
  '        var s = rgb(cs.stroke); if (s && isOrange(s)) el.style.stroke = MID;',
  '        var c = rgb(cs.color); if (c && isOrange(c)) el.style.color = MID;',
  '      } catch(e) {}',
  '    });',
  '    document.querySelectorAll("button, a, span, [role=button], p, h1, h2, h3, div[style], span[style]").forEach(function(el) {',
  '      try {',
  '        var cs = getComputedStyle(el);',
  '        var c = rgb(cs.color); if (c && isOrange(c)) el.style.color = MID;',
  '        var bg = rgb(cs.backgroundColor); if (bg && isOrange(bg)) el.style.backgroundColor = MID;',
  '        var bc = rgb(cs.borderColor); if (bc && isOrange(bc)) el.style.borderColor = MID;',
  '      } catch(e) {}',
  '    });',
  '  }',
  '',
  '  // --- Gradient-Overlay (Dark + Light) ---',
  '  var overlay = null;',
  '  function updateOverlay() {',
  '    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;',
  '    if (!overlay && document.body) {',
  '      overlay = document.createElement("div");',
  '      overlay.id = "cd-grad";',
  '      document.body.appendChild(overlay);',
  '    }',
  '    if (overlay) {',
  '      var o = dark ? "0.06" : "0.09";',
  '      overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;" +',
  '        "background:radial-gradient(ellipse 70% 50% at 0% 0%,rgba(242,106,63," + o + "),transparent)," +',
  '        "radial-gradient(ellipse 70% 50% at 100% 100%,rgba(232,59,110," + o + "),transparent)";',
  '    }',
  '  }',
  '',
  '  // --- Input-Box Glow ---',
  '  function styleInputs() {',
  '    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;',
  '    document.querySelectorAll("fieldset").forEach(function(fs) {',
  '      if (!fs.querySelector("[contenteditable], textarea, [role=textbox], .ProseMirror")) return;',
  '      fs.style.borderColor = dark ? "rgba(232,82,79,0.4)" : "rgba(232,82,79,0.35)";',
  '      fs.style.boxShadow = dark',
  '        ? "0 0 15px rgba(242,106,63,0.08), 0 0 30px rgba(232,59,110,0.06)"',
  '        : "0 0 15px rgba(242,106,63,0.12), 0 0 30px rgba(232,59,110,0.09)";',
  '    });',
  '  }',
  '',
  '  // --- Theme-Wechsel erkennen ---',
  '  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function() {',
  '    _varsCached = false; updateOverlay(); styleInputs(); recolor();',
  '  });',
  '',
  '  // --- Scan ---',
  '  function scanAll() { recolor(); updateOverlay(); styleInputs(); }',
  '',
  '  var timer;',
  '  var obs = new MutationObserver(function(muts) {',
  '    clearTimeout(timer);',
  '    timer = setTimeout(function() {',
  '      for (var i = 0; i < muts.length; i++) {',
  '        if (muts[i].addedNodes.length) { scanAll(); return; }',
  '      }',
  '    }, 150);',
  '  });',
  '',
  '  function init() {',
  '    scanAll();',
  '    setTimeout(scanAll, 800);',
  '    setTimeout(scanAll, 2000);',
  '    setTimeout(scanAll, 4000);',
  '    if (document.body) obs.observe(document.body, { childList: true, subtree: true });',
  '  }',
  '',
  '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);',
  '  else init();',
  '})()'
].join('\n');

// ── Pool wegwerfen (bei Theme-Wechsel) ──
function drainPool() {
  while (viewPool.length > 0) {
    const v = viewPool.pop();
    if (!v.webContents.isDestroyed()) v.webContents.close();
  }
}

// ── Tab-Bar HTML ──
function getTabBarHTML() {
  const th = currentTheme();
  const a = currentAccent();
  return `<!DOCTYPE html><html><head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
  :root{--bg:${th.bg};--bgh:${th.bgHover};--bga:${th.bgActive};--t:${th.text};--ta:${th.textActive};--bd:${th.border};
    --ac-from:${a.from};--ac-to:${a.to}}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    color:var(--t);overflow:hidden;user-select:none;-webkit-app-region:drag;
    height:${TAB_BAR_HEIGHT}px;display:flex;align-items:flex-end;border-bottom:1px solid var(--bd);contain:layout style}
  #tabs{display:flex;align-items:flex-end;height:100%;flex:1;padding:0 8px;gap:2px;
    -webkit-app-region:no-drag;overflow-x:auto}
  #tabs::-webkit-scrollbar{height:0}
  .tab{display:flex;align-items:center;height:34px;padding:0 14px;border-radius:10px 10px 0 0;
    cursor:pointer;white-space:nowrap;max-width:220px;min-width:60px;gap:8px;
    position:relative;color:var(--t);transition:background .15s,color .15s;contain:layout style}
  .tab:hover{background:var(--bgh);color:var(--ta)}
  .tab.active{background:var(--bga);color:var(--ta)}
  .tab.active::after{content:'';position:absolute;bottom:0;left:10px;right:10px;height:2.5px;
    background:linear-gradient(90deg,var(--ac-from),var(--ac-to));border-radius:2px 2px 0 0}
  .tab-title{flex:1;overflow:hidden;text-overflow:ellipsis}
  .tab-close{width:18px;height:18px;border-radius:6px;display:flex;align-items:center;justify-content:center;
    font-size:15px;line-height:1;opacity:0;flex-shrink:0;transition:opacity .1s,background .1s}
  .tab:hover .tab-close{opacity:.5}
  .tab-close:hover{opacity:1!important;background:var(--bgh);color:var(--ac-to)}
  .controls{display:flex;align-items:center;gap:2px;padding:0 6px 6px;-webkit-app-region:no-drag}
  .ctrl-btn{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;
    cursor:pointer;color:var(--ta);font-size:16px;opacity:.85;transition:background .15s,color .15s,opacity .15s}
  .ctrl-btn:hover{background:var(--bgh);color:var(--ac-to);opacity:1}
  .ctrl-btn svg{width:16px;height:16px}
  .design-pill{padding:2px 10px;height:22px;border-radius:11px;font-size:10px;font-weight:600;
    letter-spacing:.4px;text-transform:uppercase;display:flex;align-items:center;cursor:pointer;
    background:var(--bgh);color:var(--t);transition:all .15s;-webkit-app-region:no-drag;margin-right:2px}
  .design-pill:hover{background:var(--bga);color:var(--ac-to)}
</style></head><body>
  <div id="tabs"></div>
  <div class="controls">
    <div class="design-pill" id="design-toggle" title="${t('Design wechseln', 'Toggle design')}">${customDesign ? 'Modern' : 'Classic'}</div>
    <div class="ctrl-btn" id="new-tab" title="${t('Neuer Tab', 'New Tab')} (Ctrl+T)">
      <svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>
    </div>
    <div class="ctrl-btn" id="theme-toggle" title="${t('Theme wechseln', 'Toggle theme')}">
      <svg id="theme-icon-dark" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      <svg id="theme-icon-light" viewBox="0 0 24 24" style="display:none"><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
    </div>
  </div>
<script>
  const tabsEl=document.getElementById('tabs');
  let tabEls=[];
  document.getElementById('new-tab').addEventListener('click',()=>window.tabAPI.newTab());
  document.getElementById('theme-toggle').addEventListener('click',()=>window.tabAPI.toggleTheme());
  document.getElementById('design-toggle').addEventListener('click',()=>window.tabAPI.toggleDesign());
  window.tabAPI.onDesignUpdate((custom)=>{
    document.getElementById('design-toggle').textContent=custom?'Modern':'Classic';
  });

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
      const ts=el.firstChild,t=data.tabs[i].title;
      if(ts.textContent!==t)ts.textContent=t;
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
      r.setProperty('--bg','#f5f2ef');r.setProperty('--bgh','#ede9e4');r.setProperty('--bga','#faf8f6');
      r.setProperty('--t','#8a7e72');r.setProperty('--ta','#2a2420');r.setProperty('--bd','#e8e4de');
    }
    document.body.style.background=dark?'#262624':'#f5f2ef';
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

function sendDesignUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('design-update', customDesign);
}

function toggleDesign() {
  customDesign = !customDesign;
  // Icon wechseln (Fenster + Taskleiste)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(currentIcon());
  try {
    const iconDest = path.join(app.getPath('home'), 'Apps', 'claude-desktop-icon.png');
    fs.copyFileSync(currentIcon(), iconDest);
  } catch(e) {}
  // Pool leeren + neu füllen
  drainPool();
  // Tab-Bar mit neuem Design neu laden
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getTabBarHTML()));
    mainWindow.webContents.once('did-finish-load', () => { sendTabsUpdate(); sendThemeUpdate(); sendDesignUpdate(); });
  }
  // Content-Tabs neu laden
  tabs.forEach(tab => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload(); });
  setImmediate(fillPool);
  saveWindowState();
  updateMenu(true);
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
      { label: t('Neuer Tab', 'New Tab'), accelerator: 'CmdOrCtrl+T', click: () => createTab() },
      { label: t('Tab schließen', 'Close Tab'), accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
      { type: 'separator' }, ...tabItems, { type: 'separator' },
      { label: t('Einstellungen', 'Settings'), accelerator: 'CmdOrCtrl+,', click: () => {
        if (tabs[activeTabIndex]) tabs[activeTabIndex].view.webContents.loadURL('https://claude.ai/settings');
      }},
      { type: 'separator' },
      { label: `Design: ${customDesign ? 'Modern' : 'Classic'}`, click: toggleDesign },
      { label: t('Nach Updates suchen…', 'Check for Updates…'), click: () => {
        if (!isDev) autoUpdater.checkForUpdates().catch(() => {});
      }},
      { type: 'separator' },
      { role: 'quit', label: t('Beenden', 'Quit') }
    ]},
    { label: t('Bearbeiten', 'Edit'), submenu: [
      { role: 'undo', label: t('Rückgängig', 'Undo') }, { role: 'redo', label: t('Wiederholen', 'Redo') },
      { type: 'separator' },
      { role: 'cut', label: t('Ausschneiden', 'Cut') }, { role: 'copy', label: t('Kopieren', 'Copy') },
      { role: 'paste', label: t('Einfügen', 'Paste') }, { role: 'selectAll', label: t('Alles auswählen', 'Select All') }
    ]},
    { label: t('Ansicht', 'View'), submenu: [
      { label: t('Neu laden', 'Reload'), accelerator: 'CmdOrCtrl+R', click: () => tabs[activeTabIndex]?.view.webContents.reload() },
      { label: t('Erzwungen neu laden', 'Force Reload'), accelerator: 'CmdOrCtrl+Shift+R', click: () => tabs[activeTabIndex]?.view.webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { role: 'resetZoom', label: t('Zoom zurücksetzen', 'Reset Zoom') },
      { role: 'zoomIn', label: t('Vergrößern', 'Zoom In') }, { role: 'zoomOut', label: t('Verkleinern', 'Zoom Out') },
      { type: 'separator' }, { role: 'togglefullscreen', label: t('Vollbild', 'Fullscreen') },
      ...(isDev ? [{ type: 'separator' }, { label: 'DevTools', accelerator: 'F12', click: () => tabs[activeTabIndex]?.view.webContents.toggleDevTools() }] : [])
    ]},
    { label: 'Tabs', submenu: [
      { label: t('Neuer Tab', 'New Tab'), accelerator: 'CmdOrCtrl+T', click: () => createTab() },
      { label: t('Tab schließen', 'Close Tab'), accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
      { type: 'separator' },
      { label: t('Nächster Tab', 'Next Tab'), accelerator: 'CmdOrCtrl+Tab', click: () => switchToTab((activeTabIndex + 1) % tabs.length) },
      { label: t('Vorheriger Tab', 'Previous Tab'), accelerator: 'CmdOrCtrl+Shift+Tab', click: () => switchToTab((activeTabIndex - 1 + tabs.length) % tabs.length) },
      { type: 'separator' }, ...tabItems
    ]},
    { label: t('Fenster', 'Window'), submenu: [
      { role: 'minimize', label: t('Minimieren', 'Minimize') }, { role: 'close', label: t('Schließen', 'Close') }
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
        width: 600, height: 750, title: t('Anmeldung', 'Sign In'),
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
    let popupClosed = false;
    const closePopup = () => {
      if (popupClosed || childWindow.isDestroyed()) return;
      popupClosed = true;
      // Listener entfernen bevor wir schließen, verhindert Race-Conditions
      childWindow.webContents.removeAllListeners('will-navigate');
      childWindow.webContents.removeAllListeners('will-redirect');
      childWindow.webContents.removeAllListeners('did-navigate');
      childWindow.close();
    };
    childWindow.webContents.on('will-navigate', (event, navUrl) => {
      if (popupClosed) return;
      if (!isOAuthDomain(navUrl) && !isAllowedDomain(navUrl)) {
        try {
          const p = new URL(navUrl).protocol;
          if (p !== 'https:' && p !== 'http:') event.preventDefault();
        } catch { event.preventDefault(); }
      }
    });
    childWindow.webContents.on('will-redirect', (_event, navUrl) => {
      if (isAllowedDomain(navUrl)) closePopup();
    });
    childWindow.webContents.on('did-navigate', (_event, navUrl) => {
      if (isAllowedDomain(navUrl)) closePopup();
    });
  });

  wc.on('will-navigate', (event, navUrl) => {
    if (!isAllowedDomain(navUrl) && !isOAuthDomain(navUrl)) event.preventDefault();
  });

  wc.on('page-title-updated', (_, title) => {
    const idx = tabs.findIndex(t => t.view === view);
    if (idx >= 0) {
      const clean = title.replace(/\s*[-\u2013]\s*Claude.*$/, '') || t('Neuer Chat', 'New Chat');
      if (tabs[idx].title !== clean) { tabs[idx].title = clean; sendTabsUpdate(); }
    }
  });

  wc.on('did-finish-load', () => {
    updateTitle();
    if (customDesign) wc.executeJavaScript(BRAND_SCRIPT).catch(() => {});
  });

  wc.on('render-process-gone', (_, details) => {
    if (details.reason !== 'clean-exit' && !wc.isDestroyed()) {
      const count = (crashCounts.get(wc) || 0) + 1;
      crashCounts.set(wc, count);
      if (count > MAX_CRASH_RELOADS) {
        console.error(`Tab crashed ${count}x (${details.reason}), giving up.`);
        return;
      }
      console.error(`Tab crashed (${details.reason}), reload ${count}/${MAX_CRASH_RELOADS}...`);
      setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, RELOAD_DELAY_MS);
    }
  });
}

function createContentView() {
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      partition: 'persist:claude',
      backgroundThrottling: true,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck',
    }
  });
  view.setBackgroundColor(currentTheme().bg);
  view.setVisible(false);
  view.webContents.setUserAgent(chromeUA);
  return view;
}

// ── Tab-Pool: Hält fertig geladene Views bereit ──
let isPoolRefilling = false;

function fillPool() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isPoolRefilling = true;
  while (viewPool.length < PRELOAD_POOL_SIZE) {
    const view = createContentView();
    setupView(view);
    view.webContents.loadURL('https://claude.ai');
    viewPool.push(view);
  }
  isPoolRefilling = false;
}

function getPooledView() {
  if (viewPool.length > 0) {
    const view = viewPool.shift();
    if (!isPoolRefilling) setImmediate(fillPool);
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
    view = createContentView();
    setupView(view);
    view.webContents.loadURL(url);
  }

  mainWindow.contentView.addChildView(view);
  tabs.push({ view, title: t('Neuer Chat', 'New Chat'), url });
  switchToTab(tabs.length - 1);
  updateMenu();
  return tabs[tabs.length - 1];
}

function switchToTab(index) {
  if (index < 0 || index >= tabs.length || !mainWindow || mainWindow.isDestroyed()) return;
  const targetView = tabs[index].view;
  if (targetView.webContents.isDestroyed()) return;
  if (index === activeTabIndex && targetView.getVisible()) {
    sendTabsUpdate();
    return;
  }
  // Inaktiven Tab verstecken + drosseln
  const prev = tabs[activeTabIndex]?.view;
  if (prev && !prev.webContents.isDestroyed()) {
    prev.setVisible(false);
    prev.webContents.setBackgroundThrottling(true);
  }

  activeTabIndex = index;
  targetView.setVisible(true);
  targetView.webContents.setBackgroundThrottling(false);
  lastViewBounds = ''; // Force resize nach Tab-Wechsel
  resizeActiveView();
  updateTitle();
  updateMenu();
  sendTabsUpdate();
}

function closeTab(index) {
  if (tabs.length <= 1 || index < 0 || index >= tabs.length) return;
  const tab = tabs[index];
  mainWindow.contentView.removeChildView(tab.view);

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

  setImmediate(() => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); });
  updateMenu();
  sendTabsUpdate();
}

let lastViewBounds = '';
const resizeActiveView = throttle(() => {
  if (!mainWindow || mainWindow.isDestroyed() || !tabs[activeTabIndex]) return;
  const b = mainWindow.getContentBounds();
  const key = `${b.width}:${b.height}`;
  if (key === lastViewBounds) return;
  lastViewBounds = key;
  tabs[activeTabIndex].view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: b.width, height: b.height - TAB_BAR_HEIGHT });
}, 16);

function updateTitle() {
  if (!mainWindow || mainWindow.isDestroyed() || !tabs[activeTabIndex]) return;
  const wc = tabs[activeTabIndex].view.webContents;
  if (wc.isDestroyed()) return;
  const loading = wc.isLoading();
  const info = tabs.length > 1 ? ` (${activeTabIndex + 1}/${tabs.length})` : '';
  const title2 = !isOnline ? 'Claude \u2013 Offline' : loading ? 'Claude \u2013 ' + t('Laden\u2026', 'Loading\u2026') + info : 'Claude' + info;
  if (mainWindow.getTitle() !== title2) mainWindow.setTitle(title2);
}

// ── Offline ──
function handleOnlineChange(online) {
  if (online === isOnline) return;
  isOnline = online;
  updateTitle();
  if (!online) {
    showOfflinePage();
    new Notification({ title: 'Claude', body: t('Keine Internetverbindung.', 'No internet connection.') }).show();
  } else {
    if (tabs[activeTabIndex] && !tabs[activeTabIndex].view.webContents.isDestroyed())
      tabs[activeTabIndex].view.webContents.reload();
    new Notification({ title: 'Claude', body: t('Verbindung wiederhergestellt!', 'Connection restored!') }).show();
  }
}

function showOfflinePage() {
  if (!tabs[activeTabIndex]) return;
  tabs[activeTabIndex].view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
    body{background:#171310;color:#e8e0d8;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
    h1{font-size:22px;font-weight:600;margin-bottom:8px}
    p{color:#8a7e72;font-size:14px;max-width:360px;text-align:center;line-height:1.6}
    button{margin-top:20px;background:#E8524F;color:#fff;border:none;padding:10px 28px;border-radius:10px;font-size:14px;cursor:pointer;font-weight:500}
    button:hover{background:#F0635C}
    .pulse{animation:p 2s ease-in-out infinite}@keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
  </style></head><body><h1>${t('Keine Verbindung', 'No Connection')}</h1><p>${t('Prüfe deine Netzwerkverbindung.', 'Check your network connection.')}</p>
    <p class="pulse" style="font-size:12px">${t('Automatische Wiederverbindung…', 'Reconnecting automatically…')}</p>
    <button onclick="location.href='https://claude.ai'">${t('Erneut versuchen', 'Try Again')}</button></body></html>`));
}

// ── Downloads ──
function setupDownloadManager() {
  session.fromPartition('persist:claude').on('will-download', (_, item) => {
    const fileName = item.getFilename();
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: t('Alle Dateien', 'All Files'), extensions: ['*'] }]
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
      if (state === 'completed') new Notification({ title: t('Download fertig', 'Download complete'), body: fileName }).show();
      else if (state !== 'cancelled') new Notification({ title: t('Download fehlgeschlagen', 'Download failed'), body: fileName }).show();
    });
  });
}

// ── Auto-Updater ──
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  if (isDev) return;
  let updateFailures = 0;
  autoUpdater.on('update-available', (info) => {
    updateFailures = 0;
    new Notification({ title: t('Update verfügbar', 'Update available'), body: `v${info.version} ${t('wird geladen…', 'downloading…')}` }).show();
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
      type: 'info', title: t('Update bereit', 'Update ready'),
      message: `v${info.version} ${t('heruntergeladen. Jetzt neu starten?', 'downloaded. Restart now?')}`,
      buttons: [t('Neu starten', 'Restart'), t('Später', 'Later')], defaultId: 0
    }) === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => {
    updateFailures++;
    console.error(`Update-Fehler (${updateFailures}x):`, err.message);
  });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    // Echtes exponentielles Backoff: bei Fehlern Intervalle überspringen (2^failures - 1)
    if (updateFailures > 0) {
      const skip = (1 << Math.min(updateFailures, 5)) - 1;
      if (Math.random() < skip / (skip + 1)) return;
    }
    autoUpdater.checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);
}

// ── Session-Optimierung ──
function optimizeSession() {
  const ses = session.fromPartition('persist:claude');

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen'];
    callback(allowed.includes(permission));
  });

  // DNT-Header für claude.ai Requests
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.claude.ai/*'] }, (details, cb) => {
    details.requestHeaders['DNT'] = '1';
    cb({ requestHeaders: details.requestHeaders });
  });

  // Preconnect bei Session-Start
  ses.preconnect({ url: 'https://claude.ai', numSockets: 4 });
  ses.preconnect({ url: 'https://cdn.claude.ai', numSockets: 2 });
}

// ── IPC ──
ipcMain.on('tab-new', () => createTab());
ipcMain.on('tab-switch', (_, i) => {
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < tabs.length) switchToTab(i);
});
ipcMain.on('tab-close', (_, i) => {
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < tabs.length) closeTab(i);
});
ipcMain.on('design-toggle', toggleDesign);
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
  // 6) Pool neu füllen sobald Event-Loop frei ist (im neuen Theme)
  setImmediate(fillPool);
});

// ── Fenster ──
function createWindow() {
  const state = loadWindowState();
  nativeTheme.themeSource = isDarkMode ? 'dark' : 'light';
  mainWindow = new BrowserWindow({
    width: state.width, height: state.height, x: state.x, y: state.y,
    minWidth: 480, minHeight: 600, title: 'Claude',
    icon: currentIcon(),
    backgroundColor: currentTheme().bg,
    show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'preload-tabbar.js'),
      backgroundThrottling: false,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck',
    }
  });

  if (state.isMaximized) mainWindow.maximize();

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getTabBarHTML()));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('resize', () => { saveWindowState(); resizeActiveView(); });
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);

  mainWindow.on('blur', () => {
    const v = tabs[activeTabIndex]?.view;
    if (v && !v.webContents.isDestroyed()) {
      v.webContents.executeJavaScript('document.activeElement?.blur()').catch(() => {});
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    tabs.forEach(t => { if (!t.view.webContents.isDestroyed()) t.view.webContents.close(); });
    tabs = [];
    viewPool.forEach(v => { if (!v.webContents.isDestroyed()) v.webContents.close(); });
    viewPool.length = 0;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    const tab = createTab('https://claude.ai');
    // Pool erst füllen wenn der erste Tab fertig geladen hat (spart Bandbreite/CPU beim Start)
    if (tab) {
      tab.view.webContents.once('did-finish-load', () => setImmediate(fillPool));
    }
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
  setInterval(() => handleOnlineChange(net.isOnline()), ONLINE_CHECK_INTERVAL_MS);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const bounds = mainWindow.getBounds();
      windowState = { ...bounds, isMaximized: mainWindow.isMaximized(), customDesign, isDarkMode };
      fs.writeFileSync(stateFile, JSON.stringify(windowState));
    } catch (e) { if (isDev) console.debug('Window-State bei Quit fehlgeschlagen:', e.message); }
  }
});
