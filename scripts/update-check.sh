#!/bin/bash
# Prints "idle" when no macOS software update is being prepared or installed, "installing" otherwise. Read-only.
# Signals: an update process holding a sleep assertion (they hold one while preparing or installing),
# or a `softwareupdate --install` run from a terminal. POCKET_DEV_PMSET replaces pmset for tests.
PMSET="${POCKET_DEV_PMSET:-/usr/bin/pmset}"
UPDATERS='softwareupdated|UpdateBrainService|osinstallersetupd|system_installd|SoftwareUpdateNotificationManager'
assertions="$("$PMSET" -g assertions)" || { echo "unknown"; exit 0; }
if grep -Eq "pid [0-9]+\(($UPDATERS)\):.*Prevent(UserIdle)?SystemSleep" <<<"$assertions" ||
   pgrep -f 'softwareupdate .*(-i|--install)' >/dev/null; then
  echo installing
else
  echo idle
fi
