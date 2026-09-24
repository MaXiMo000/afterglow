#!/usr/bin/env bash
# Start the Postgres used by backend tests and print the env lines pytest needs.
# Usage: eval "$(scripts/test-db.sh)"   (creates deploy/.env with random secrets if missing)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e deploy/.env ] || scripts/dev-env.sh >&2
docker compose -f deploy/compose.yaml -f deploy/compose.test.yaml up -d --wait db >&2
set -a; . deploy/.env; set +a
base="127.0.0.1:55432/afterglow"
echo "export AFTERGLOW_TEST_ADMIN_URL='postgresql://postgres:${POSTGRES_PASSWORD}@${base}'"
echo "export AFTERGLOW_TEST_API_URL='postgresql://afterglow_api:${AFTERGLOW_DB_API_PASSWORD}@${base}'"
echo "export AFTERGLOW_TEST_WORKER_URL='postgresql://afterglow_worker:${AFTERGLOW_DB_WORKER_PASSWORD}@${base}'"
