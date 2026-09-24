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
