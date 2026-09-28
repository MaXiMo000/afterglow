"""Public API v1 (docs/PLAN.md section 4). Every response body is either a fixed shape or a stored,
schema-validated result; request data is never echoed back (SECURITY T14).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from psycopg_pool import AsyncConnectionPool
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app import badge, db
from app.limits import Gate, RateLimiter, client_id
from app.notify import ALL, Hub
from app.settings import Settings
from core.repo import InvalidRepoError, parse_repo
from core.schema import ANALYSER_VERSION, PrResult, Result

MAX_BODY = 1024
MAX_QUEUE = 50  # queued jobs overall before new work is refused with 503
MAX_ACTIVE_PER_CLIENT = 2
SSE_POLL_S = 2.0  # fallback only: NOTIFY wakes a stream as soon as its job changes (app/notify.py)
SSE_HEARTBEAT_S = 15.0
SSE_MAX_S = 300.0
RUN_STATS_S = 30.0  # the queue wait estimate's inputs are re-read at most this often per process
BADGE_CACHE = 256  # rendered badges kept per process (a few KB each)
BADGE_MAX_AGE = 3600


def _err(code: str, status: int, retry_after: float | None = None) -> JSONResponse:
    headers = {"Retry-After": str(max(1, round(retry_after)))} if retry_after is not None else None
    return JSONResponse({"error": code}, status_code=status, headers=headers)


class ValidatedBodies:
    """Re-validate a stored result before serving it (SECURITY T12).

    Remembers the SHA-256 of bodies that passed, not the bodies (a 50k-file result is ~10 MB), so a changed
    body is always validated again. Run it in a worker thread: validating a result at the file cap takes
    ~0.2 s, which would stall every other request and progress stream on the event loop.
    """

    def __init__(self, max_entries: int = 512, model: type[Result] | type[PrResult] = Result) -> None:
        self.max_entries = max_entries
        self.model = model
        self._seen: OrderedDict[bytes, None] = OrderedDict()
        self._lock = threading.Lock()

    def check(self, body: bytes) -> None:
        digest = hashlib.sha256(body).digest()
        with self._lock:
            if digest in self._seen:
                self._seen.move_to_end(digest)
                return
        self.model.model_validate_json(body)  # raises ValidationError
        with self._lock:
            self._seen[digest] = None
            if len(self._seen) > self.max_entries:
                self._seen.popitem(last=False)


def build_router(settings: Settings, pool: AsyncConnectionPool | None, hub: Hub | None = None) -> APIRouter:
    hub = hub or Hub()
    router = APIRouter(prefix="/api/v1")
    post_limit = RateLimiter(rate=10, per=60)  # per client
    post_global = RateLimiter(rate=300, per=60)
    read_limit = RateLimiter(rate=240, per=60)
    streams = Gate(per_key=4, total=200, max_age=SSE_MAX_S + 30)
    validated = ValidatedBodies()
    validated_prs = ValidatedBodies(128, PrResult)
    badge_renders = RateLimiter(rate=60, per=60)  # cache misses parse a whole result: bounded globally
    badges: OrderedDict[tuple[str, str], bytes] = OrderedDict()
    run_stats: list[tuple[float, tuple[float, int] | None]] = []  # (read at, db.run_stats())

    async def wait_estimate(conn: db.Conn, ahead: int) -> int | None:
        """Seconds until a job with `ahead` queued jobs before it starts: each worker takes one job per median
        run time of recent jobs. An estimate, and labelled one in the UI (CLAUDE.md rule 6)."""
        if not run_stats or time.monotonic() - run_stats[0][0] > RUN_STATS_S:
            run_stats[:] = [(time.monotonic(), await db.run_stats(conn))]
        stats = run_stats[0][1]
        if stats is None:
            return None
        median, workers = stats
        return round((ahead // max(workers, 1) + 1) * median)

    def client_of(request: Request) -> str:
        # Caddy overwrites X-Real-IP with the TCP peer; the API is reachable only via Caddy (internal net).
        ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")
        return client_id(settings.ip_key or b"dev-only-key", ip)

    def origin_ok(request: Request) -> bool:
        origin = request.headers.get("origin")
        return origin is None or origin == settings.public_origin

    async def read_json(request: Request) -> tuple[str, dict[str, object]] | JSONResponse:
        """Request checks shared by every POST: CSRF controls, size, rate limits, a JSON object body."""
        # SECURITY T10: JSON only; custom header required (cross-origin needs CORS, which we never grant);
        # Origin checked when present.
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            return _err("unsupported_media_type", 415)
        if request.headers.get("x-afterglow") != "1" or not origin_ok(request):
            return _err("forbidden", 403)
        declared = request.headers.get("content-length")
        if declared is None or not declared.isdigit() or int(declared) > MAX_BODY:
            return _err("too_large", 413)
        client = client_of(request)
        if (wait := post_limit.check(client)) or (wait := post_global.check("*")):
            return _err("rate_limited", 429, wait)
        raw = await request.body()
        if len(raw) > MAX_BODY:
            return _err("too_large", 413)
        try:
            payload = json.loads(raw)
        except ValueError:
            return _err("invalid_repo", 400)
        if not isinstance(payload, dict):
            return _err("invalid_repo", 400)
        return client, payload

    async def enqueue(
        client: str, create: Callable[[db.Conn], Awaitable[tuple[uuid.UUID, str]]]
    ) -> JSONResponse:
        if pool is None:
            return _err("unavailable", 503, 30)
        async with pool.connection() as conn:
            if await db.client_active(conn, client) >= MAX_ACTIVE_PER_CLIENT:
                return _err("too_many_jobs", 429, 30)
            if await db.queue_depth(conn) >= MAX_QUEUE:
                return _err("busy", 503, 30)
            job_id, status = await create(conn)
        return JSONResponse(
            {"id": job_id.hex, "status": status}, status_code=200 if status == "done" else 202
        )

    def repo_of(payload: dict[str, object], keys: set[str]) -> str | None:
        if set(payload) != keys or not isinstance(payload.get("repo"), str):
            return None
        try:
            return parse_repo(str(payload["repo"])).slug
        except InvalidRepoError:
            return None

    @router.post("/analyses")
    async def create(request: Request) -> Response:
        got = await read_json(request)
        if isinstance(got, JSONResponse):
            return got
        client, payload = got
        if (slug := repo_of(payload, {"repo"})) is None:
            return _err("invalid_repo", 400)
        return await enqueue(client, lambda conn: db.create_job(conn, slug, client))

    @router.post("/prs")
    async def create_pr(request: Request) -> Response:
        """PR overlay (docs/ROADMAP.md #7): the files an open PR changes. Same limits as an analysis."""
        got = await read_json(request)
        if isinstance(got, JSONResponse):
            return got
        client, payload = got
        if (slug := repo_of(payload, {"repo", "pr"})) is None:
            return _err("invalid_repo", 400)
        pr = payload["pr"]
        if not isinstance(pr, int) or isinstance(pr, bool) or not 1 <= pr <= 10_000_000:
            return _err("invalid_pr", 400)
        return await enqueue(client, lambda conn: db.create_pr_job(conn, slug, pr, client))

    async def load_job(request: Request, job_id: str) -> db.Job | JSONResponse:
        if wait := read_limit.check(client_of(request)):
            return _err("rate_limited", 429, wait)
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            return _err("not_found", 404)
        if pool is None:
            return _err("unavailable", 503, 30)
        jid = uuid.UUID(hex=job_id)
        async with pool.connection() as conn:
            job = await db.get_job(conn, jid)
        return job if job else _err("not_found", 404)

    @router.get("/analyses/{job_id}")
    async def result(request: Request, job_id: str) -> Response:
        job = await load_job(request, job_id)
        if isinstance(job, JSONResponse):
            return job
        if job.kind != "analysis":
            return _err("not_found", 404)
        if job.status == "failed":
            return _err(job.reason or "failed", 422)
        if job.status != "done" or job.sha is None:
            return _err("not_ready", 409)
        etag = f'"{job.sha}-{ANALYSER_VERSION}"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})
        assert pool is not None  # noqa: S101 - load_job returned a job, so the pool exists  # nosec B101
        async with pool.connection() as conn:
            body = await db.get_result_body(conn, job.repo, job.sha)
        if body is None:
            return _err("not_found", 404)
        try:
            await run_in_threadpool(validated.check, body)
        except ValidationError:
            return _err("internal", 500)
        return Response(
            body,
            media_type="application/json",
            headers={"ETag": etag, "Cache-Control": "public, max-age=31536000, immutable"},
        )

    @router.get("/analyses/{job_id}/previous")
    async def previous(request: Request, job_id: str) -> Response:
        """The analysis of this repository before this one (ROADMAP #8), re-validated like any result."""
        job = await load_job(request, job_id)
        if isinstance(job, JSONResponse):
            return job
        if job.kind != "analysis" or job.status != "done" or job.sha is None:
            return _err("not_found", 404)
        assert pool is not None  # noqa: S101 - load_job returned a job, so the pool exists  # nosec B101
        async with pool.connection() as conn:
            body = await db.previous_result(conn, job.repo, job.sha)
        if body is None:
            return _err("not_found", 404)
        try:
            await run_in_threadpool(validated.check, body)
        except ValidationError:
            return _err("internal", 500)
        return Response(
            body, media_type="application/json", headers={"Cache-Control": "private, max-age=300"}
        )

    @router.get("/prs/{job_id}")
    async def pr_result(request: Request, job_id: str) -> Response:
        job = await load_job(request, job_id)
        if isinstance(job, JSONResponse):
            return job
        if job.kind != "pr" or job.pr is None:
            return _err("not_found", 404)
        if job.status == "failed":
            return _err(job.reason or "failed", 422)
        if job.status != "done" or job.sha is None:
            return _err("not_ready", 409)
        assert pool is not None  # noqa: S101 - load_job returned a job, so the pool exists  # nosec B101
        async with pool.connection() as conn:
            body = await db.get_pr_body(conn, job.repo, job.pr, job.sha)
        if body is None:
            return _err("not_found", 404)
        try:
            await run_in_threadpool(validated_prs.check, body)
        except ValidationError:
            return _err("internal", 500)
        # Immutable per job: the job id names one test merge. No ETag needed (the body is small).
        return Response(
            body, media_type="application/json", headers={"Cache-Control": "private, max-age=3600"}
        )

    @router.get("/analyses/{job_id}/events")
    async def events(request: Request, job_id: str) -> Response:
        job = await load_job(request, job_id)
        if isinstance(job, JSONResponse):
            return job
        client = client_of(request)
        if not streams.enter(client):
            return _err("too_many_streams", 429, 10)
        assert pool is not None  # noqa: S101  # nosec B101

        async def stream() -> AsyncIterator[bytes]:
            woken = hub.subscribe(job.id.hex)
            try:
                last: tuple[object, ...] | None = None
                started = beat = time.monotonic()
                current: db.Job | None = job
                while current is not None and time.monotonic() - started < SSE_MAX_S:
                    ahead = wait = None
                    if current.status == "queued":
                        hub.subscribe(ALL, woken)  # queue movements change this job's position
                        async with pool.connection() as conn:
                            ahead = await db.queue_ahead(conn, current.id)
                            if ahead is not None:
                                wait = await wait_estimate(conn, ahead)
                    else:
                        hub.unsubscribe(ALL, woken)
                    state = (
                        current.status,
                        current.stage,
                        current.progress,
                        current.total,
                        current.reason,
                        ahead,
                        wait,
                    )
                    if state != last:
                        last = state
                        data: dict[str, object] = {"status": current.status, "stage": current.stage,
                                                   "n": current.progress, "total": current.total}  # fmt: skip
                        if current.reason:
                            data["reason"] = current.reason
                        if ahead is not None:
                            data["ahead"] = ahead
                        if wait is not None:
                            data["wait"] = wait
                        yield f"event: progress\ndata: {json.dumps(data)}\n\n".encode()
                        beat = time.monotonic()
                    if current.status in ("done", "failed"):
                        return
                    if time.monotonic() - beat > SSE_HEARTBEAT_S:
                        yield b": keep-alive\n\n"
                        beat = time.monotonic()
                    if await request.is_disconnected():
                        return
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(woken.wait(), SSE_POLL_S)
                    woken.clear()
                    async with pool.connection() as conn:
                        current = await db.get_job(conn, current.id)
            finally:
                hub.unsubscribe(job.id.hex, woken)
                hub.unsubscribe(ALL, woken)
                streams.leave(client)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @router.get("/results/{owner}/{name}")
    async def latest(request: Request, owner: str, name: str) -> Response:
        """Newest stored result of a repository, for the embeddable city (ROADMAP #12). Never starts work."""
        if wait := read_limit.check(client_of(request)):
            return _err("rate_limited", 429, wait)
        try:
            slug = parse_repo(f"{owner}/{name}").slug
        except InvalidRepoError:
            return _err("not_found", 404)
        if pool is None:
            return _err("unavailable", 503, 30)
        async with pool.connection() as conn:
            sha = await db.latest_result(conn, slug)
            if sha is None:
                return _err("not_found", 404)
            etag = f'"{sha}-{ANALYSER_VERSION}"'
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers={"ETag": etag})
            body = await db.get_result_body(conn, slug, sha)
        if body is None:
            return _err("not_found", 404)
        try:
            await run_in_threadpool(validated.check, body)
        except ValidationError:
            return _err("internal", 500)
        # Short cache: a newer analysis should reach embeds within the hour. ETag makes revalidation cheap.
        headers = {"ETag": etag, "Cache-Control": "public, max-age=600"}
        return Response(body, media_type="application/json", headers=headers)

    @router.get("/featured")
    async def featured(request: Request) -> Response:
        """Start-page gallery (ROADMAP #10): the configured repositories, in order (tiles use the badges)."""
        if wait := read_limit.check(client_of(request)):
            return _err("rate_limited", 429, wait)
        return JSONResponse(
            {"repos": list(settings.featured)}, headers={"Cache-Control": "public, max-age=300"}
        )

    @router.get("/badges/{owner}/{file}")
    async def badge_svg(request: Request, owner: str, file: str) -> Response:
        """SVG skyline for READMEs, from the newest stored result. Never starts an analysis."""
        if wait := read_limit.check(client_of(request)):
            return _err("rate_limited", 429, wait)
        try:
            if not file.endswith(".svg"):
                raise InvalidRepoError
            slug = parse_repo(f"{owner}/{file.removesuffix('.svg')}").slug
        except InvalidRepoError:
            return _err("not_found", 404)
        if pool is None:
            return _err("unavailable", 503, 30)
        async with pool.connection() as conn:
            sha = await db.latest_result(conn, slug)
            key = (slug, sha or "")
            svg = badges.get(key)
            body = None
            if svg is None and sha is not None:
                if wait := badge_renders.check("*"):
                    return _err("rate_limited", 429, wait)
                body = await db.get_result_body(conn, slug, sha)
        if svg is None:
            if sha is None or body is None:
                svg = badge.placeholder(slug)
            else:
                try:
                    svg = badge.render(await run_in_threadpool(Result.model_validate_json, body))
                except ValidationError:
                    return _err("internal", 500)
            badges[key] = svg
            if len(badges) > BADGE_CACHE:
                badges.popitem(last=False)
        badges.move_to_end(key)
        # Short cache for the placeholder, so a first analysis shows up soon.
        age = BADGE_MAX_AGE if sha else 300
        return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": f"public, max-age={age}"})

    return router
