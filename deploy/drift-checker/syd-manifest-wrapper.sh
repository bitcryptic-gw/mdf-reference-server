#!/bin/bash
# unraid-syd user.scripts: "mdf-drift-manifest"
# Generates the LOCAL syd manifest every 5 minutes. No HTTP on this side.
# Requires manifest.sh installed at the path below (Gary copies it once from
# deploy/drift-checker/manifest.sh in mdf-reference-server).
set -u
SCRIPT=/mnt/cache/appdata/mdf-drift/manifest.sh
APP=/mnt/cache/appdata/mdf-reference-server
SALT="$APP/drift-salt"
OUT="$APP/manifest.json"

if [ ! -x "$SCRIPT" ]; then
  echo "$(date -u +%FT%TZ) mdf-drift-manifest: missing $SCRIPT" >> /mnt/cache/appdata/mdf-drift/generator.log
  exit 1
fi
if [ ! -f "$SALT" ]; then
  echo "$(date -u +%FT%TZ) mdf-drift-manifest: missing salt $SALT (refusing to write manifest)" >> /mnt/cache/appdata/mdf-drift/generator.log
  exit 1
fi

"$SCRIPT" gen "$APP" "$OUT" "$SALT" syd >> /mnt/cache/appdata/mdf-drift/generator.log 2>&1
