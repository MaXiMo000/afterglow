-- Upgrade an existing database (created before the queue wait estimate) to the current schema.sql.
-- New databases get this from schema.sql; do not run it on them. Safe to run twice.
-- Usage (repo root):
--   docker compose -f deploy/compose.yaml exec -T db psql -U postgres -d afterglow -v ON_ERROR_STOP=1 \
--     < deploy/db/upgrades/0003-queue-wait.sql
BEGIN;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started timestamptz;
GRANT UPDATE (started) ON jobs TO afterglow_worker;
COMMIT;
