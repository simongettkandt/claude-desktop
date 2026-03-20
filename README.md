# Claude Desktop App for Linux

A fast, native desktop app for Claude AI – no browser needed. Runs on all Linux distributions.

## Features

- **Tab System** – Multiple chats side by side with a visual tab bar (Ctrl+T, Ctrl+W, Ctrl+Tab)
- **Dark/Light Mode Toggle** – Moon/Sun button in the tab bar, seamless theme switching
- **Auto-Update** – Automatically updates via GitHub Releases (AppImage)
- **Google OAuth** – Google login works out of the box
- **Bilingual UI** – Automatic language detection (German/English) for all menus and messages
- **Security** – Sandbox enabled, URL validation via `new URL().hostname`, only allowed domains
- **Performance** – GPU acceleration, disk caching, no white flash on start

## Installation

### Snap Store (Ubuntu Software Center)

```bash
sudo snap install claude-ai-desktop
```

### AppImage (all Linux distros)

Download the latest `.AppImage` from [Releases](https://github.com/simongettkandt/claude-desktop/releases):

```bash
chmod +x Claude-Desktop-*.AppImage
./Claude-Desktop-*.AppImage --no-sandbox
```

Or use the included launch script:

```bash
chmod +x start-claude.sh
./start-claude.sh
```

### Desktop shortcut (optional)

```bash
cat > ~/.local/share/applications/claude-desktop.desktop << EOF
[Desktop Entry]
Name=Claude Desktop
Comment=Claude AI Desktop App
Exec=/path/to/Claude-Desktop-1.1.2.AppImage --no-sandbox
Icon=/path/to/icon.png
Type=Application
Categories=Utility;
StartupWMClass=claude-desktop
EOF
```

### From source

```bash
git clone https://github.com/simongettkandt/claude-desktop.git
cd claude-desktop
npm install
npm start
```

Build it yourself:

```bash
npm run build-appimage
```

## Note on --no-sandbox

The `--no-sandbox` flag is required for Electron AppImages on Linux because the Chrome SUID sandbox needs `root:4755` permissions, which are not possible in AppImage's temporary mount point. `CHROME_DEVEL_SANDBOX=''` does **not** work as an alternative – Electron still finds the SUID helper and crashes. The web content sandbox (`sandbox: true` in webPreferences) remains active and protects against untrusted web content.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+1–9 | Switch to tab |
| Ctrl+N | New chat |
| Ctrl+, | Settings |
| Ctrl+R | Reload |
| Ctrl++ / Ctrl+- | Zoom |
| F11 | Fullscreen |

## Architecture

- Tab contents rendered as `BrowserView` (one per tab)
- Tab bar as inline HTML in the main window via `loadURL('data:text/html,...')`
- IPC communication through `preload-tabbar.js` (contextBridge)
- No custom CSS injected into claude.ai – original rendering preserved
- Theme toggle via `nativeTheme.themeSource` (claude.ai responds natively)

## Changelog

### v1.1.2 – Tab System & Theme Toggle (2026-03-20)
- Tab system with visual tab bar (BrowserView per tab)
- Dark/Light mode toggle button (Moon/Sun) in tab bar
- Theme switching via `nativeTheme.themeSource`
- Tab bar with CSS variables for automatic theme adaptation
- No custom CSS for claude.ai – original rendering preserved

### v1.1.1 – Security Hotfix, Auto-Updater & Localization (2026-03-18)
**Security:**
- URL validation: replaced `string.includes()` with `new URL().hostname` (phishing protection)
- `shell.openExternal`: protocol check (only https, http, mailto)
- `will-navigate`: explicit `event.preventDefault()` for unknown URLs
- DevTools restricted to development mode (`!app.isPackaged`)
- OAuth popup is now modal
- CSP headers for local content
- Removed unused imports (`globalShortcut`)

**Features:**
- Auto-updater via `electron-updater` (download progress in title bar)
- Menu item "Check for Updates…" / "Nach Updates suchen…"
- Dynamic User-Agent (uses current `process.versions.chrome` instead of hardcoded v125)

**Localization (DE/EN):**
- Automatic language detection via `$LANG` / `$LANGUAGE` / `app.getLocale()`
- All menus, messages, start script and update notices are bilingual
- `t(de, en)` helper function in main.js

### v1.1.0 – Auto-Update & AppImage (2026-03-18)
- Automatic updates via GitHub Releases (`electron-updater`)
- AppImage format – runs on all Linux distros
- Official Claude icon
- Menu item "Check for Updates…"
- Launch script `start-claude.sh`
- Update notifications + download progress in title bar

### v1.0.1 – Security Update & Bugfix (2026-03-18)
- Sandbox enabled (`sandbox: true`)
- Secure URL validation via URL parsing instead of `string.includes()`
- `shell.openExternal` restricted to `https:` URLs only
- `will-navigate` blocks unknown domains
- DevTools only in development mode
- Focus bug fixed (keystrokes went to app despite window not being active)

### v1.0.0 – Initial Release
- BrowserWindow loads claude.ai with Chrome User-Agent (for Google OAuth)
- Google OAuth popup handling
- Dark mode, German menu, custom CSS

## Known Limitations

- `--no-sandbox` flag required for AppImage (Chrome SUID sandbox needs root:4755, not possible in AppImage mount). Web content sandbox (`sandbox: true`) remains active.
- `CHROME_DEVEL_SANDBOX=''` does NOT work as an alternative – Electron still finds the SUID helper and crashes.

## Security

**Score: 7/10 (Good)** – Own code is clean, dependencies have known vulnerabilities. After fixes: 9/10.

**Open issues:**
1. **HIGH: Dependency vulnerabilities** – 10 vulnerabilities (tar, @tootallnate/once, Electron ASAR). Fix: `npm audit fix --force` (caution: breaking changes with electron-builder)
2. ~~**MEDIUM: `www.google.com` too broad**~~ – Fixed in v1.1.2 (now only `accounts.google.com` and `oauth2.googleapis.com`)
3. **LOW: Auto-updater error logging** – Errors are logged unfiltered, could expose URLs/tokens

## License

This project is an unofficial wrapper. Claude and claude.ai are property of Anthropic.
