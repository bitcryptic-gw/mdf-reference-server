#!/bin/sh
# mdf-drift manifest generator (shared, self-contained)
#
# Modes:
#   gen <appdata_dir> <out_file> <salt_file> <host_label>
#       digest the MDF appdata content/mdf.yaml/secrets into out_file
#       (one shared file is used by BOTH hosts so canonicalisation cannot
#        drift between them).
#   repo-digests <repo_dir>
#       print {"mdf_yaml":..,"content":{..}} for a fresh mdf-reference-server
#       clone, using the SAME canonicalisation as `gen`. No secrets (the repo
#       holds none).
#
# Requirements: POSIX sh + sha256sum + openssl (HMAC) + od + sed + find.
# Refuses to write a manifest when the salt or any secret file is missing,
# so a broken generator never silently drops a comparison class.

set -eu

SENT="__MDF_PUBKEY_PLACEHOLDER__"
SECRETS="wallet_address alby_api_token lightning_token_secret oracle_pubkey"

# sha256sum (alpine/busybox, unraid) or shasum -a 256 (macOS test host)
if command -v sha256sum >/dev/null 2>&1; then
  HASH() { sha256sum "$@"; }
else
  HASH() { shasum -a 256 "$@"; }
fi

sha256_of() { HASH "$1" | awk '{print $1}'; }
stdin_sha() { HASH | awk '{print $1}'; }

# Normalise the oracle.pubkey PLACEHOLDER ("" or []) to a fixed sentinel so the
# two placeholder forms compare equal. A real non-empty pubkey is left intact
# and will diverge if hosts disagree.
norm_mdf() {
  sed -E 's/^([[:space:]]*)pubkey:[[:space:]]*(""|\[[[:space:]]*\]).*$/\1pubkey: '"$SENT"'/' "$1"
}

mdf_digest() { norm_mdf "$1" | stdin_sha; }

salt_hex() { od -An -tx1 "$1" | tr -d ' \n'; }

# HMAC-SHA256 of a file keyed by the shared salt, hex, truncated to 16 bytes.
hmac_digest() { # file saltfile
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(salt_hex "$2")" "$1" 2>/dev/null | awk '{print $NF}' | cut -c1-32
}

# print "<reldir>/<file>\t<hash>" per content markdown file, sorted.
content_rows() { # appdata_dir
  cd "$1"
  find content -name '*.md' -type f 2>/dev/null | sort | while IFS= read -r f; do
    printf '%s\t%s\n' "${f#content/}" "$(sha256_of "$f")"
  done
}

content_json() { # appdata_dir
  content_rows "$1" | awk 'BEGIN{printf "{"} {if(n++)printf ","; printf "\"%s\":\"%s\"",$1,$2} END{printf "}"}'
}

gen() {
  APP="$1"; OUT="$2"; SALT="$3"; HOST="$4"

  [ -f "$SALT" ] && [ -s "$SALT" ] || { echo "mdf-manifest: salt missing or empty: $SALT (refusing to write manifest)" >&2; exit 1; }
  [ -f "$APP/mdf.yaml" ] || { echo "mdf-manifest: $APP/mdf.yaml missing" >&2; exit 1; }
  for s in $SECRETS; do
    [ -r "$APP/secrets/$s" ] || { echo "mdf-manifest: secret missing/unreadable: secrets/$s (refusing to write manifest)" >&2; exit 1; }
  done

  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  MDF=$(mdf_digest "$APP/mdf.yaml")
  CJSON=$(content_json "$APP")
  # secrets object, fixed order
  SJSON=$( { n=0; out='{'; for s in $SECRETS; do if [ "$n" -gt 0 ]; then out="$out,"; fi; n=$((n+1)); out="$out\"$s\":\"$(hmac_digest "$APP/secrets/$s" "$SALT")\""; done; printf '%s}\n' "$out"; } )

  TMP="${OUT}.tmp"
  {
    printf '{\n'
    printf '  "generated_at": "%s",\n' "$TS"
    printf '  "host": "%s",\n' "$HOST"
    printf '  "mdf": {\n'
    printf '    "mdf_yaml": "%s",\n' "$MDF"
    printf '    "content": %s,\n' "$CJSON"
    printf '    "secrets": %s\n' "$SJSON"
    printf '  }\n'
    printf '}\n'
  } > "$TMP"
  mv -f "$TMP" "$OUT"
  echo "mdf-manifest: wrote $OUT (host=$HOST, ts=$TS)" >&2
}

repo_digests() {
  REPO="$1"
  [ -f "$REPO/mdf.yaml" ] || { echo "repo-digests: $REPO/mdf.yaml missing" >&2; exit 1; }
  MDF=$(mdf_digest "$REPO/mdf.yaml")
  CJSON=$(content_json "$REPO")
  printf '{"mdf_yaml":"%s","content":%s}\n' "$MDF" "$CJSON"
}

mode="${1:-}"
case "$mode" in
  gen) [ "$#" -eq 5 ] || { echo "usage: manifest.sh gen <appdata> <out> <salt> <host>" >&2; exit 1; }
       gen "$2" "$3" "$4" "$5" ;;
  repo-digests) [ "$#" -eq 2 ] || { echo "usage: manifest.sh repo-digests <repo_dir>" >&2; exit 1; }
       repo_digests "$2" ;;
  *) echo "usage: manifest.sh {gen <appdata> <out> <salt> <host> | repo-digests <repo_dir>}" >&2; exit 1 ;;
esac
