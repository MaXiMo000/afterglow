"""Retention (frontend/privacy.html, SECURITY section 5): delete finished jobs and results nobody uses.

Runs in its own container as `afterglow_maint`, the only role that can delete (it cannot insert or update):
`python -m app.maint`. The API and the worker keep their no-delete grants.
"""

from __future__ import annotations

import logging
import os
import sys
import time

import psycopg
from psycopg.rows import TupleRow

from core.schema import ANALYSER_VERSION

log = logging.getLogger("afterglow.maint")
Conn = psycopg.Connection[TupleRow]
JOBS_KEEP = "7 days"  # finished job records
RESULTS_KEEP = "30 days"  # a result older than this goes once no job record points at it
EVERY_S = 3600.0
RETRY_S = 60.0


def prune(conn: Conn) -> tuple[int, int]:
    """Delete finished jobs past JOBS_KEEP, then old (or older-analyser) results that nothing references.

    A result stays while any job record points at it, so asking for the same commit again keeps it for another
    JOBS_KEEP. Returns (jobs deleted, results deleted).
    """
    with conn.transaction():
        jobs = conn.execute(
            "DELETE FROM jobs WHERE status IN ('done', 'failed') AND updated < now() - %s::interval",
            (JOBS_KEEP,),
        ).rowcount
        results = conn.execute(
            "DELETE FROM results r WHERE (r.analyser <> %s OR r.created < now() - %s::interval) "
            "AND NOT EXISTS (SELECT 1 FROM jobs j "
            "                WHERE j.repo = r.repo AND j.sha = r.sha AND j.analyser = r.analyser)",
            (ANALYSER_VERSION, RESULTS_KEEP),
        ).rowcount
    return jobs, results


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    dsn = os.environ.get("AFTERGLOW_MAINT_DATABASE_URL", "")
    if not dsn.startswith("postgresql://"):
        print("error AFTERGLOW_MAINT_DATABASE_URL must be a postgresql:// URL", file=sys.stderr)
        return 2
    while True:
        try:
            with psycopg.connect(dsn, autocommit=True) as conn:
                jobs, results = prune(conn)
            log.info("pruned jobs=%d results=%d", jobs, results)
            time.sleep(EVERY_S)
        except psycopg.Error as exc:
            log.warning("prune failed: %s", type(exc).__name__)
            time.sleep(RETRY_S)


if __name__ == "__main__":
    raise SystemExit(main())
