#!/bin/sh
# Atlas one-step install for macOS and Linux. No admin rights, no Node.js or git needed beforehand.
#   One line:      curl -fsSL https://raw.githubusercontent.com/MarshallStunt/atlas/main/install.sh | sh
#   From a copy:   ./install.sh            (or double-click "Install Atlas (Mac).command")
#   Hosted hub:    ./install.sh --hub=https://HUB   (or ATLAS_HUB=https://HUB before the one line)
# It gets Node.js from nodejs.org (checksum-verified) into ~/.atlas if you don't have Node 20+,
# gets Atlas, pairs this computer (you type a code), and starts Atlas at login as YOU (never root).
set -e
ATLAS_HOME="$HOME/.atlas"
# Installs from before the rename (Aura) keep their folder, so the extension loaded from it keeps working.
[ -d "$HOME/.aura" ] && [ ! -d "$ATLAS_HOME" ] && ATLAS_HOME="$HOME/.aura"
mkdir -p "$ATLAS_HOME"
HUB="${ATLAS_HUB:-}"
for a in "$@"; do case "$a" in --hub=*) HUB="${a#--hub=}";; esac; done
say() { printf '\033[36m→ %s\033[0m\n' "$1"; }
printf '\033[90mAtlas installer (version 2026-11-14.4)\033[0m\n'

# ---------- 1. Node.js: yours if it's 20+, otherwise a private copy ----------
NODE="$(command -v node || true)"
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  NODE="$ATLAS_HOME/node/bin/node"
  if [ -x "$NODE" ]; then say "Using Node.js already set up for Atlas"
  else
    case "$(uname -s)" in Darwin) OS=darwin;; Linux) OS=linux;; *) echo "Unsupported system"; exit 1;; esac
    case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64|amd64) ARCH=x64;; *) echo "Unsupported CPU"; exit 1;; esac
    say "Getting Node.js (one time, about 30 MB)"
    VER="$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v[0-9.]*"[^}]*"lts":"[A-Za-z]*"' | head -1 | sed 's/"version":"\(v[0-9.]*\)".*/\1/')"
    [ -n "$VER" ] || { echo "Couldn't find the current Node.js version."; exit 1; }
    NAME="node-$VER-$OS-$ARCH"
    curl -fsSL "https://nodejs.org/dist/$VER/$NAME.tar.gz" -o "$ATLAS_HOME/$NAME.tar.gz"
    WANT="$(curl -fsSL "https://nodejs.org/dist/$VER/SHASUMS256.txt" | grep " $NAME.tar.gz\$" | cut -d' ' -f1)"
    GOT="$( (shasum -a 256 "$ATLAS_HOME/$NAME.tar.gz" 2>/dev/null || sha256sum "$ATLAS_HOME/$NAME.tar.gz") | cut -d' ' -f1)"
    [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { rm -f "$ATLAS_HOME/$NAME.tar.gz"; echo "Node.js download failed its checksum. Try again."; exit 1; }
    rm -rf "$ATLAS_HOME/node"; tar -xzf "$ATLAS_HOME/$NAME.tar.gz" -C "$ATLAS_HOME"; mv "$ATLAS_HOME/$NAME" "$ATLAS_HOME/node"; rm "$ATLAS_HOME/$NAME.tar.gz"
  fi
fi
PATH="$(dirname "$NODE"):$PATH"; export PATH

# ---------- 2. Atlas itself: this folder, or download it ----------
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/package.json" ] && grep -q '"name": "atlas"' "$HERE/package.json"; then DIR="$HERE"
else
  DIR="$ATLAS_HOME/app"
  if [ -d "$DIR" ]; then say "Updating Atlas to the latest version"; else say "Downloading Atlas"; fi
  rm -rf "$ATLAS_HOME/extract"; mkdir -p "$ATLAS_HOME/extract"
  curl -fsSL https://github.com/MarshallStunt/atlas/archive/refs/heads/main.tar.gz | tar -xz -C "$ATLAS_HOME/extract"
  NEW="$ATLAS_HOME/extract/atlas-main"
  # Keep the already-installed parts when they haven't changed, so updates are quick.
  if [ -d "$DIR/node_modules" ] && cmp -s "$DIR/package-lock.json" "$NEW/package-lock.json"; then mv "$DIR/node_modules" "$NEW/node_modules"; REUSED=1; fi
  rm -rf "$DIR"; mv "$NEW" "$DIR"; rm -rf "$ATLAS_HOME/extract"
fi
cd "$DIR"
if [ -n "${REUSED:-}" ]; then say "Atlas's parts are up to date"
else say "Installing Atlas's parts"; npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error; fi
[ "${ATLAS_SETUP_ONLY:-}" = "1" ] && { say "Setup only: Node and Atlas are ready in $DIR"; exit 0; }

# Stop a running Atlas so the pairing step can use the ports.
launchctl bootout "gui/$(id -u)/com.atlas.agent" 2>/dev/null || true
systemctl --user stop atlas.service 2>/dev/null || true
# The app used to be called Aura: remove its old login service and icons.
launchctl bootout "gui/$(id -u)/com.aura.agent" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/com.aura.agent.plist" 2>/dev/null
systemctl --user disable --now aura.service 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/aura.service" "$HOME/.local/share/applications/aura.desktop" 2>/dev/null
rm -rf "$HOME/Applications/Aura.app" 2>/dev/null; [ -L "$HOME/Desktop/Aura.app" ] && rm -f "$HOME/Desktop/Aura.app"

if [ -z "$HUB" ]; then
  ENTRY="$DIR/start.js"; HUB="http://127.0.0.1:8100"; NAME="Atlas (hub + agent)"
  echo "→ Starting the hub briefly so this computer can pair"
  "$NODE" "$DIR/hub/server.js" & HUBPID=$!
  sleep 1
  say "Your browser is opening Atlas: set a PIN there, go to System, and enter the code below."
  (open "http://127.0.0.1:8100" 2>/dev/null || xdg-open "http://127.0.0.1:8100" 2>/dev/null || true)
else
  ENTRY="$DIR/agent/agent.js"; NAME="Atlas agent"
fi
"$NODE" "$DIR/agent/agent.js" --hub="$HUB" --pair-only
[ -n "$HUBPID" ] && kill "$HUBPID" 2>/dev/null || true

case "$(uname)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.atlas.agent.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.atlas.agent</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ENTRY</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/atlas.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/atlas.log</string>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/com.atlas.agent" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "✓ $NAME runs at login (log: ~/Library/Logs/atlas.log)";;
  Linux)
    UNIT="$HOME/.config/systemd/user/atlas.service"
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UN
[Unit]
Description=$NAME
After=graphical-session.target
[Service]
ExecStart=$NODE $ENTRY
WorkingDirectory=$DIR
Restart=always
[Install]
WantedBy=default.target
UN
    systemctl --user daemon-reload
    systemctl --user enable --now atlas.service
    echo "✓ $NAME runs at login (log: journalctl --user -u atlas)";;
esac
# ---------- Atlas icon: opens Atlas in its own window ----------
URL="$HUB"
if [ "$(uname)" = Darwin ]; then
  APP="$HOME/Applications/Atlas.app"; mkdir -p "$HOME/Applications"; rm -rf "$APP"
  # The icon also starts Atlas if it isn't running (e.g. it was stopped), then opens it.
  osacompile -o "$APP" -e "do shell script \"launchctl kickstart gui/$(id -u)/com.atlas.agent >/dev/null 2>&1; sleep 1; open -na 'Google Chrome' --args --app=$URL --new-window 2>/dev/null || open -na 'Microsoft Edge' --args --app=$URL 2>/dev/null || open $URL\"" >/dev/null
  cp "$DIR/assets/atlas.icns" "$APP/Contents/Resources/applet.icns"
  rm -f "$APP/Contents/Resources/Assets.car"   # otherwise macOS shows the default script icon
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true
  codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true; touch "$APP"
  [ -e "$HOME/Desktop/Atlas.app" ] || ln -s "$APP" "$HOME/Desktop/Atlas.app"
  echo "✓ Atlas icon added to your Desktop and ~/Applications (drag it to the Dock if you like)"
else
  mkdir -p "$HOME/.local/share/applications"
  BROWSER_CMD="$(command -v google-chrome || command -v chromium || command -v microsoft-edge || true)"
  EXEC="xdg-open $URL"; [ -n "$BROWSER_CMD" ] && EXEC="$BROWSER_CMD --app=$URL"
  printf '[Desktop Entry]\nName=Atlas\nComment=Your work computer, by voice\nExec=%s\nIcon=%s\nTerminal=false\nType=Application\nCategories=Utility;\n' "$EXEC" "$DIR/assets/atlas.png" > "$HOME/.local/share/applications/atlas.desktop"
  [ -d "$HOME/Desktop" ] && cp "$HOME/.local/share/applications/atlas.desktop" "$HOME/Desktop/" && chmod +x "$HOME/Desktop/atlas.desktop" 2>/dev/null || true
  echo "✓ Atlas icon added to your apps menu"
fi

# The extension lives in its own folder that updates write into (never delete), so the browser keeps
# it loaded; it reloads itself when a newer version arrives.
EXT="$ATLAS_HOME/extension"
FIRST=""; [ -f "$EXT/manifest.json" ] || FIRST=1
mkdir -p "$EXT"; cp -R "$DIR/bridge/." "$EXT/"
echo ""
if [ -z "$FIRST" ]; then
  echo "✓ Browser extension updated; it reloads itself within a minute."
  exit 0
fi
printf '\033[33mLast step, once: add the browser extension.\033[0m\n'
echo "  (If you added it before from another folder, remove that one first.)"
echo "  1. In the Chrome tab that just opened, turn on Developer mode (top right)."
echo "  2. Click 'Load unpacked' and pick this folder (it's selected in the window that opened):"
echo "     $EXT"
echo "  It connects to Atlas by itself. Open Atlas any time at http://127.0.0.1:8100"
if [ "$(uname)" = Darwin ]; then
  open -R "$EXT/manifest.json" 2>/dev/null || true
  open -a "Google Chrome" "chrome://extensions" 2>/dev/null || open -a "Microsoft Edge" "edge://extensions" 2>/dev/null || true
else
  (xdg-open "$EXT" >/dev/null 2>&1 &) || true
fi
