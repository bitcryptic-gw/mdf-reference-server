#!/usr/bin/env bash
# smoke-test.sh — manual walk-through for the 0.3.x reference server.
#
# This is not an assertion suite and prints no pass/fail verdict. It starts a
# local server with throwaway config and secrets, prints each response, and
# stops. Read the output to judge whether each step behaved.
#
# What it exercises: discovery (/mdf.json, /llms.txt), content negotiation,
# response headers on a free page, the x402 v2 402 (both an unpaid request and a
# malformed PAYMENT-SIGNATURE), the token tier's 402 with its auth_endpoint hint,
# a conditional 304, /health on both the main and dashboard ports, and 404s.
#
# It never settles a payment: that needs a real facilitator, a funded wallet and
# a signed PaymentPayload, none of which belong in a local script. The token tier
# is shown only as far as its 402, because a token cannot be minted without
# paying first.
#
# Config choices, and why they are not the demo's:
#   - `token_store: memory` — one local process, no Valkey needed. Behind a load
#     balancer this would be wrong (tokens are instance-local), which is why the
#     compose stack uses Valkey.
#   - Lightning off — an lnbtc rail needs a funded NWC connection, so
#     /micropayment/** is priced free here rather than inventing an exchange rate.
#   - `MDF_SECRETS_DIR` points at a temp directory, so no real secret is read.
set -euo pipefail
cd "$(dirname "$0")"

PORT=3000
DASHBOARD_PORT=3001
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/mdf-smoke.XXXXXX")
SECRETS_DIR="$WORKDIR/secrets"
CONFIG="$WORKDIR/mdf.smoke.yaml"
DATA_DIR="$WORKDIR/data"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  echo ""
  echo "scratch files kept in: $WORKDIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Throwaway secrets and config
# ---------------------------------------------------------------------------

mkdir -p "$SECRETS_DIR" "$DATA_DIR"
# Any EIP-55 checksummed address works: the server validates the checksum, not
# the balance, and this script never pays anything. The burn address is used so
# no real wallet is named anywhere in the output.
printf '%s' '0x000000000000000000000000000000000000dEaD' > "$SECRETS_DIR/wallet_address"
chmod 600 "$SECRETS_DIR/wallet_address"

cat > "$CONFIG" <<'YAML'
site:
  url: https://localhost:3000
  name: MDF smoke test
  contact: admin@example.com

content:
  dir: ./content

pricing:
  default:
    rails:
      - scheme: exact
        network: "eip155:8453"
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        amount: "100"
  sections:
    /:
      rails: []
    /docs/**:
      rails: []
    # Lightning is off in this script, so this section is free rather than priced
    # in a second rail it cannot offer.
    /micropayment/**:
      rails: []
    /premium/**:
      rails:
        - scheme: exact
          network: "eip155:8453"
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          amount: "10000"
    /private/**:
      access: token
      rails:
        - scheme: exact
          network: "eip155:8453"
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          amount: "100000"
    /testnet/**:
      rails:
        - scheme: exact
          network: "eip155:84532"
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
          amount: "1000"
    /showcase/**:
      rails:
        - scheme: exact
          network: "eip155:8453"
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          amount: "20000"

auth:
  endpoint: /mdf/auth
  token_ttl_seconds: 86400

# Instance-local on purpose: this is one process, with no Valkey to talk to.
token_store: memory

server:
  trusted_proxies: []

signals:
  ai_train: false
  ai_input: true
  search: true
  human_only: false

feed:
  url: /feed.xml
  format: atom
  change_types:
    - content_update
    - new_page
    - pricing_change
    - mdf_capability

dashboard:
  enabled: true
  port: 3001

payment:
  max_timeout_seconds: 300

lightning:
  enabled: false

# Placeholder: the 402 is built without calling a facilitator, so an unreachable
# leg is fine here. Settling needs a real x402 v2 facilitator.
facilitator:
  legs:
    - "http://127.0.0.1:8080"
  timeout_ms: 15000
  rpc:
    "eip155:8453": "https://mainnet.base.org"
    "eip155:84532": "https://sepolia.base.org"
YAML

# ---------------------------------------------------------------------------
# Start the server
# ---------------------------------------------------------------------------

MDF_CONFIG="$CONFIG" \
MDF_SECRETS_DIR="$SECRETS_DIR" \
MDF_DATA_DIR="$DATA_DIR" \
MDF_PORT="$PORT" \
MDF_DASHBOARD_PORT="$DASHBOARD_PORT" \
  bun run src/index.ts > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -s --max-time 1 "http://localhost:$PORT/mdf.json" > /dev/null 2>&1 && break
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited during startup:"
    cat "$WORKDIR/server.log"
    exit 1
  fi
  sleep 0.2
done

echo "=== /mdf.json (mdf_version must be 0.3.1) ==="
curl -s "http://localhost:$PORT/mdf.json" | python3 -c '
import json, sys
doc = json.load(sys.stdin)
print(json.dumps({k: doc[k] for k in ("mdf_version", "site") if k in doc}, indent=2))
print("pricing sections:", ", ".join((doc.get("pricing") or {}).get("sections", {})))
'

echo ""
echo "=== /llms.txt ==="
curl -s "http://localhost:$PORT/llms.txt" | head -20

echo ""
echo "=== / browser representation ==="
curl -s -o /dev/null -w "status:%{http_code} type:%{content_type}\n" \
  -H "Accept: text/html" "http://localhost:$PORT/"

echo ""
echo "=== / agent representation ==="
curl -s -H "Accept: text/markdown" "http://localhost:$PORT/" | head -5

echo ""
echo "=== /docs/getting-started headers (free page) ==="
curl -s -D - -o /dev/null -H "Accept: text/markdown" \
  "http://localhost:$PORT/docs/getting-started" \
  | grep -iE "^HTTP|^content-type|^x-mdf|^etag|^vary"

echo ""
echo "=== /premium/deep-dive — no payment (expect 402 + PAYMENT-REQUIRED) ==="
curl -s -D - -o "$WORKDIR/premium.json" -H "Accept: text/markdown" \
  "http://localhost:$PORT/premium/deep-dive" \
  | grep -iE "^HTTP|^payment-required|^cache-control"
echo "body (abridged):"
python3 -c '
import json, sys
doc = json.load(open(sys.argv[1]))
print(json.dumps({
    "x402Version": doc["x402Version"],
    "error": doc.get("error"),
    "resource": doc["resource"],
    "accepts": [{"scheme": a["scheme"], "network": a["network"], "amount": a["amount"]} for a in doc["accepts"]],
    "extensions.mdf.info.version": doc["extensions"]["mdf"]["info"]["version"],
}, indent=2))
' "$WORKDIR/premium.json"

echo ""
echo "=== /premium/deep-dive — malformed PAYMENT-SIGNATURE (expect 402, error invalid_payment) ==="
curl -s -w "\nstatus:%{http_code}\n" \
  -H "PAYMENT-SIGNATURE: not-a-valid-payment-signature" \
  -H "Accept: text/markdown" \
  "http://localhost:$PORT/premium/deep-dive" | head -4

echo ""
echo "=== /private/internals — token tier, no token (expect 402 + auth_endpoint) ==="
curl -s -o "$WORKDIR/private.json" -w "status:%{http_code}\n" \
  "http://localhost:$PORT/private/internals"
python3 -c '
import json, sys
info = json.load(open(sys.argv[1]))["extensions"]["mdf"]["info"]
print(json.dumps({k: info.get(k) for k in ("version", "price_summary", "auth_endpoint")}, indent=2))
' "$WORKDIR/private.json"

echo ""
echo "=== POST /mdf/auth — unpaid (expect 402, same auth_endpoint hint, no token) ==="
# A token can only be minted by paying: the endpoint takes a PAYMENT-SIGNATURE
# for a token-access section and returns a bearer token in exchange. Without one
# it answers with the same 402 the section does.
curl -s -w "\nstatus:%{http_code}\n" \
  -X POST "http://localhost:$PORT/mdf/auth" \
  -H "Content-Type: application/json" \
  -d '{"resource":"/private/internals"}' | head -4

echo ""
echo "=== 304 conditional GET (free page) ==="
ETAG=$(curl -s -D - -o /dev/null -H "Accept: text/markdown" \
  "http://localhost:$PORT/docs/getting-started" \
  | grep -i '^etag' | tr -d '\r' | awk '{print $2}')
echo "ETag: $ETAG"
curl -s -o /dev/null -w "status:%{http_code}\n" \
  -H "Accept: text/markdown" \
  -H "If-None-Match: $ETAG" \
  "http://localhost:$PORT/docs/getting-started"

echo ""
echo "=== /health — main port ==="
curl -s "http://localhost:$PORT/health" | python3 -m json.tool

echo ""
echo "=== /health — dashboard port (different shape: {ok, ts}) ==="
curl -s "http://localhost:$DASHBOARD_PORT/health"

echo ""
echo "=== 404 — unknown path (expect 404, not 402) ==="
curl -s -o /dev/null -w "status:%{http_code}\n" "http://localhost:$PORT/does-not-exist"

echo ""
echo "=== 404 — unknown path under a paid section (expect 404, not 402) ==="
curl -s -o /dev/null -w "status:%{http_code}\n" "http://localhost:$PORT/premium/does-not-exist"

echo ""
echo "=== 404 — unknown path under a free section (expect 404) ==="
curl -s -o /dev/null -w "status:%{http_code}\n" "http://localhost:$PORT/docs/does-not-exist"

echo ""
echo "=== feed ==="
curl -s "http://localhost:$PORT/feed.xml" | head -8

echo ""
echo "=== server log (first lines) ==="
head -5 "$WORKDIR/server.log"
