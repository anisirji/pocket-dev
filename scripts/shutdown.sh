#!/bin/bash
# Shuts the Mac down. Usage: npm run shutdown [-- --force]
# Without --force it asks macOS to shut down, like the Apple menu: an app with unsaved changes can stop it.
# --force runs sudo shutdown -h now (asks for your Mac password): apps are not asked and unsaved work is lost.
# Both refuse while a macOS update installs.
# Test stubs: SUDO replaces sudo, POCKET_DEV_OSASCRIPT osascript, POCKET_DEV_UPDATE_CHECK the update check.
set -euo pipefail
cd "$(dirname "$0")/.."
SUDO="${SUDO:-sudo}"
OSASCRIPT="${POCKET_DEV_OSASCRIPT:-/usr/bin/osascript}"
source scripts/power-common.sh

case "${1:-}" in
  "")
    refuse_during_update "Shutting down"
    echo "Asking macOS to shut down. Apps with unsaved changes may stop it and ask you on the Mac."
    "$OSASCRIPT" -e 'tell application "System Events" to shut down'
    ;;
  --force)
    refuse_during_update "Shutting down"
    echo "Force shut down: every app quits without saving. Unsaved work is lost."
    $SUDO shutdown -h now
    ;;
  *)
    echo "usage: npm run shutdown [-- --force]" >&2
    exit 2
    ;;
esac
