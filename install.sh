#!/bin/sh
# Aura one-step install for macOS and Linux.
#   ./install.sh                      this computer runs the hub and the agent (single user)
#   ./install.sh --hub=https://HUB    this computer only runs the agent and pairs with that hub
# It installs the dependencies, pairs this computer (you type the code on your phone), and starts
# Aura at login as YOU (a per-user service, never root), so it can see your screen and browser.
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
HUB=""
for a in "$@"; do case "$a" in --hub=*) HUB="${a#--hub=}";; esac; done

NODE="$(command -v node || true)"
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Aura needs Node.js 20 or newer: https://nodejs.org (or: brew install node / your package manager)"; exit 1
fi
echo "→ Installing dependencies"; npm install --omit=dev --silent

if [ -z "$HUB" ]; then
  ENTRY="$DIR/start.js"; HUB="http://127.0.0.1:8100"; NAME="Aura (hub + agent)"
  echo "→ Starting the hub briefly so this computer can pair"
  "$NODE" "$DIR/hub/server.js" & HUBPID=$!
  sleep 1
  echo "→ Open http://127.0.0.1:8100 on THIS computer to set your PIN, then go to Devices and enter the code below."
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
echo ""
echo "Last step, once per browser: open chrome://extensions (or edge://extensions), turn on Developer mode,"
echo "click 'Load unpacked' and pick:  $DIR/bridge"
echo "It connects to the agent by itself. Choose what Aura may do here at http://127.0.0.1:8101"
