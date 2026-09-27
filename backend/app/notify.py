"""Progress notifications: Postgres NOTIFY -> waiting SSE streams (H2 in the audit).

A trigger on `jobs` sends `NOTIFY job_progress, '<job id hex>'` when a job's status, stage or progress
changes, and '*' when a job enters or leaves the queue. One LISTEN connection per API process wakes the
streams following that job, so an open stream queries the database when something changed instead of three
times a second. Streams still poll slowly, so a lost listener only makes progress arrive later.
"""

from __future__ import annotations

import asyncio
import logging

import psycopg

log = logging.getLogger("afterglow.notify")
CHANNEL = "job_progress"
ALL = "*"  # a job entered or left the queue: every queued position may have moved
RECONNECT_S = 2.0


class Hub:
    """Job id -> events of the streams waiting on it. Used from the event loop only."""

    def __init__(self) -> None:
        self._waiting: dict[str, set[asyncio.Event]] = {}

    def subscribe(self, job: str) -> asyncio.Event:
        ev = asyncio.Event()
        self._waiting.setdefault(job, set()).add(ev)
        return ev

    def unsubscribe(self, job: str, ev: asyncio.Event) -> None:
        waiting = self._waiting.get(job)
        if waiting is not None:
            waiting.discard(ev)
            if not waiting:
                del self._waiting[job]

    def notify(self, job: str) -> None:
        if job == ALL:
            self.notify_all()
            return
        for ev in self._waiting.get(job, ()):
            ev.set()

    def notify_all(self) -> None:
        """Wake every stream, e.g. after reconnecting, when notifications may have been missed."""
        for waiting in self._waiting.values():
            for ev in waiting:
                ev.set()


async def listen(dsn: str, hub: Hub) -> None:
    """Forward notifications to the hub until cancelled; reconnect after errors."""
    while True:
        try:
            async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
                await conn.execute(f"LISTEN {CHANNEL}")
                hub.notify_all()
                async for note in conn.notifies():
                    hub.notify(note.payload)
        except psycopg.Error as exc:
            log.warning("progress listener: %s", type(exc).__name__)
        await asyncio.sleep(RECONNECT_S)
