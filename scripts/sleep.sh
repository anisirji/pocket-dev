#!/bin/bash
# Puts the Mac to sleep when lid sleep is off: turns lid sleep back on (sudo asks for your password), then sleeps.
# Runs even with the lid closed, because sleeping is the goal. Refuses while a macOS update installs.
# Test stubs: SUDO replaces sudo, POCKET_DEV_PMSET pmset, POCKET_DEV_UPDATE_CHECK the update check.
set -uo pipefail
cd "$(dirname "$0")/.."
SUDO="${SUDO:-sudo}"
PMSET="${POCKET_DEV_PMSET:-/usr/bin/pmset}"
source scripts/power-common.sh

refuse_during_update Sleeping
echo "Putting the Mac to sleep:"
echo "  1. sudo pmset -a disablesleep 0   turns lid sleep back on (asks for your Mac password)"
echo "  2. Pocket Dev pauses caffeinate and runs pmset sleepnow"
if ! $SUDO pmset -a disablesleep 0; then
  echo "sudo did not run, so lid sleep is still off and the Mac stays awake." >&2
  exit 1
fi
# The server pauses caffeinate before sleeping; only when no server runs (exit 3) sleep directly.
node scripts/awake.js sleep
code=$?
if [ "$code" = 3 ]; then
  "$PMSET" sleepnow
  exit $?
fi
exit "$code"
