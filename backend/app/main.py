"""Application factory: health check plus the v1 analysis API."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import psycopg
import psycopg_pool
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg_pool import AsyncConnectionPool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import db
from app.api import build_router
from app.notify import Hub, listen
from app.settings import Settings, load_settings

log = logging.getLogger("afterglow")

# Safe reason codes only: never echo exception text, paths or input back to the client (SECURITY T14).
READY_CACHE_S = 5.0
_REASONS = {
    400: "bad_request",
    404: "not_found",
    405: "method_not_allowed",
    413: "too_large",
    429: "rate_limited",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or load_settings()
    # check: validate on checkout, so a DB restart or failover costs a reconnect, not a 500.
    pool = (
        AsyncConnectionPool(
            cfg.database_url,
            min_size=1,
            max_size=20,
            open=False,
            timeout=5,
            check=AsyncConnectionPool.check_connection,
        )
        if cfg.database_url
        else None
    )

    hub = Hub()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        listener = None
        if pool is not None:
            await pool.open()
            listener = asyncio.create_task(listen(cfg.database_url, hub))
        try:
            yield
        finally:
            if listener is not None:
                listener.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await listener
            if pool is not None:
                await pool.close()

    app = FastAPI(
        title="Afterglow",
        docs_url=None if cfg.is_prod else "/api/docs",
        redoc_url=None,
        openapi_url=None if cfg.is_prod else "/api/openapi.json",
        lifespan=lifespan,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(cfg.allowed_hosts))

    @app.middleware("http")
    async def no_store_by_default(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse({"error": _REASONS.get(exc.status_code, "error")}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": "bad_request"}, status_code=400)  # FastAPI's default echoes the input

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled error: %s", type(exc).__name__)
        return JSONResponse({"error": "internal"}, status_code=500)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    ready: list[tuple[float, str]] = []  # (checked at, status): one database check per READY_CACHE_S at most
    ready_lock = asyncio.Lock()

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        """For an uptime monitor: 503 when the database is unreachable or no worker is taking queued jobs.

        Public but cheap: the answer is cached, so a flood of requests costs one query per READY_CACHE_S and
        cannot take connections from real traffic (SECURITY T11).
        """
        if pool is None:
            return JSONResponse({"status": "unavailable"}, status_code=503)
        async with ready_lock:  # concurrent requests wait for one check instead of each running it
            if not ready or time.monotonic() - ready[0][0] > READY_CACHE_S:
                try:
                    async with pool.connection(timeout=2) as conn:
                        status = "queue_stalled" if await db.queue_stalled(conn) else "ok"
                except (psycopg.Error, psycopg_pool.PoolTimeout):
                    status = "database"
                ready[:] = [(time.monotonic(), status)]
            status = ready[0][1]
        return JSONResponse({"status": status}, status_code=200 if status == "ok" else 503)

    app.include_router(build_router(cfg, pool, hub))
    return app
