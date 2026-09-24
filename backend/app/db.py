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


async def queue_depth(conn: Conn) -> int:
    cur = await conn.execute("SELECT count(*) FROM jobs WHERE status = 'queued'")
    row = await cur.fetchone()
    return int(row[0]) if row else 0


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
        "ON CONFLICT (repo) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id",
        (new_id, repo, client),
    )
    if await cur.fetchone():
        return new_id, "queued"
    cur = await conn.execute(
        "SELECT id, status FROM jobs WHERE repo = %s AND status IN ('queued', 'running')", (repo,)
    )
    row = await cur.fetchone()
    if row is None:  # the active job finished between the two statements; its result is now fresh
        return await create_job(conn, repo, client)
    return row[0], str(row[1])


async def get_job(conn: Conn, job_id: uuid.UUID) -> Job | None:
    cur = await conn.execute(
        "SELECT id, repo, status, stage, progress, total, reason, sha FROM jobs WHERE id = %s", (job_id,)
    )
    row = await cur.fetchone()
    return Job(*row) if row else None


async def get_result_body(conn: Conn, repo: str, sha: str) -> bytes | None:
    cur = await conn.execute(
        "SELECT body FROM results WHERE repo = %s AND sha = %s AND analyser = %s",
        (repo, sha, ANALYSER_VERSION),
    )
    row = await cur.fetchone()
    return bytes(row[0]) if row else None
