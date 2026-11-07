#!/bin/bash
# Turns starting Pocket Dev at login on or off, or shows it. Neither starts nor stops the running server.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/service-common.sh

installed=no
[ -f "$PLIST" ] && installed=yes
case "${1:-status}" in
  on)
    launchctl enable "$DOMAIN/$LABEL"
    [ "$installed" = yes ] || echo "$LABEL is not installed yet. Install it with: npm run service:install"
    echo "$LABEL starts automatically when you log in."
    ;;
  off)
    launchctl disable "$DOMAIN/$LABEL"
    echo "$LABEL no longer starts automatically. A running server keeps running until it stops or the Mac restarts."
    ;;
  status)
    auto=on
    job_disabled && auto=off
    [ "$installed" = yes ] || auto="off (not installed)"
    pid="$(job_field pid)"
    echo "Installed: $installed"
    echo "Start automatically: $auto"
    echo "Running: ${pid:+yes, pid $pid}${pid:-no}"
    ;;
  *)
    echo "usage: npm run autostart -- on|off|status" >&2
    exit 2
    ;;
esac
