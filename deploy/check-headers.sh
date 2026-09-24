#!/usr/bin/env bash
# SECURITY T8/T9/T14: assert the exact response header set served by Caddy. Fails on any missing or changed header.
# Usage: deploy/check-headers.sh [base-url]   (default https://localhost:8443)
set -euo pipefail
BASE="${1:-https://localhost:8443}"
fail=0

CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types 'none'"

declare -A WANT=(
  [content-security-policy]="$CSP"
  [x-content-type-options]="nosniff"
  [referrer-policy]="no-referrer"
  [cross-origin-opener-policy]="same-origin"
  [cross-origin-resource-policy]="same-origin"
  [cross-origin-embedder-policy]="require-corp"
  [x-frame-options]="DENY"
  [strict-transport-security]="max-age=31536000; includeSubDomains"
)

check() {
  local path="$1" headers
  # -k: local Caddy uses its internal CA. Header names are lower-cased for comparison.
  headers="$(curl -sSk -D - -o /dev/null "$BASE$path" | tr -d '\r' | awk -F': ' 'NF>1 {print tolower($1) ": " substr($0, index($0, ": ") + 2)}')"
  for name in "${!WANT[@]}"; do
    got="$(printf '%s\n' "$headers" | grep -i "^$name: " | head -1 | cut -d' ' -f2- || true)"
    if [ "$got" != "${WANT[$name]}" ]; then
      echo "FAIL $path $name: got '${got}'"; fail=1
    fi
  done
  if ! printf '%s\n' "$headers" | grep -qi '^permissions-policy: .*camera=()'; then
    echo "FAIL $path permissions-policy missing or incomplete"; fail=1
  fi
  for banned in server x-powered-by via; do
    if printf '%s\n' "$headers" | grep -qi "^$banned: "; then
      echo "FAIL $path must not send $banned header"; fail=1
    fi
  done
}

check /
check /healthz
check /does-not-exist

# API errors are generic JSON, never stack traces or echoed input (T14).
body="$(curl -sSk "$BASE/api/v1/%3Cscript%3E")"
if [ "$body" != '{"error":"not_found"}' ]; then echo "FAIL api 404 body: $body"; fail=1; fi

# Oversized request bodies are refused at the edge.
code="$(head -c 40000 /dev/zero | tr '\0' 'a' | curl -sSk -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' --data-binary @- "$BASE/api/v1/analyses" || true)"
if [ "$code" != "413" ]; then echo "FAIL oversized body returned $code, want 413"; fail=1; fi

# Same for a chunked body with no Content-Length on a route that proxies (the body is read, so max_size trips).
code="$(head -c 40000 /dev/zero | tr '\0' 'a' | curl -sSk -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'Transfer-Encoding: chunked' --data-binary @- "$BASE/healthz" || true)"
case "$code" in 413|405) ;; *) echo "FAIL chunked oversized body returned $code, want 413 or 405"; fail=1 ;; esac

[ "$fail" -eq 0 ] && echo "ok   all security headers present on $BASE"
exit "$fail"
