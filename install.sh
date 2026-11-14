#!/bin/sh
# Aura one-step install for macOS and Linux. No admin rights, no Node.js or git needed beforehand.
#   One line:      curl -fsSL https://raw.githubusercontent.com/MarshallStunt/aura/main/install.sh | sh
#   From a copy:   ./install.sh            (or double-click "Install Aura (Mac).command")
#   Hosted hub:    ./install.sh --hub=https://HUB   (or AURA_HUB=https://HUB before the one line)
# It gets Node.js from nodejs.org (checksum-verified) into ~/.aura if you don't have Node 20+,
# gets Aura, pairs this computer (you type a code), and starts Aura at login as YOU (never root).
set -e
AURA_HOME="$HOME/.aura"; mkdir -p "$AURA_HOME"
HUB="${AURA_HUB:-}"
for a in "$@"; do case "$a" in --hub=*) HUB="${a#--hub=}";; esac; done
say() { printf '\033[36m→ %s\033[0m\n' "$1"; }

# ---------- 1. Node.js: yours if it's 20+, otherwise a private copy ----------
NODE="$(command -v node || true)"
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  NODE="$AURA_HOME/node/bin/node"
  if [ ! -x "$NODE" ]; then
    case "$(uname -s)" in Darwin) OS=darwin;; Linux) OS=linux;; *) echo "Unsupported system"; exit 1;; esac
    case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64|amd64) ARCH=x64;; *) echo "Unsupported CPU"; exit 1;; esac
    say "Getting Node.js (one time, about 30 MB)"
    VER="$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v[0-9.]*"[^}]*"lts":"[A-Za-z]*"' | head -1 | sed 's/"version":"\(v[0-9.]*\)".*/\1/')"
    [ -n "$VER" ] || { echo "Couldn't find the current Node.js version."; exit 1; }
    NAME="node-$VER-$OS-$ARCH"
    curl -fsSL "https://nodejs.org/dist/$VER/$NAME.tar.gz" -o "$AURA_HOME/$NAME.tar.gz"
    WANT="$(curl -fsSL "https://nodejs.org/dist/$VER/SHASUMS256.txt" | grep " $NAME.tar.gz\$" | cut -d' ' -f1)"
    GOT="$( (shasum -a 256 "$AURA_HOME/$NAME.tar.gz" 2>/dev/null || sha256sum "$AURA_HOME/$NAME.tar.gz") | cut -d' ' -f1)"
    [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { rm -f "$AURA_HOME/$NAME.tar.gz"; echo "Node.js download failed its checksum. Try again."; exit 1; }
    rm -rf "$AURA_HOME/node"; tar -xzf "$AURA_HOME/$NAME.tar.gz" -C "$AURA_HOME"; mv "$AURA_HOME/$NAME" "$AURA_HOME/node"; rm "$AURA_HOME/$NAME.tar.gz"
  fi
fi
PATH="$(dirname "$NODE"):$PATH"; export PATH

# ---------- 2. Aura itself: this folder, or download it ----------
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/package.json" ] && grep -q '"name": "aura"' "$HERE/package.json"; then DIR="$HERE"
else
  say "Downloading Aura"
  DIR="$AURA_HOME/app"; rm -rf "$AURA_HOME/extract"; mkdir -p "$AURA_HOME/extract"
  curl -fsSL https://github.com/MarshallStunt/aura/archive/refs/heads/main.tar.gz | tar -xz -C "$AURA_HOME/extract"
  rm -rf "$DIR"; mv "$AURA_HOME/extract/aura-main" "$DIR"; rm -rf "$AURA_HOME/extract"
fi
cd "$DIR"
say "Installing Aura's parts"; npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
[ "${AURA_SETUP_ONLY:-}" = "1" ] && { say "Setup only: Node and Aura are ready in $DIR"; exit 0; }

# Stop a running Aura so the pairing step can use the ports.
launchctl bootout "gui/$(id -u)/com.aura.agent" 2>/dev/null || true
systemctl --user stop aura.service 2>/dev/null || true

if [ -z "$HUB" ]; then
  ENTRY="$DIR/start.js"; HUB="http://127.0.0.1:8100"; NAME="Aura (hub + agent)"
  echo "→ Starting the hub briefly so this computer can pair"
  "$NODE" "$DIR/hub/server.js" & HUBPID=$!
  sleep 1
  say "Your browser is opening Aura: set a PIN there, go to System, and enter the code below."
  (open "http://127.0.0.1:8100" 2>/dev/null || xdg-open "http://127.0.0.1:8100" 2>/dev/null || true)
else
  ENTRY="$DIR/agent/agent.js"; NAME="Aura agent"
fi
"$NODE" "$DIR/agent/agent.js" --hub="$HUB" --pair-only
[ -n "$HUBPID" ] && kill "$HUBPID" 2>/dev/null || true

case "$(uname)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.aura.agent.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aura.agent</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ENTRY</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/aura.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/aura.log</string>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/com.aura.agent" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "✓ $NAME runs at login (log: ~/Library/Logs/aura.log)";;
  Linux)
    UNIT="$HOME/.config/systemd/user/aura.service"
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
    systemctl --user enable --now aura.service
    echo "✓ $NAME runs at login (log: journalctl --user -u aura)";;
esac
# ---------- Aura icon: opens Aura in its own window ----------
URL="$HUB"
if [ "$(uname)" = Darwin ]; then
  APP="$HOME/Applications/Aura.app"; mkdir -p "$HOME/Applications"; rm -rf "$APP"
  osacompile -o "$APP" -e "do shell script \"open -na 'Google Chrome' --args --app=$URL --new-window 2>/dev/null || open -na 'Microsoft Edge' --args --app=$URL 2>/dev/null || open $URL\"" >/dev/null
  cp "$DIR/assets/aura.icns" "$APP/Contents/Resources/applet.icns"
  rm -f "$APP/Contents/Resources/Assets.car"   # otherwise macOS shows the default script icon
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true
  codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true; touch "$APP"
  [ -e "$HOME/Desktop/Aura.app" ] || ln -s "$APP" "$HOME/Desktop/Aura.app"
  echo "✓ Aura icon added to your Desktop and ~/Applications (drag it to the Dock if you like)"
else
  mkdir -p "$HOME/.local/share/applications"
  BROWSER_CMD="$(command -v google-chrome || command -v chromium || command -v microsoft-edge || true)"
  EXEC="xdg-open $URL"; [ -n "$BROWSER_CMD" ] && EXEC="$BROWSER_CMD --app=$URL"
  printf '[Desktop Entry]\nName=Aura\nComment=Your work computer, by voice\nExec=%s\nIcon=%s\nTerminal=false\nType=Application\nCategories=Utility;\n' "$EXEC" "$DIR/assets/aura.png" > "$HOME/.local/share/applications/aura.desktop"
  [ -d "$HOME/Desktop" ] && cp "$HOME/.local/share/applications/aura.desktop" "$HOME/Desktop/" && chmod +x "$HOME/Desktop/aura.desktop" 2>/dev/null || true
  echo "✓ Aura icon added to your apps menu"
fi

echo ""
printf '\033[33mLast step, once: add the browser extension.\033[0m\n'
echo "  1. In the Chrome tab that just opened, turn on Developer mode (top right)."
echo "  2. Click 'Load unpacked' and pick this folder (it's selected in the window that opened):"
echo "     $DIR/bridge"
echo "  It connects to Aura by itself. Open Aura any time at http://127.0.0.1:8100"
if [ "$(uname)" = Darwin ]; then
  open -R "$DIR/bridge/manifest.json" 2>/dev/null || true
  open -a "Google Chrome" "chrome://extensions" 2>/dev/null || open -a "Microsoft Edge" "edge://extensions" 2>/dev/null || true
else
  (xdg-open "$DIR/bridge" >/dev/null 2>&1 &) || true
fi
