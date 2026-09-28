-- Upgrade an existing database (created before the PR overlay) to the current schema.sql.
-- New databases get this from schema.sql; do not run it on them. Safe to run twice.
-- Apply it BEFORE starting the new containers: the new API enqueues with the widened dedupe index below.
-- Usage (repo root):
--   docker compose -f deploy/compose.yaml exec -T db psql -U postgres -d afterglow -v ON_ERROR_STOP=1 \
--     < deploy/db/upgrades/0004-pr-overlay.sql
BEGIN;
CREATE TABLE IF NOT EXISTS pr_results (
  repo      text    NOT NULL CHECK (repo ~ '^[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$'),
  pr        integer NOT NULL CHECK (pr BETWEEN 1 AND 10000000),
  merge     text    NOT NULL CHECK (merge ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  body      bytea   NOT NULL CHECK (octet_length(body) <= 8 * 1024 * 1024),
  created   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, pr, merge)
);
CREATE INDEX IF NOT EXISTS pr_results_recent ON pr_results (repo, pr, created DESC);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'analysis' CHECK (kind IN ('analysis', 'pr'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pr integer CHECK (pr BETWEEN 1 AND 10000000);
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_pr_kind;
ALTER TABLE jobs ADD CONSTRAINT jobs_pr_kind CHECK ((kind = 'pr') = (pr IS NOT NULL));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_pr_no_analyser;
ALTER TABLE jobs ADD CONSTRAINT jobs_pr_no_analyser CHECK (kind = 'analysis' OR analyser IS NULL);
DROP INDEX IF EXISTS jobs_one_active_per_repo;
CREATE UNIQUE INDEX jobs_one_active_per_repo ON jobs (repo, (coalesce(pr, 0))) WHERE status IN ('queued', 'running');
GRANT INSERT (kind, pr) ON jobs TO afterglow_api;
GRANT SELECT ON pr_results TO afterglow_api;
GRANT SELECT, INSERT ON pr_results TO afterglow_worker;
GRANT SELECT (created), DELETE ON pr_results TO afterglow_maint;
COMMIT;
