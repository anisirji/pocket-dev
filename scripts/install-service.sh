#!/bin/bash
# Installs Pocket Dev as a launchd agent that starts at login and restarts after a crash.
# Rerunning rewrites the plist and restarts the server. Env overrides: LABEL, PORT, LOG.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
source scripts/service-common.sh

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "usage: $0 [--force]" >&2; exit 2 ;;
  esac
done

NODE="$(command -v node)" || { echo "node is not on PATH" >&2; exit 1; }
PORT="${PORT:-$("$NODE" -e 'try { console.log(JSON.parse(require("fs").readFileSync("config.json")).port || 7777) } catch { console.log(7777) }')}"
LOG="${LOG:-$HOME/Library/Logs/pocket-dev.log}"

our_pid="$(job_field pid)"
foreign=""
for pid in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
  parent="$(ps -o ppid= -p "$pid" | tr -d ' ' || true)"
  if [ -z "$our_pid" ] || { [ "$pid" != "$our_pid" ] && [ "$parent" != "$our_pid" ]; }; then
    foreign="$foreign $pid"
  fi
done
if [ -n "$foreign" ]; then
  echo "Port $PORT is in use by a process that is not the $LABEL service:"
  for pid in $foreign; do ps -o pid=,command= -p "$pid"; done
  if [ "$FORCE" = 0 ]; then
    echo
    echo "Stop it, then run this script again:"
    echo "  pkill -f \"node server.js\"    # or: kill$foreign"
    echo "Or pass --force to install now. The service then retries every 10 s until the port is free."
    exit 1
  fi
  echo "--force: installing anyway. The service starts when port $PORT is free."
fi

[ -d node_modules ] || npm install
npm run --silent postinstall

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
tmp="$PLIST.tmp"
cat >"$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>-s</string>
    <string>$NODE</string>
    <string>$REPO/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>HOME</key><string>$HOME</string>
    <key>SHELL</key><string>/bin/zsh</string>
    <key>USER</key><string>$(id -un)</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
</dict>
</plist>
PLIST
plutil -lint -s "$tmp"

if job_loaded && cmp -s "$tmp" "$PLIST"; then
  rm "$tmp"
  launchctl kickstart -k "$DOMAIN/$LABEL"
else
  bootout_and_wait
  mv "$tmp" "$PLIST"
  launchctl bootstrap "$DOMAIN" "$PLIST"
fi

if [ -n "$foreign" ]; then
  echo "Installed $LABEL. Check it with: npm run service:status"
  exit 0
fi
for _ in $(seq 30); do
  if port_answers "$PORT"; then
    lan="$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || echo 127.0.0.1)"
    echo "Pocket Dev is running as $LABEL at http://$lan:$PORT"
    exit 0
  fi
  sleep 0.5
done
echo "$LABEL is loaded but port $PORT did not answer within 15 s. Last log lines:" >&2
tail -n 20 "$LOG" >&2
exit 1
