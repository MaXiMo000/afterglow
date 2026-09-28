from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


def test_healthz(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_foreign_host_rejected(client: TestClient) -> None:
    """T13: a request for any host not on the exact allowlist is refused."""
    r = client.get("/healthz", headers={"host": "evil.example"})
    assert r.status_code == 400


def test_docs_disabled_in_prod(client: TestClient) -> None:
    """T14: no interactive docs or schema in prod."""
    for path in ("/api/docs", "/api/openapi.json", "/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_not_found_is_generic(client: TestClient) -> None:
    r = client.get("/nope/<script>")
    assert r.status_code == 404
    assert r.json() == {"error": "not_found"}
    assert "script" not in r.text


def test_unhandled_error_hides_details(prod_settings: Settings) -> None:
    """T14: an exception never leaks its message or a stack trace."""
    app = create_app(prod_settings)

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("secret internal detail /etc/passwd")

    r = TestClient(app, base_url="https://afterglow.test", raise_server_exceptions=False).get("/boom")
    assert r.status_code == 500
    assert r.json() == {"error": "internal"}
    assert "secret" not in r.text
    assert "Traceback" not in r.text


def test_api_responses_are_not_cached_by_default(client: TestClient) -> None:
    assert client.get("/healthz").headers["cache-control"] == "no-store"
    assert client.get("/nope").headers["cache-control"] == "no-store"


def test_readyz_without_database_is_unavailable(client: TestClient) -> None:
    r = client.get("/readyz")
    assert (r.status_code, r.json()) == (503, {"status": "unavailable"})


def test_featured_lists_the_configured_repositories(prod_settings: Settings) -> None:
    s = Settings(
        **{**{f: getattr(prod_settings, f) for f in prod_settings.__slots__}, "featured": ("a/b", "c/d")}
    )
    c = TestClient(create_app(s), base_url="https://afterglow.test")
    r = c.get("/api/v1/featured")
    assert r.status_code == 200 and r.json() == {"repos": ["a/b", "c/d"]}
    assert "max-age=300" in r.headers["cache-control"]
