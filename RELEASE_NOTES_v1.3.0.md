# Claude Desktop v1.3.0 — Productivity Release

**Released:** 2026-04-22
**Previous version:** [v1.2.2](./RELEASE_NOTES_v1.2.2.md)

The biggest feature update since v1.2.0. Three new windows, system-tray integration, a global hotkey, comprehensive performance tuning, and a smaller AppImage.

---

## At a glance

| Area | New in v1.3.0 |
|------|---------------|
| **Productivity** | Global hotkey + Quick-Prompt window, system tray, App Settings |
| **UI** | What's-New popup, update-check dialogs, tab-bar accents in logo gradient |
| **Performance** | Background throttling for the active tab, ~17 % smaller AppImage |
| **Stability** | 19+ bug fixes from a systematic code review |
| **Security** | Electron 41.2.1 (3 CVEs), hotkey validation, IPC sender checks |

---

## New features

### System tray & background mode

Claude can now keep running in the background. Closing the window minimizes the app to the tray (opt-in, disabled by default); it stays reachable through the tray icon or the global hotkey.

- Tray menu: **Open** · **New Chat** · **App Settings** · **Quit**
- Click on the tray icon toggles the main window
- Preference persisted in `window-state.json` (`minimizeOnClose`)

### Global Quick-Prompt hotkey

A freely configurable, system-wide hotkey opens a slim input window with an animated gradient frame. Text is injected into a fresh chat at `claude.ai/new` and submitted automatically.

- Transparent, frameless, always-on-top
- Auto-focused textarea: **Enter** sends, **Shift+Enter** inserts a newline, **Esc** cancels
- Accepts key combinations like `Alt+C`, `CmdOrCtrl+Shift+Space`, etc.
- Accelerator syntax is validated (see Security)

### App Settings window

A new dialog accessible from the window menu via **Claude → App Settings…**:

- Toggle background mode (minimize-to-tray)
- Set the global hotkey via interactive key-capture, or clear it
- Changes are applied immediately and persisted

### What's-New popup

Shown once after each version update. Triggers on version change, remembers the last-seen version, and is suppressed on subsequent launches.

- Controlled by `lastSeenVersion` in `window-state.json`
- Includes an **Open App Settings** shortcut

### Update-check feedback dialogs

The **Check for Updates** menu entry now shows clear dialogs for **Update available**, **No update**, and **Update error**. Previously the check ran silently in the background.

### Multi-monitor fix

All child windows (Quick-Prompt, Settings, What's-New) now center on the display hosting the main window, not on the system's primary display. Fixes "window opens on the wrong monitor".

---

## Performance

### Background throttling

The active tab view (claude.ai) was previously **not** throttled when the app was minimized or hidden in the tray — even a streaming response kept using full CPU.

Now:

| State | Frame rate | CPU throttling |
|-------|------------|----------------|
| Visible + focused | 60 fps | off |
| **Minimized or in tray** | **10 fps** | **on** |
| Visible but unfocused | 60 fps | off |

Wired up via `minimize` / `hide` / `show` / `restore` / `focus` events on the main window.

### Smaller AppImage

- `electronLanguages: ["en-US", "de"]` saves ~30 MB vs. the full locale set
- Final size: **~103 MB** (v1.2.2 was ~120 MB)
- Custom UI strings go through a lightweight `t(de, en)` helper — no i18n framework

### Other performance fixes

- `brand.js`: the full stylesheet iteration now runs **once** per page load (via a `varsFailed` flag). Previously every theme toggle triggered a complete re-scan.
- Stopped recurring `console.warn` spam when orange CSS vars cannot be detected.

---

## Stability & bug fixes

All known issues from the internal v1.2.2 bug report are resolved, plus findings from a deep review.

### Fixes from v1.2.2 bug report

| # | Issue | Fix |
|---|-------|-----|
| 1 | `brand.js` path broke app startup | File moved to `inject/brand.js`, consistent with `package.json` |
| 2 | Auto-updater back-off escalated permanently | `failures = 0` also on `update-not-available` |
| 3 | Variable shadowing of the `t()` i18n function | Arrow parameter `t` → `tb` in `tabs.find` |
| 4 | Shadowing in `mainWindow.on('closed')` | `t` → `tab` in `tabs.forEach` |
| 5 | Theme toggle didn't persist | `saveWindowState()` called in the `theme-toggle` IPC handler |
| 6 | Missing fallback logging on CSS-var failure | `console.warn` hint pointing at the Classic design |

### Additional fixes

- **Layout clipping fixed** — the tab view is now repositioned on `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen`, `show`, and after the tab's `did-finish-load`.
- **What's-New timing** — popup appears only after claude.ai content has loaded (previously it opened while the right pane was still blank).
- **Update dialogs crash-safe** — `dialog.showMessageBox` now guards against a destroyed `mainWindow`.
- **Interval cleanup** — `updateCheckInterval`, `onlineCheckInterval`, and `waitForFirstTabInterval` are cleared on `before-quit`.
- **`second-instance`** — correctly restores the app from the tray instead of only focusing.
- **Tray icon in sync** — updated alongside `toggleDesign`.
- **Deduplicated `RELEASE_NOTES`** — `'1.3.0-beta.1'` is now an alias for `'1.3.0'`.

---

## Security

- **Electron 41.0.4 → 41.2.1** — closes 3 CVEs
- **electron-builder 26.8.1 → 26.8.2**
- **Hotkey validation** — `settings-hotkey` checks the accelerator string against a regex whitelist (Electron-valid modifiers + keys), blocking arbitrary input.
- **Quick-Prompt IPC sender check** — `quickprompt-submit` / `quickprompt-cancel` now verify `event.sender === quickPromptWindow.webContents`, so only the Quick-Prompt window can drive those channels.
- **Input-length guard** in the main process for Quick-Prompt (max 8000 chars), independent of the preload layer.

---

## File layout (new in v1.3.0)

```
claude-desktop/
├── main.js                    # ~1660 lines (+220 since v1.2.2)
├── inject/
│   └── brand.js               # Custom design / recoloring
├── preload-tabbar.js
├── preload-settings.js        # NEW – Settings-window IPC
├── preload-quickprompt.js     # NEW – Quick-Prompt IPC
├── preload-whatsnew.js        # NEW – What's-New IPC
├── icon.png                   # Modern design
└── icon-original.png          # Classic / terracotta design
```

---

## Dependencies

| Package | v1.2.2 | v1.3.0 | Note |
|---------|--------|--------|------|
| `electron` | ^41.0.4 | **^41.2.1** | 3 CVEs closed |
| `electron-builder` | ^26.8.1 | **^26.8.2** | Patch update |
| `electron-updater` | ^6.8.3 | ^6.8.3 | Up to date |

`npm audit` reports **0 vulnerabilities**.

---

## Install

```bash
chmod +x Claude-Desktop-1.3.0.AppImage
./Claude-Desktop-1.3.0.AppImage --no-sandbox
```

The `--no-sandbox` flag is needed on systems where the Chromium SUID helper is not configured. The in-process web-content sandbox remains active.

---

## Upgrade from v1.2.2

The built-in auto-updater detects v1.3.0 automatically and downloads the update in the background. The **Update ready** dialog appears on the next launch. The **What's-New** popup is shown once after the upgrade.

## Download

- `Claude-Desktop-1.3.0.AppImage` — universal Linux build
- `latest-linux.yml` — required for the auto-updater; do not omit

---

## Credits & references

- Internal bug report `FEHLERBERICHT_v1.2.2.md` (all critical items addressed)
- Systematic deep code review for race conditions, IPC security, and background performance

> **Note:** This is the first release with stable system-tray integration and global-hotkey support on Linux (X11 & Wayland).
