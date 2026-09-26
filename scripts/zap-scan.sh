#!/usr/bin/env bash
# SECURITY section 8: ZAP baseline (passive, spidered site) + API scan (active, from deploy/audit/zap/openapi.json)
# against the local stack. ZAP shares the Caddy container's network namespace, so it reaches https://localhost:8443
# with the only Host the stack accepts (T13). Fails on any alert of medium risk or higher.
# Regenerate the spec when the API changes: see deploy/audit/zap/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
ZAP=ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef # 2.17.0
CADDY="$(docker compose -f deploy/compose.yaml ps -q caddy)"
OUT=deploy/audit/zap/out
mkdir -p "$OUT"
cp deploy/audit/zap/openapi.json "$OUT/"
# The API's CSRF control requires X-Afterglow: 1 on POST (T10); send it so active rules reach the handlers.
HDR='-config replacer.full_list(0).description=afterglow -config replacer.full_list(0).enabled=true
 -config replacer.full_list(0).matchtype=REQ_HEADER -config replacer.full_list(0).matchstr=X-Afterglow
 -config replacer.full_list(0).regex=false -config replacer.full_list(0).replacement=1'
run() { MSYS_NO_PATHCONV=1 docker run --rm --network "container:$CADDY" -v "$PWD/$OUT:/zap/wrk:rw" "$ZAP" "$@" || true; }
run zap-baseline.py -t https://localhost:8443/ -j -m 2 -J baseline.json -r baseline.html -z "$HDR"
run zap-api-scan.py -t /zap/wrk/openapi.json -f openapi -J api.json -r api.html -z "$HDR"
python - "$OUT" <<'PY'
import json, sys
bad = 0
for name in ("baseline", "api"):
    with open(f"{sys.argv[1]}/{name}.json", encoding="utf-8") as f:
        alerts = [a for s in json.load(f)["site"] for a in s["alerts"]]
    for a in sorted(alerts, key=lambda a: -int(a["riskcode"])):
        risk = int(a["riskcode"])
        bad += risk >= 2
        print(f"{name:8} {['info','low','MEDIUM','HIGH'][risk]:6} {a['pluginid']:>6} {a['name']} ({a['count']})")
    if not alerts:
        print(f"{name:8} no alerts")
sys.exit(1 if bad else 0)
PY
