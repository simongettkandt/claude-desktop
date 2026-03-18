#!/bin/bash
# Claude Desktop Launcher
# Findet und startet das AppImage automatisch mit --no-sandbox

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPIMAGE="$SCRIPT_DIR/Claude-Desktop-1.1.0.AppImage"

if [ ! -f "$APPIMAGE" ]; then
  # Suche nach beliebiger Version
  APPIMAGE=$(find "$SCRIPT_DIR" -name "Claude-Desktop-*.AppImage" -type f | head -1)
fi

if [ -z "$APPIMAGE" ] || [ ! -f "$APPIMAGE" ]; then
  echo "Fehler: Claude-Desktop AppImage nicht gefunden."
  exit 1
fi

chmod +x "$APPIMAGE"
exec "$APPIMAGE" --no-sandbox "$@"
