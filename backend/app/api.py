"""Public API v1 (docs/PLAN.md section 4). Every response body is either a fixed shape or a stored,
schema-validated result; request data is never echoed back (SECURITY T14).
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator
from functools import lru_cache

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from psycopg_pool import AsyncConnectionPool
from pydantic import ValidationError

from app import db
from app.limits import Gate, RateLimiter, client_id
from app.settings import Settings
from core.repo import InvalidRepoError, parse_repo
from core.schema import ANALYSER_VERSION, Result

MAX_BODY = 1024
MAX_QUEUE = 50  # queued jobs overall before new work is refused with 503
MAX_ACTIVE_PER_CLIENT = 2
SSE_POLL_S = 0.3
SSE_HEARTBEAT_S = 15.0
SSE_MAX_S = 300.0


def _err(code: str, status: int, retry_after: float | None = None) -> JSONResponse:
    headers = {"Retry-After": str(max(1, round(retry_after)))} if retry_after is not None else None
    return JSONResponse({"error": code}, status_code=status, headers=headers)


@lru_cache(maxsize=16)
def _validated(body: bytes) -> bytes:
    """Re-validate a stored result before serving it (SECURITY T12). Cached: results are immutable."""
    Result.model_validate_json(body)
    return body


def build_router(settings: Settings, pool: AsyncConnectionPool | None) -> APIRouter:
    router = APIRouter(prefix="/api/v1")
    post_limit = RateLimiter(rate=10, per=60)  # per client
    post_global = RateLimiter(rate=300, per=60)
    read_limit = RateLimiter(rate=240, per=60)
    streams = Gate(per_key=4, total=200)

    def client_of(request: Request) -> str:
        # Caddy overwrites X-Real-IP with the TCP peer; the API is reachable only via Caddy (internal net).
        ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")
        return client_id(settings.ip_key or b"dev-only-key", ip)

    def origin_ok(request: Request) -> bool:
        origin = request.headers.get("origin")
        return origin is None or origin == settings.public_origin

    @router.post("/analyses")
    async def create(request: Request) -> Response:
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
            if (
                not isinstance(payload, dict)
                or set(payload) != {"repo"}
                or not isinstance(payload["repo"], str)
            ):
                raise ValueError
            repo = parse_repo(payload["repo"])
        except (ValueError, InvalidRepoError):
            return _err("invalid_repo", 400)
        if pool is None:
            return _err("unavailable", 503, 30)
        async with pool.connection() as conn:
            if await db.client_active(conn, client) >= MAX_ACTIVE_PER_CLIENT:
                return _err("too_many_jobs", 429, 30)
            if await db.queue_depth(conn) >= MAX_QUEUE:
                return _err("busy", 503, 30)
            job_id, status = await db.create_job(conn, repo.slug, client)
        return JSONResponse(
            {"id": job_id.hex, "status": status}, status_code=200 if status == "done" else 202
        )

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
            body = _validated(body)
        except ValidationError:
            return _err("internal", 500)
        return Response(
            body,
            media_type="application/json",
            headers={"ETag": etag, "Cache-Control": "public, max-age=31536000, immutable"},
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
            try:
                last: tuple[object, ...] | None = None
                started = beat = time.monotonic()
                current: db.Job | None = job
                while current is not None and time.monotonic() - started < SSE_MAX_S:
                    state = (current.status, current.stage, current.progress, current.total, current.reason)
                    if state != last:
                        last = state
                        data = {"status": current.status, "stage": current.stage,
                                "n": current.progress, "total": current.total}  # fmt: skip
                        if current.reason:
                            data["reason"] = current.reason
                        yield f"event: progress\ndata: {json.dumps(data)}\n\n".encode()
                        beat = time.monotonic()
                    if current.status in ("done", "failed"):
                        return
                    if time.monotonic() - beat > SSE_HEARTBEAT_S:
                        yield b": keep-alive\n\n"
                        beat = time.monotonic()
                    if await request.is_disconnected():
                        return
                    await asyncio.sleep(SSE_POLL_S)
                    async with pool.connection() as conn:
                        current = await db.get_job(conn, current.id)
            finally:
                streams.leave(client)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return router
