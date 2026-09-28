"""Queries the API runs as the `afterglow_api` role (SELECT/INSERT on jobs, SELECT on results).

Every statement is parameterised; nothing from a request is ever interpolated into SQL (SECURITY T5).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from psycopg import AsyncConnection
from psycopg.rows import TupleRow

from core.schema import ANALYSER_VERSION

Conn = AsyncConnection[TupleRow]
FRESH_FOR = "1 hour"  # a result younger than this is served without re-analysing
PR_FRESH_FOR = "10 minutes"  # PRs move faster: a PR overlay is reused for this long
STALL_AFTER = "5 minutes"
RUN_SAMPLE = 20
LIVE_WITHIN = "90 seconds"  # worker.queue.LOST_AFTER: a running job silent for longer has no live worker


@dataclass(frozen=True, slots=True)
class Job:
    id: uuid.UUID
    repo: str
    status: str
    stage: str
    progress: int
    total: int
    reason: str | None
    sha: str | None
    kind: str = "analysis"
    pr: int | None = None


async def queue_depth(conn: Conn) -> int:
    cur = await conn.execute("SELECT count(*) FROM jobs WHERE status = 'queued'")
    row = await cur.fetchone()
    return int(row[0]) if row else 0


async def queue_stalled(conn: Conn) -> bool:
    """Queued work older than STALL_AFTER while no job is live: no worker is taking jobs.

    A job left `running` by a crashed worker is not live (its heartbeat stopped), so it cannot hide a dead
    worker.
    """
    cur = await conn.execute(
        "SELECT EXISTS (SELECT 1 FROM jobs WHERE status = 'queued' AND created < now() - %s::interval) "
        "AND NOT EXISTS (SELECT 1 FROM jobs WHERE status = 'running' AND updated > now() - %s::interval)",
        (STALL_AFTER, LIVE_WITHIN),
    )
    row = await cur.fetchone()
    return bool(row and row[0])


async def client_active(conn: Conn, client: str) -> int:
    cur = await conn.execute(
        "SELECT count(*) FROM jobs WHERE client = %s AND status IN ('queued', 'running')", (client,)
    )
    row = await cur.fetchone()
    return int(row[0]) if row else 0


async def fresh_result_sha(conn: Conn, repo: str) -> str | None:
    cur = await conn.execute(
        "SELECT sha FROM results WHERE repo = %s AND analyser = %s AND created > now() - %s::interval "
        "ORDER BY created DESC LIMIT 1",
        (repo, ANALYSER_VERSION, FRESH_FOR),
    )
    row = await cur.fetchone()
    return str(row[0]) if row else None


async def create_job(conn: Conn, repo: str, client: str) -> tuple[uuid.UUID, str]:
    """Return (job id, status). Reuses the active job for the repo if there is one (dedupe)."""
    sha = await fresh_result_sha(conn, repo)
    new_id = uuid.uuid4()
    if sha:
        await conn.execute(
            "INSERT INTO jobs (id, repo, client, status, stage, sha, analyser) "
            "VALUES (%s, %s, %s, 'done', 'done', %s, %s)",
            (new_id, repo, client, sha, ANALYSER_VERSION),
        )
        return new_id, "done"
    cur = await conn.execute(
        "INSERT INTO jobs (id, repo, client) VALUES (%s, %s, %s) "
        "ON CONFLICT (repo, (coalesce(pr, 0))) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id",
        (new_id, repo, client),
    )
    if await cur.fetchone():
        return new_id, "queued"
    cur = await conn.execute(
        "SELECT id, status FROM jobs WHERE repo = %s AND pr IS NULL AND status IN ('queued', 'running')",
        (repo,),
    )
    row = await cur.fetchone()
    if row is None:  # the active job finished between the two statements; its result is now fresh
        return await create_job(conn, repo, client)
    return row[0], str(row[1])


async def create_pr_job(conn: Conn, repo: str, pr: int, client: str) -> tuple[uuid.UUID, str]:
    """Like create_job, for a PR overlay (ROADMAP #7): reuse a fresh overlay, else dedupe per (repo, pr)."""
    cur = await conn.execute(
        "SELECT merge FROM pr_results WHERE repo = %s AND pr = %s AND created > now() - %s::interval "
        "ORDER BY created DESC LIMIT 1",
        (repo, pr, PR_FRESH_FOR),
    )
    row = await cur.fetchone()
    new_id = uuid.uuid4()
    if row:
        await conn.execute(
            "INSERT INTO jobs (id, repo, client, status, stage, sha, kind, pr) "
            "VALUES (%s, %s, %s, 'done', 'done', %s, 'pr', %s)",
            (new_id, repo, client, row[0], pr),
        )
        return new_id, "done"
    cur = await conn.execute(
        "INSERT INTO jobs (id, repo, client, kind, pr) VALUES (%s, %s, %s, 'pr', %s) "
        "ON CONFLICT (repo, (coalesce(pr, 0))) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id",
        (new_id, repo, client, pr),
    )
    if await cur.fetchone():
        return new_id, "queued"
    cur = await conn.execute(
        "SELECT id, status FROM jobs WHERE repo = %s AND pr = %s AND status IN ('queued', 'running')",
        (repo, pr),
    )
    row = await cur.fetchone()
    if row is None:  # finished between the two statements: its overlay is now fresh
        return await create_pr_job(conn, repo, pr, client)
    return row[0], str(row[1])


async def queue_ahead(conn: Conn, job_id: uuid.UUID) -> int | None:
    """Queued jobs the worker will claim before this one (it claims oldest first); None if not queued."""
    cur = await conn.execute(
        "SELECT (SELECT count(*) FROM jobs q WHERE q.status = 'queued' AND q.created < j.created) "
        "FROM jobs j WHERE j.id = %s AND j.status = 'queued'",
        (job_id,),
    )
    row = await cur.fetchone()
    return int(row[0]) if row else None


async def run_stats(conn: Conn) -> tuple[float, int] | None:
    """(median run time in seconds of the last RUN_SAMPLE jobs a worker finished today, live workers), or None
    when no job finished today. Feeds the queue wait estimate."""
    cur = await conn.execute(
        "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM updated - started)), "
        "  (SELECT count(*) FROM jobs WHERE status = 'running' AND updated > now() - %s::interval) "
        "FROM (SELECT started, updated FROM jobs WHERE status IN ('done', 'failed') AND started IS NOT NULL "
        "      AND kind = 'analysis' "
        "      AND updated > now() - interval '1 day' ORDER BY updated DESC LIMIT %s) recent",
        (LIVE_WITHIN, RUN_SAMPLE),
    )
    row = await cur.fetchone()
    return (float(row[0]), int(row[1])) if row and row[0] is not None else None


async def latest_result(conn: Conn, repo: str) -> str | None:
    """Sha of the newest stored result for `repo` from this analyser, any age (badges never start work)."""
    cur = await conn.execute(
        "SELECT sha FROM results WHERE repo = %s AND analyser = %s ORDER BY created DESC LIMIT 1",
        (repo, ANALYSER_VERSION),
    )
    row = await cur.fetchone()
    return str(row[0]) if row else None


async def get_job(conn: Conn, job_id: uuid.UUID) -> Job | None:
    cur = await conn.execute(
        "SELECT id, repo, status, stage, progress, total, reason, sha, kind, pr FROM jobs WHERE id = %s",
        (job_id,),
    )
    row = await cur.fetchone()
    return Job(*row) if row else None


async def previous_result(conn: Conn, repo: str, sha: str) -> bytes | None:
    """The newest stored result for `repo` from before the one at `sha` (same analyser), for "what changed
    since last time" (ROADMAP #8). None when there is none (first analysis, or retention removed it)."""
    cur = await conn.execute(
        "SELECT p.body FROM results c JOIN results p ON p.repo = c.repo AND p.analyser = c.analyser "
        "AND p.created < c.created AND p.sha <> c.sha "
        "WHERE c.repo = %s AND c.sha = %s AND c.analyser = %s ORDER BY p.created DESC LIMIT 1",
        (repo, sha, ANALYSER_VERSION),
    )
    row = await cur.fetchone()
    return bytes(row[0]) if row else None


async def get_pr_body(conn: Conn, repo: str, pr: int, merge: str) -> bytes | None:
    cur = await conn.execute(
        "SELECT body FROM pr_results WHERE repo = %s AND pr = %s AND merge = %s", (repo, pr, merge)
    )
    row = await cur.fetchone()
    return bytes(row[0]) if row else None


async def get_result_body(conn: Conn, repo: str, sha: str) -> bytes | None:
    cur = await conn.execute(
        "SELECT body FROM results WHERE repo = %s AND sha = %s AND analyser = %s",
        (repo, sha, ANALYSER_VERSION),
    )
    row = await cur.fetchone()
    return bytes(row[0]) if row else None
