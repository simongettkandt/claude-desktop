# Claude Desktop v1.3.1

A focused bugfix and polish release on top of v1.3.0. No new architecture — just things that should have worked the first time, plus a long-requested autostart toggle.

---

## ✨ Highlights

| | |
|---|---|
| 🔗 | **Code tab opens correctly** — clicking *Code* in the sidebar no longer flashes a window that closes itself. |
| 🎨 | **Tray icon redesigned** — the sparkle now shows transparently with a soft gradient (modern theme) or solid Anthropic orange (classic theme). Clearly recognisable on both light and dark trays. |
| 🚀 | **Autostart at login** — optional toggle in *App Settings*. Claude launches automatically when your system boots. |

---

## 🐛 Bug Fixes

- **Save dialog appeared twice.** Some download links fired a second `will-download` event after the first completed. Implemented an active-lock per filename plus a 3-second cool-down to drop echo events. Asynchronous save dialog so the event loop is no longer blocked.
- **Quick-Prompt sent the message automatically.** It used to inject the text and immediately click *Send* / dispatch a synthetic *Enter*. Now it just inserts the text and places the cursor at the end — you press Enter yourself. This matches the "passive wrapper" principle.
- **Update and notice dialogs landed on the wrong monitor.** The native GTK message box on Linux ignored the parent window and opened on the primary display, regardless of where the main window actually was. Replaced all `dialog.showMessageBox` calls with a custom in-app message box that centres reliably over the main window on multi-monitor setups. Supports `Esc` to cancel and `Enter` to confirm.
- **Code tab in the sidebar did nothing visible.** New windows opened from `claude.ai` were caught by the OAuth-cleanup lifecycle and closed immediately. The cleanup logic now activates only for actual OAuth domains, leaving normal `claude.ai` child windows alone.

---

## 🚀 New Features

### Autostart at Login

- Toggle under **Menu → App Settings…**
- On enable: an entry is registered with the OS via `app.setLoginItemSettings`; on Linux this writes a `.desktop` file to `~/.config/autostart/`.
- When packaged as an AppImage, the registered path uses the `APPIMAGE` environment variable, so the entry stays valid even if you move the AppImage between standard locations.
- Off by default. Turn it off any time and the autostart entry is removed.

### Tray Icon

- Modern theme: sparkle on transparent background, vertical gradient `#FF6A2A → #E04E3F`.
- Classic theme: sparkle on transparent background, solid `#F26A3F` (the original Anthropic accent).
- Larger logo area inside the 22-pixel tray slot for clearer recognition at every system scale factor.
- Tray icon switches automatically when you toggle between Modern and Classic via *View → Design*.

---

## 📦 Installation / Update

### AppImage

1. Download `Claude-Desktop-1.3.1.AppImage` from the assets below.
2. `chmod +x Claude-Desktop-1.3.1.AppImage`
3. Run with `--no-sandbox` if your system does not allow Electron's setuid sandbox helper:
   ```bash
   ./Claude-Desktop-1.3.1.AppImage --no-sandbox
   ```

The auto-updater inside earlier 1.3.x builds will pick this release up automatically — no manual download required if you already have v1.3.0 installed.

### Snap Store

```bash
sudo snap refresh claude-ai-desktop
```

---

## 🔧 Technical Notes

- Electron 41.2.1, electron-builder 26.8.2, electron-updater 6.8.3
- AppImage size: ~103 MB (`electronLanguages: ["en-US", "de"]` keeps Chromium locales trimmed)
- New files in this release: `preload-messagebox.js`, `icon-tray.png`, `icon-original-tray.png`
- The custom message box is a frameless `BrowserWindow` with its own preload bridge; it inherits the active theme and accent colour at open time
- Download deduplication uses an active-set keyed on filename plus a 3-second post-completion cool-down map; both are pruned automatically

---

## 🙏 Thanks

Reported and tested locally before release. Snap and AppImage builds verified on Ubuntu 24.04.
