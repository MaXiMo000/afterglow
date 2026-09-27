-- Afterglow schema. Applied once by deploy/db/init.sh as the database owner.
-- Least privilege (SECURITY T4, T7): the API may create jobs and read results; the worker may claim and update
-- jobs and write results. Neither role can delete anything or touch the other's columns; only the retention role
-- (afterglow_maint) deletes, and it can do nothing else.

CREATE TABLE results (
  repo      text    NOT NULL CHECK (repo ~ '^[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$'),
  sha       text    NOT NULL CHECK (sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  analyser  integer NOT NULL CHECK (analyser > 0),
  body      bytea   NOT NULL CHECK (octet_length(body) <= 64 * 1024 * 1024),  -- schema-validated JSON
  created   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, sha, analyser)
);
CREATE INDEX results_recent ON results (repo, created DESC);

CREATE TABLE jobs (
  id        uuid PRIMARY KEY,                       -- 122 random bits from the API; never sequential
  repo      text NOT NULL CHECK (repo ~ '^[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$'),
  client    text NOT NULL CHECK (client ~ '^[0-9a-f]{32}$'),  -- HMAC of the client IP, never the IP
  status    text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  stage     text NOT NULL DEFAULT 'queued'
            CHECK (stage IN ('queued', 'cloning', 'counting', 'parsing', 'sizing', 'scoring', 'done', 'failed')),
  progress  integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  total     integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  reason    text CHECK (reason ~ '^[a-z_]{1,32}$'),
  sha       text,
  analyser  integer,
  created   timestamptz NOT NULL DEFAULT now(),
  updated   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (repo, sha, analyser) REFERENCES results (repo, sha, analyser),
  CHECK (status <> 'done' OR sha IS NOT NULL),
  CHECK (status <> 'failed' OR reason IS NOT NULL)
);
-- One active job per repository (SECURITY T11: dedupe).
CREATE UNIQUE INDEX jobs_one_active_per_repo ON jobs (repo) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_queue ON jobs (created) WHERE status = 'queued';
CREATE INDEX jobs_client_active ON jobs (client) WHERE status IN ('queued', 'running');

-- Privacy (SECURITY T6, frontend/privacy.html): the client pseudonym exists only for the per-client cap on active jobs.
-- Once a job is done or failed it is replaced with zeros, on every path (worker, reaper, cache-hit insert).
CREATE FUNCTION jobs_forget_client() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('done', 'failed') THEN
    NEW.client := repeat('0', 32);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_forget_client BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_forget_client();

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

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO afterglow_api, afterglow_worker;
GRANT SELECT, INSERT (id, repo, client, status, stage, sha, analyser) ON jobs TO afterglow_api;
GRANT SELECT (id, repo, status, stage, progress, total, reason, sha, analyser, client, created) ON jobs TO afterglow_api;
GRANT SELECT ON results TO afterglow_api;

GRANT SELECT ON jobs TO afterglow_worker;
GRANT UPDATE (status, stage, progress, total, reason, sha, analyser, updated) ON jobs TO afterglow_worker;
GRANT SELECT, INSERT ON results TO afterglow_worker;

-- Retention (backend/app/maint.py): the only role that can delete. It cannot insert or update anything.
GRANT USAGE ON SCHEMA public TO afterglow_maint;
GRANT SELECT (repo, sha, analyser, status, updated), DELETE ON jobs TO afterglow_maint;
GRANT SELECT (repo, sha, analyser, created), DELETE ON results TO afterglow_maint;

-- A stuck statement or an abandoned transaction must not hold connections or locks for long.
ALTER ROLE afterglow_api SET statement_timeout = '10s';
ALTER ROLE afterglow_api SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE afterglow_worker SET statement_timeout = '60s';
ALTER ROLE afterglow_worker SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE afterglow_maint SET statement_timeout = '5min';
ALTER ROLE afterglow_maint SET idle_in_transaction_session_timeout = '60s';
