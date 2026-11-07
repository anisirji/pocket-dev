#!/bin/bash
# Lets a closed MacBook stay awake, or restores normal lid sleep. Usage: npm run lid -- on|off|status
# on/off change a system setting with sudo, so macOS asks for your password. SUDO overrides sudo for tests.
set -euo pipefail
SUDO="${SUDO:-sudo}"

status() {
  if pmset -g | grep -Eq '^[[:space:]]*SleepDisabled[[:space:]]+1'; then
    echo "Lid closed: the Mac stays awake (SleepDisabled is 1). Turn it off with: npm run lid -- off"
  else
    echo "Lid closed: the Mac sleeps normally (SleepDisabled is 0). Change with: npm run lid -- on"
  fi
}

case "${1:-}" in
  on)
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
