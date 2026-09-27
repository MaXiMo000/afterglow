-- Upgrade an existing database (created before the retention service) to the current schema.sql.
-- New databases get all of this from deploy/db/init.sh and schema.sql; do not run it on them.
-- Usage (repo root, after scripts/dev-env.sh has added AFTERGLOW_DB_MAINT_PASSWORD to deploy/.env):
--   set -a; . deploy/.env; set +a
--   docker compose -f deploy/compose.yaml exec -T db psql -U postgres -d afterglow -v ON_ERROR_STOP=1 \
--     -v maint_pw="$AFTERGLOW_DB_MAINT_PASSWORD" < deploy/db/upgrades/0002-retention.sql
\if :{?maint_pw}
\else
  \echo 'set -v maint_pw=... (AFTERGLOW_DB_MAINT_PASSWORD from deploy/.env)'
  \quit
\endif
BEGIN;
CREATE ROLE afterglow_maint LOGIN PASSWORD :'maint_pw' CONNECTION LIMIT 2;
GRANT USAGE ON SCHEMA public TO afterglow_maint;
GRANT SELECT (repo, sha, analyser, status, updated), DELETE ON jobs TO afterglow_maint;
GRANT SELECT (repo, sha, analyser, created), DELETE ON results TO afterglow_maint;
ALTER ROLE afterglow_api SET statement_timeout = '10s';
ALTER ROLE afterglow_api SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE afterglow_worker SET statement_timeout = '60s';
ALTER ROLE afterglow_worker SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE afterglow_maint SET statement_timeout = '5min';
ALTER ROLE afterglow_maint SET idle_in_transaction_session_timeout = '60s';
COMMIT;
