-- Upgrade an existing database (created before the retention service and progress notifications) to the
-- current schema.sql.
-- New databases get all of this from deploy/db/init.sh and schema.sql; do not run it on them.
-- Usage (repo root, after scripts/dev-env.sh has added AFTERGLOW_DB_MAINT_PASSWORD to deploy/.env):
--   set -a; . deploy/.env; set +a
--   docker compose -f deploy/compose.yaml exec -T db psql -U postgres -d afterglow -v ON_ERROR_STOP=1 \
--     -v maint_pw="$AFTERGLOW_DB_MAINT_PASSWORD" < deploy/db/upgrades/0002-retention.sql
-- Same rule as init.sh: the password must be passed and at least 32 characters (SECURITY T18). Otherwise nothing
-- changes and psql exits non-zero, so a scripted upgrade cannot look successful.
\if :{?maint_pw}
  SELECT length(:'maint_pw') >= 32 AS maint_pw_ok \gset
\else
  \set maint_pw_ok false
\endif
\if :maint_pw_ok
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
-- Progress notifications (backend/app/notify.py): open progress streams wait for these instead of polling.
-- The payload is the job id as 32 hex digits; '*' when a job enters or leaves the queue, which moves every
-- queued job's position. No data rides on the notification: streams re-read the row with their own grants.
CREATE FUNCTION jobs_notify_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM pg_notify('job_progress', '*');
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.status, NEW.stage, NEW.progress, NEW.total, NEW.reason)
      IS DISTINCT FROM (OLD.status, OLD.stage, OLD.progress, OLD.total, OLD.reason) THEN
    PERFORM pg_notify('job_progress', replace(NEW.id::text, '-', ''));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jobs_notify_progress AFTER INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_notify_progress();
COMMIT;
\else
  \echo 'Refusing to upgrade: pass -v maint_pw=... (AFTERGLOW_DB_MAINT_PASSWORD from deploy/.env, 32+ characters).'
  SELECT 'maint_pw missing or too short'::int;
\endif
