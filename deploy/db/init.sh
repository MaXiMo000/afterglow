#!/bin/sh
# Runs once on an empty data directory (docker-entrypoint-initdb.d). Creates the two login roles with passwords
# from the environment, then the schema. Fails closed if a password is missing or short (SECURITY T18).
set -eu
for v in AFTERGLOW_DB_API_PASSWORD AFTERGLOW_DB_WORKER_PASSWORD; do
  eval "val=\${$v:-}"
  if [ "${#val}" -lt 32 ]; then echo "init.sh: $v must be at least 32 characters" >&2; exit 1; fi
done
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v api_pw="$AFTERGLOW_DB_API_PASSWORD" -v worker_pw="$AFTERGLOW_DB_WORKER_PASSWORD" <<'SQL'
CREATE ROLE afterglow_api LOGIN PASSWORD :'api_pw' CONNECTION LIMIT 40;
CREATE ROLE afterglow_worker LOGIN PASSWORD :'worker_pw' CONNECTION LIMIT 20;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/schema.sql.in
