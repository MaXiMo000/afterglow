#!/usr/bin/env bash
# Create deploy/.env with fresh random secrets for the local stack (gitignored). Never commit the output.
# Usage: scripts/dev-env.sh   (refuses to overwrite an existing file)
set -euo pipefail
cd "$(dirname "$0")/.."
out=deploy/.env
[ -e "$out" ] && { echo "$out exists; delete it first to rotate secrets" >&2; exit 1; }
rand() { openssl rand -hex 32; }
umask 077
cat > "$out" <<EOF
POSTGRES_PASSWORD=$(rand)
AFTERGLOW_DB_API_PASSWORD=$(rand)
AFTERGLOW_DB_WORKER_PASSWORD=$(rand)
AFTERGLOW_IP_KEY=$(rand)
EOF
echo "wrote $out"
