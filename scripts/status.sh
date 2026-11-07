#!/bin/bash
# Reports the Pocket Dev launchd agent: job state, whether the port answers, the LAN URL, the log, and sleep assertions.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/service-common.sh

if [ ! -f "$PLIST" ]; then
  echo "$LABEL is not installed. Install it with: npm run service:install"
  exit 0
fi
PORT="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PORT' "$PLIST")"
LOG="$(/usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$PLIST")"

echo "== launchd $DOMAIN/$LABEL"
if job_loaded; then
  launchctl print "$DOMAIN/$LABEL" | grep -E "^	(state|pid|runs|last exit code|last terminating signal) = " | sed 's/^	/  /'
else
  echo "  not loaded (plist exists at $PLIST)"
fi

echo "== port $PORT"
lan="$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || echo 127.0.0.1)"
if port_answers "$PORT"; then
  echo "  answering. Phone URL: http://$lan:$PORT"
else
  echo "  not answering on http://127.0.0.1:$PORT/login.html"
fi

echo "== sleep assertions (caffeinate)"
pmset -g assertions | grep -i caffeinate | sed 's/^ */  /' || echo "  none. The Mac may idle-sleep."

echo "== last 20 lines of $LOG"
tail -n 20 "$LOG" 2>/dev/null | sed 's/^/  /' || echo "  no log yet"
