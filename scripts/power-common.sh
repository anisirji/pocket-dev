# Sourced by sleep.sh and shutdown.sh. POCKET_DEV_UPDATE_CHECK replaces the update check for tests.
UPDATE_CHECK="${POCKET_DEV_UPDATE_CHECK:-scripts/update-check.sh}"

# Only an explicit "idle" lets sleep or shutdown go ahead; a broken or missing check refuses.
refuse_during_update() {
  if [ "$("$UPDATE_CHECK" 2>/dev/null)" != idle ]; then
    echo "A macOS update is being installed. $1 now could interrupt it. Try again after it finishes." >&2
    exit 1
  fi
}
