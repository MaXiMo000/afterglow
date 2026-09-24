"""Application factory. A0 exposes only a health check; the analysis API arrives in A2."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.settings import Settings, load_settings

log = logging.getLogger("afterglow")

# Safe reason codes only: never echo exception text, paths or input back to the client (SECURITY T14).
_REASONS = {
    400: "bad_request",
    404: "not_found",
    405: "method_not_allowed",
    413: "too_large",
    429: "rate_limited",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or load_settings()
    app = FastAPI(
        title="Afterglow",
        docs_url=None if cfg.is_prod else "/api/docs",
        redoc_url=None,
        openapi_url=None if cfg.is_prod else "/api/openapi.json",
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(cfg.allowed_hosts))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse({"error": _REASONS.get(exc.status_code, "error")}, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled error: %s", type(exc).__name__)
        return JSONResponse({"error": "internal"}, status_code=500)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app
