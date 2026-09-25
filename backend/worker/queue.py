"""Job loop: claim one queued job with SKIP LOCKED, analyse it in a fresh scratch dir, store the result.

Runs as the `afterglow_worker` role: it can update job progress/outcome and insert results, nothing else.
One job at a time per process; scale by running more worker containers.
"""

from __future__ import annotations

import logging
import tempfile
import time
from pathlib import Path

import psycopg
from psycopg.rows import TupleRow

from core.repo import parse_repo
from core.schema import ANALYSER_VERSION, Result
from worker.analyse import analyse
from worker.git import AnalysisError, Caps, Git

log = logging.getLogger("afterglow.worker")
Conn = psycopg.Connection[TupleRow]
POLL_S = 1.0
PROGRESS_EVERY_S = 0.25
LOST_AFTER = "3 minutes"  # a running job not updated for this long lost its worker (analysis caps at 90 s)


def claim(conn: Conn) -> tuple[str, str] | None:
    with conn.transaction():
        conn.execute(
            "UPDATE jobs SET status = 'failed', stage = 'failed', reason = 'worker_lost', updated = now() "
            "WHERE status = 'running' AND updated < now() - %s::interval",
            (LOST_AFTER,),
        )
        row = conn.execute(
            "UPDATE jobs SET status = 'running', stage = 'cloning', updated = now() WHERE id = ("
            "  SELECT id FROM jobs WHERE status = 'queued' ORDER BY created FOR UPDATE SKIP LOCKED LIMIT 1"
            ") RETURNING id::text, repo"
        ).fetchone()
    return (row[0], row[1]) if row else None


def finish_done(conn: Conn, job: str, repo: str, sha: str, body: bytes | None) -> None:
    with conn.transaction():
        if body is not None:
            conn.execute(
                "INSERT INTO results (repo, sha, analyser, body) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT DO NOTHING",
                (repo, sha, ANALYSER_VERSION, body),
            )
        conn.execute(
            "UPDATE jobs SET status = 'done', stage = 'done', sha = %s, analyser = %s, updated = now() "
            "WHERE id = %s",
            (sha, ANALYSER_VERSION, job),
        )


def finish_failed(conn: Conn, job: str, reason: str) -> None:
    conn.execute(
        "UPDATE jobs SET status = 'failed', stage = 'failed', reason = %s, updated = now() WHERE id = %s",
        (reason, job),
    )


def cached_sha(conn: Conn, repo: str, sha: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM results WHERE repo = %s AND sha = %s AND analyser = %s", (repo, sha, ANALYSER_VERSION)
    ).fetchone()
    return row is not None


def run_job(
    conn: Conn, job: str, slug: str, caps: Caps, scratch_root: str | None, url: str | None = None
) -> None:
    last = 0.0

    def progress(stage: str, n: int, total: int) -> None:
        nonlocal last
        now = time.monotonic()
        if stage == "parsing" and n < total and now - last < PROGRESS_EVERY_S:
            return
        last = now
        conn.execute(
            "UPDATE jobs SET stage = %s, progress = %s, total = %s, updated = now() WHERE id = %s",
            (stage, n, total, job),
        )

    repo = parse_repo(slug)  # re-validated here too: the queue is a trust boundary
    try:
        with tempfile.TemporaryDirectory(dir=scratch_root) as tmp:
            if url is None:
                sha = Git(Path(tmp), caps, time.monotonic() + 20).remote_head(repo.clone_url)
                if sha and cached_sha(conn, slug, sha):
                    finish_done(conn, job, slug, sha, None)
                    log.info("job %s %s cached", job, slug)
                    return
            result: Result = analyse(repo, Path(tmp), caps, url=url, progress=progress)
    except AnalysisError as exc:
        finish_failed(conn, job, exc.reason)
        log.info("job %s %s failed %s", job, slug, exc.reason)
        return
    except Exception:
        finish_failed(conn, job, "internal")
        log.exception("job %s %s crashed", job, slug)
        return
    finish_done(conn, job, slug, result.meta.sha, result.model_dump_json().encode())
    log.info("job %s %s done", job, slug)


def serve(dsn: str, caps: Caps, scratch_root: str | None) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn:
        while True:
            claimed = claim(conn)
            if claimed is None:
                time.sleep(POLL_S)
                continue
            run_job(conn, claimed[0], claimed[1], caps, scratch_root)
