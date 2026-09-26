-- Afterglow schema. Applied once by deploy/db/init.sh as the database owner.
-- Least privilege (SECURITY T4, T7): the API may create jobs and read results; the worker may claim and update
-- jobs and write results. Neither role can delete anything or touch the other's columns.

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

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO afterglow_api, afterglow_worker;
GRANT SELECT, INSERT (id, repo, client, status, stage, sha, analyser) ON jobs TO afterglow_api;
GRANT SELECT (id, repo, status, stage, progress, total, reason, sha, analyser, client, created) ON jobs TO afterglow_api;
GRANT SELECT ON results TO afterglow_api;

GRANT SELECT ON jobs TO afterglow_worker;
GRANT UPDATE (status, stage, progress, total, reason, sha, analyser, updated) ON jobs TO afterglow_worker;
GRANT SELECT, INSERT ON results TO afterglow_worker;
