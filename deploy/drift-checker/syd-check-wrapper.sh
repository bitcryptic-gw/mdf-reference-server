#!/bin/bash
# unraid-syd user.scripts: "mdf-drift-check"
# Runs the drift check in mdf-drift-checker and pings Healthchecks before and
# after (dead-man's switch). The ping URL is a credential and lives in a file,
# never in an env var or script text.
set -u

DATA=/mnt/cache/appdata/mdf-drift-checker
PINGURL_FILE="$DATA/hc-ping.url"
LOG="$DATA/run.log"

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

ping() { # <path: start|success|fail>
  if [ -r "$PINGURL_FILE" ]; then
    curl -fsS -m 10 -o /dev/null "$(cat "$PINGURL_FILE")/$1" 2>/dev/null || log "healthchecks ping $1 failed"
  else
    log "hc-ping.url missing"
  fi
}

[ -r "$PINGURL_FILE" ] || log "warning: hc-ping.url not readable"

ping start

docker exec mdf-drift-checker python3 /opt/mdf-drift/run-check.py /config/config.json > "$DATA/run.stdout" 2>>"$LOG"
RC=$?

ALARM=no
if [ -f "$DATA/verdict.json" ] && grep -q '"alarm": true' "$DATA/verdict.json"; then
  ALARM=yes
fi

log "run rc=$RC alarm=$ALARM"

if [ "$RC" -eq 0 ] && [ "$ALARM" = "no" ]; then
  ping success
else
  ping fail
fi
exit 0
