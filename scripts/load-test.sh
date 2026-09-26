#!/usr/bin/env bash
# SECURITY section 8 k6 checks against the local stack (T11): per-client rate limit, per-client SSE cap, global queue
# backpressure (503 + Retry-After) and API memory under sustained load. Stops the worker so jobs stay queued, and
# clears the jobs table before and after. Local stack only: never point this at a shared deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
K6=grafana/k6@sha256:9bd01d6941fca969cb61bb57d2da5ee9b385fe2aa8881df3798c196564d6ace6 # v2.2.0
DC="docker compose -f deploy/compose.yaml -f deploy/compose.test.yaml"
CADDY_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "afterglow_edge"}}{{.IPAddress}}{{end}}' "$($DC ps -q caddy)")"
API="$($DC ps -q api)"
sql() { $DC exec -T db psql -qAt -U postgres -d afterglow -c "$1"; }
fresh() { sql "TRUNCATE jobs, results" >/dev/null; $DC restart api >/dev/null 2>&1; $DC up -d --wait api >/dev/null 2>&1; }
k6() { MSYS_NO_PATHCONV=1 docker run --rm --network afterglow_edge -e CADDY="$CADDY_IP" -v "$PWD/deploy/audit/k6:/s:ro" "$@"; }
mem() { docker stats --no-stream --format '{{.MemUsage}}' "$API" | cut -d/ -f1; }
fail=0
$DC stop worker >/dev/null 2>&1 || true

echo "== rate limit: 15 POSTs from one client"
fresh
k6 -e MODE=rate "$K6" run -q /s/limits.js 2>&1 | grep -E "rate [0-9,]+|✓|✗" | sed 's/^.*msg="\{0,1\}//; s/"\{0,1\} source=console//'
k6 -e MODE=rate "$K6" run -q /s/limits.js >/dev/null 2>&1 && echo "   (second run from a fresh IP also passes)"

echo "== SSE cap: 6 concurrent streams from one client on one job"
fresh
JOB="$(curl -sk -X POST https://localhost:8443/api/v1/analyses -H 'Content-Type: application/json' -H 'X-Afterglow: 1' \
  -H 'Origin: https://localhost:8443' -d '{"repo":"loadtest/sse"}' | python -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
out="$(k6 -e MODE=sse -e JOB="$JOB" "$K6" run -q /s/limits.js 2>&1 | grep -o 'status=[0-9]*' | sort | uniq -c)"
echo "$out"
refused="$(echo "$out" | awk '/status=429/{print $1}')"
[ "${refused:-0}" = 2 ] && echo "   ok: 4 streams held open, 2 refused with 429" || { echo "   FAIL: expected exactly 2 refused"; fail=1; }

echo "== queue backpressure: 30 clients x 3 POSTs (2 active per client, 50 queued overall)"
fresh
# Fixed, distinct IPs: Docker would otherwise hand a finished client's IP to the next one (same client to the API).
NET="$(docker network inspect afterglow_edge -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' | cut -d. -f1-2)"
for i in $(seq 1 30); do k6 --ip "$NET.250.$i" -e MODE=jobs -e CLIENT="$i" "$K6" run -q /s/limits.js 2>&1 | grep -o 'jobs client=.*' | tr -d '"' & done > "${TMPDIR:-/tmp}/k6-jobs.txt"
wait
awk '{print $3}' "${TMPDIR:-/tmp}/k6-jobs.txt" | tr ',' '\n' | sort | uniq -c
queued="$(sql "SELECT count(*) FROM jobs WHERE status = 'queued'")"
echo "   jobs queued in the database: $queued"
[ "$queued" = 50 ] && grep -q 503 "${TMPDIR:-/tmp}/k6-jobs.txt" && echo "   ok: queue stopped at 50, later clients got 503" || { echo "   FAIL: queue cap not held"; fail=1; }

echo "== memory: 40 req/s mixed traffic for ${DURATION:-3m}"
fresh
before="$(mem)"
k6 -e MODE=soak -e DURATION="${DURATION:-3m}" "$K6" run -q /s/limits.js 2>&1 | grep -E "✓|✗|status\.+|http_req_duration" | head -6
sleep 20
after="$(mem)"
echo "   API memory: before $before, after (+20 s idle) $after"

sql "TRUNCATE jobs, results" >/dev/null
$DC start worker >/dev/null 2>&1 || true
exit $fail
