#!/usr/bin/env bash
# Create deploy/.env with fresh random secrets for the local stack (gitignored). Never commit the output.
# Usage: scripts/dev-env.sh   (never changes an existing secret; on an existing file it only adds missing ones,
# e.g. AFTERGLOW_DB_MAINT_PASSWORD after an upgrade. To rotate secrets, delete the file first.)
set -euo pipefail
cd "$(dirname "$0")/.."
out=deploy/.env
rand() { openssl rand -hex 32; }
umask 077
added=0
if [ -s "$out" ] && [ -n "$(tail -c 1 "$out")" ]; then echo >> "$out"; fi  # hand-edited file without a final newline
for key in POSTGRES_PASSWORD AFTERGLOW_DB_API_PASSWORD AFTERGLOW_DB_WORKER_PASSWORD AFTERGLOW_DB_MAINT_PASSWORD \
  AFTERGLOW_IP_KEY; do
  if [ ! -e "$out" ] || ! grep -q "^$key=" "$out"; then
    echo "$key=$(rand)" >> "$out"
    added=$((added + 1))
  fi
done
echo "$out: added $added secret(s)"
