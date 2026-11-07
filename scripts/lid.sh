#!/bin/bash
# Lets a closed MacBook stay awake, or restores normal lid sleep. Usage: npm run lid -- on|off|status
# on/off change a system setting with sudo, so macOS asks for your password. They refuse while the lid is closed.
# Test stubs: SUDO replaces sudo, POCKET_DEV_PMSET the pmset used for reading, POCKET_DEV_IOREG the lid reading.
set -euo pipefail
SUDO="${SUDO:-sudo}"
PMSET="${POCKET_DEV_PMSET:-/usr/bin/pmset}"
IOREG="${POCKET_DEV_IOREG:-/usr/sbin/ioreg}"

# Turning lid sleep back on with the lid shut would sleep the Mac at once and cut off the phone.
require_lid_open() {
  if "$IOREG" -r -k AppleClamshellState -d 4 | grep -q '"AppleClamshellState" = Yes'; then
    echo "Open the laptop lid to change this. Turning it off while the lid is closed would put the Mac to sleep and disconnect you." >&2
    exit 1
  fi
}

status() {
  if "$PMSET" -g | grep -Eq '^[[:space:]]*SleepDisabled[[:space:]]+1'; then
    echo "Lid closed: the Mac stays awake (SleepDisabled is 1). Turn it off with: npm run lid -- off"
  else
    echo "Lid closed: the Mac sleeps normally (SleepDisabled is 0). Change with: npm run lid -- on"
  fi
}

case "${1:-}" in
  on)
    require_lid_open
    cat <<'WARN'
WARNING: with this on, the Mac never sleeps, even with the lid closed.
  - Keep it on a desk, plugged in, with room to breathe.
  - Never put it in a bag while this is on. It can overheat and drain the battery.
  - Turn it off with: npm run lid -- off
WARN
    $SUDO pmset -a disablesleep 1
    status
    ;;
  off)
    require_lid_open
    $SUDO pmset -a disablesleep 0
    status
    ;;
  status)
    status
    ;;
  *)
    echo "usage: npm run lid -- on|off|status" >&2
    exit 2
    ;;
esac
