# Sourced by the service scripts. LABEL is overridable so tests can install a throwaway job.
LABEL="${LABEL:-dev.pocket.server}"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# npm run autostart -- off writes this override; macOS before 13 prints it as `=> true`.
job_disabled() { launchctl print-disabled "$DOMAIN" | grep -E "\"$LABEL\" => (disabled|true)" >/dev/null; }

job_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

job_field() { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n "s/^	$1 = //p" || true; }

# bootout returns before the job is fully gone, and an immediate bootstrap then fails with EIO.
bootout_and_wait() {
  job_loaded || return 0
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 50); do
    job_loaded || return 0
    sleep 0.2
  done
  echo "launchd did not unload $LABEL within 10 s" >&2
  return 1
}

port_answers() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$1/login.html" 2>/dev/null; }
