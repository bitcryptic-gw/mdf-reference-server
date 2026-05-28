#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

MDF_WALLET=0xDeAdBeEf1234 MDF_PORT=3000 MDF_DASHBOARD_PORT=3001 bun src/index.ts &
SERVER_PID=$!

# Poll until ready
for i in $(seq 1 30); do
  curl -s --max-time 1 http://localhost:3000/mdf.json > /dev/null 2>&1 && break
  sleep 0.2
done

echo ""
echo "=== /mdf.json ==="
curl -s http://localhost:3000/mdf.json | python3 -m json.tool

echo ""
echo "=== /llms.txt ==="
curl -s http://localhost:3000/llms.txt

echo ""
echo "=== / browser ==="
curl -s -o /dev/null -w "status:%{http_code} type:%{content_type}\n" -H "Accept: text/html" http://localhost:3000/

echo ""
echo "=== / agent (markdown) ==="
curl -s -H "Accept: text/markdown" http://localhost:3000/ | head -5

echo ""
echo "=== /docs/getting-started response headers ==="
curl -s -D - -o /dev/null -H "Accept: text/markdown" http://localhost:3000/docs/getting-started \
  | grep -E "^HTTP|Content-Type|X-MDF|ETag"

echo ""
echo "=== /premium/deep-dive — no payment ==="
curl -s http://localhost:3000/premium/deep-dive

echo ""
echo "=== /premium/deep-dive — stub payment ==="
curl -s -w "\nstatus:%{http_code}" \
  -H 'X-Payment: {"chain":"base","currency":"USDC","amount":"1.0000","txHash":"0xabc","from":"0xuser"}' \
  -H "Accept: text/markdown" \
  http://localhost:3000/premium/deep-dive | head -8

echo ""
echo "=== /private/internals — no token, no payment ==="
curl -s http://localhost:3000/private/internals

echo ""
echo "=== POST /mdf/auth — issue bearer token ==="
TOKEN_RESP=$(curl -s -X POST http://localhost:3000/mdf/auth \
  -H "Content-Type: application/json" \
  -d '{"path":"/private/internals","txHash":"0xdeadbeef","from":"0xwallet"}')
echo "$TOKEN_RESP"
TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo ""
echo "=== /private/internals — with bearer token ==="
curl -s -D - -o /dev/null \
  -H "Accept: text/markdown" \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/private/internals \
  | grep -E "^HTTP|Content-Type|X-MDF"

echo ""
echo "=== 304 conditional GET ==="
ETAG=$(curl -s -D - -o /dev/null -H "Accept: text/markdown" \
  http://localhost:3000/docs/getting-started \
  | grep -i etag | tr -d '\r' | awk '{print $2}')
echo "ETag: $ETAG"
curl -s -o /dev/null -w "status:%{http_code}\n" \
  -H "Accept: text/markdown" \
  -H "If-None-Match: $ETAG" \
  http://localhost:3000/docs/getting-started

echo ""
echo "=== dashboard /health ==="
curl -s http://localhost:3001/health

echo ""
echo "=== 404 ==="
curl -s -o /dev/null -w "status:%{http_code}\n" http://localhost:3000/does-not-exist

echo ""
echo "=== server log (last 10 lines) ==="
kill $SERVER_PID
wait $SERVER_PID 2>/dev/null
echo "done"
