const { app, BrowserWindow, shell, Menu, globalShortcut, nativeTheme, session } = require('electron');
const path = require('path');

// Force dark mode
nativeTheme.themeSource = 'dark';

const isDev = !app.isPackaged;

let mainWindow;

// Sichere Domain-Prüfung
function isAllowedDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'claude.ai' || parsed.hostname.endsWith('.claude.ai');
  } catch {
    return false;
  }
}

function isGoogleAuthDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'accounts.google.com' ||
           parsed.hostname === 'www.google.com' ||
           parsed.hostname === 'oauth2.googleapis.com';
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    title: 'Claude Desktop',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0f0f0f',
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      nativeWindowOpen: true,
      allowRunningInsecureContent: false
    }
  });

  // User-Agent setzen der Google OAuth erlaubt
  // Google blockiert Electron-User-Agents, daher Chrome-UA nutzen
  const chromeUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  mainWindow.webContents.setUserAgent(chromeUA);

  // Claude.ai laden
  mainWindow.loadURL('https://claude.ai');

  // Google OAuth Popups korrekt behandeln
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Google Auth URLs im eigenen Fenster öffnen
    if (isGoogleAuthDomain(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 700,
          title: 'Google Anmeldung',
          parent: mainWindow,
          modal: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
          }
        }
      };
    }

    // Andere Claude-URLs im Hauptfenster
    if (isAllowedDomain(url)) {
      return { action: 'allow' };
    }

    // Nur https-URLs im System-Browser öffnen
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {}
    return { action: 'deny' };
  });

  // Auch neue WebContents (OAuth-Fenster) brauchen den Chrome User-Agent
  app.on('web-contents-created', (event, contents) => {
    contents.setUserAgent(chromeUA);

    // Navigation nur zu erlaubten Domains zulassen
    contents.on('will-navigate', (event, url) => {
      if (isAllowedDomain(url) || isGoogleAuthDomain(url)) {
        return;
      }
      event.preventDefault();
    });
  });

  // Loading indicator
  mainWindow.webContents.on('did-start-loading', () => {
    mainWindow.setTitle('Claude Desktop – Laden…');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setTitle('Claude Desktop');

    // Custom CSS für bessere Desktop-Integration
    mainWindow.webContents.insertCSS(`
      /* Scrollbar styling */
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: #4a4a4a; }

      /* Smooth transitions */
      * { scroll-behavior: smooth; }
    `);
  });

  // Fix: Fokus korrekt abgeben wenn Fenster nicht aktiv
  mainWindow.on('blur', () => {
    mainWindow.webContents.executeJavaScript('document.activeElement?.blur()');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Menü erstellen
function createMenu() {
  const template = [
    {
      label: 'Claude',
      submenu: [
        { label: 'Neuer Chat', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.loadURL('https://claude.ai') },
        { type: 'separator' },
        { label: 'Einstellungen', accelerator: 'CmdOrCtrl+,', click: () => mainWindow.loadURL('https://claude.ai/settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' }
      ]
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Rückgängig' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einfügen' },
        { role: 'selectAll', label: 'Alles auswählen' }
      ]
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'forceReload', label: 'Neu laden erzwingen' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom zurücksetzen' },
        { role: 'zoomIn', label: 'Vergrößern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
        ...(isDev ? [
          { type: 'separator' },
          { role: 'toggleDevTools', label: 'Entwicklertools' }
        ] : [])
      ]
    },
    {
      label: 'Fenster',
      submenu: [
        { role: 'minimize', label: 'Minimieren' },
        { role: 'close', label: 'Schließen' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createWindow();
  createMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
