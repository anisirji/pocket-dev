#!/bin/bash
# Stops the Pocket Dev launchd agent and removes its plist. Safe to run when nothing is installed.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/service-common.sh

bootout_and_wait
rm -f "$PLIST"
echo "$LABEL is not installed."
