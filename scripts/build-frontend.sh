#!/usr/bin/env bash
# Build frontend/dist inside a pinned Node container, so a server needs only git and Docker (docs/DEPLOY.md).
# Same steps as CI: lockfile install without install scripts, typecheck, build, bundle policy check.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE=node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 # node:24-alpine, 24.21.0
MSYS_NO_PATHCONV=1 docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm -e npm_config_update_notifier=false \
  -v "$PWD/frontend:/app" -w /app "$NODE" sh -c 'npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm run build'
