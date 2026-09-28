"""API v1 against a real Postgres (SECURITY T1, T6, T7, T10, T11, T12, T14) plus least-privilege grants.

Needs AFTERGLOW_TEST_ADMIN_URL / _API_URL / _WORKER_URL (see CLAUDE.md). Skipped locally without them; in CI a
missing database is an error, not a skip.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import uuid
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import db, maint
from app import main as app_main
from app.api import SSE_POLL_S
from app.limits import Gate, RateLimiter
from app.main import create_app
from app.notify import ALL, Hub, listen
from app.settings import Settings
from core.schema import ANALYSER_VERSION, Result
from worker import queue
from worker.git import Caps

from .gitfixture import C, make_repo

ADMIN = os.environ.get("AFTERGLOW_TEST_ADMIN_URL", "")
API = os.environ.get("AFTERGLOW_TEST_API_URL", "")
WORKER = os.environ.get("AFTERGLOW_TEST_WORKER_URL", "")
MAINT = os.environ.get("AFTERGLOW_TEST_MAINT_URL", "")
if not (ADMIN and API and WORKER and MAINT):
    if os.environ.get("CI"):
        raise RuntimeError("database tests must run in CI: set AFTERGLOW_TEST_*_URL")
    pytest.skip("no test database configured", allow_module_level=True)

ORIGIN = "https://afterglow.test"
HEADERS = {"x-afterglow": "1", "origin": ORIGIN, "content-type": "application/json"}


@pytest.fixture(autouse=True)
def clean_db() -> None:
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute("TRUNCATE jobs, results")


@pytest.fixture
def client() -> Iterator[TestClient]:
    settings = Settings(
        env="prod",
        allowed_hosts=("afterglow.test",),
        public_origin=ORIGIN,
        database_url=API,
        ip_key=b"k" * 32,
    )
    with TestClient(create_app(settings), base_url=ORIGIN, raise_server_exceptions=False) as c:
        yield c


def post(
    client: TestClient, body: object, ip: str = "203.0.113.7", **headers: str
) -> tuple[int, dict[str, str]]:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    r = client.post("/api/v1/analyses", content=raw, headers={**HEADERS, "x-real-ip": ip, **headers})
    return r.status_code, r.json()


def work(repo_dir: Path) -> None:
    """Run one queued job through the real worker code against a local fixture repo."""
    url = make_repo(
        repo_dir, [C({"a.py": "1\n2\n"}), C({"a.py": "1\n", "b/c.py": "x\n"}, time=1_700_000_100)]
    )
    with psycopg.connect(WORKER, autocommit=True) as conn:
        claimed = queue.claim(conn)
        assert claimed is not None
        queue.run_job(conn, claimed[0], claimed[1], Caps(allow_file_protocol=True), str(repo_dir), url=url)


def test_full_flow(client: TestClient, tmp_path: Path) -> None:
    status, body = post(client, {"repo": "Acme/Orbit"})
    assert status == 202 and body["status"] == "queued"
    job = body["id"]
    assert len(job) == 32 and uuid.UUID(hex=job).version == 4

    assert client.get(f"/api/v1/analyses/{job}").status_code == 409  # not ready

    work(tmp_path)

    events = client.get(f"/api/v1/analyses/{job}/events")
    assert events.headers["content-type"].startswith("text/event-stream")
    frames = [json.loads(line[6:]) for line in events.text.splitlines() if line.startswith("data: ")]
    assert frames[-1] == {
        "status": "done",
        "stage": "done",
        "n": frames[-1]["n"],
        "total": frames[-1]["total"],
    }

    r = client.get(f"/api/v1/analyses/{job}")
    assert r.status_code == 200
    result = Result.model_validate_json(r.content)
    assert result.meta.repo == "acme/orbit"
    assert {f.path for f in result.files} == {"a.py", "b/c.py"}
    assert "immutable" in r.headers["cache-control"]
    again = client.get(f"/api/v1/analyses/{job}", headers={"if-none-match": r.headers["etag"]})
    assert again.status_code == 304

    # A fresh result is served without queueing new work.
    status, body = post(client, {"repo": "acme/orbit"}, ip="198.51.100.1")
    assert (status, body["status"]) == (200, "done")
    assert client.get(f"/api/v1/analyses/{body['id']}").status_code == 200


def test_dedupe_one_active_job_per_repo(client: TestClient) -> None:
    _, a = post(client, {"repo": "a/b"}, ip="203.0.113.1")
    _, b = post(client, {"repo": "A/B"}, ip="203.0.113.2")
    assert a["id"] == b["id"]


@pytest.mark.parametrize(
    "body",
    [
        {"repo": "https://github.com/a/b"}, {"repo": "a/b/c"}, {"repo": "a/.."}, {"repo": "a/b\n"},
        {"repo": "a/b", "extra": 1}, {"repo": 5}, {"repo": ["a/b"]}, [], "a/b", {"repo": "x" * 500},
        b"{not json", b"",
    ],
)  # fmt: skip
def test_invalid_input_is_rejected_generically(client: TestClient, body: object) -> None:
    status, resp = post(client, body)
    assert status == 400
    assert resp == {"error": "invalid_repo"}  # never echoes the input


def test_csrf_controls(client: TestClient) -> None:
    good = json.dumps({"repo": "a/b"}).encode()
    cases = [
        ({"content-type": "text/plain"}, 415),
        ({"content-type": "application/x-www-form-urlencoded"}, 415),
        ({"x-afterglow": "0"}, 403),
        ({"origin": "https://evil.example"}, 403),
        ({"origin": "null"}, 403),
    ]
    for override, want in cases:
        r = client.post("/api/v1/analyses", content=good, headers={**HEADERS, **override})
        assert r.status_code == want, override
    r = client.post(
        "/api/v1/analyses", content=good, headers={"content-type": "application/json", "origin": ORIGIN}
    )
    assert r.status_code == 403  # custom header missing


def test_oversized_body(client: TestClient) -> None:
    status, resp = post(client, {"repo": "a/" + "b" * 2000})
    assert (status, resp) == (413, {"error": "too_large"})


def test_per_client_job_quota(client: TestClient) -> None:
    assert post(client, {"repo": "a/one"})[0] == 202
    assert post(client, {"repo": "a/two"})[0] == 202
    status, resp = post(client, {"repo": "a/three"})
    assert (status, resp) == (429, {"error": "too_many_jobs"})


def test_queue_depth_backpressure(client: TestClient) -> None:
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        for i in range(50):
            conn.execute(
                "INSERT INTO jobs (id, repo, client) VALUES (%s, %s, %s)", (uuid.uuid4(), f"q/r{i}", "0" * 32)
            )
    r = client.post(
        "/api/v1/analyses", content=b'{"repo":"a/b"}', headers={**HEADERS, "x-real-ip": "192.0.2.9"}
    )
    assert r.status_code == 503
    assert r.json() == {"error": "busy"}
    assert int(r.headers["retry-after"]) > 0


def test_rate_limit(client: TestClient) -> None:
    codes = [post(client, {"repo": "bad/"}, ip="192.0.2.55")[0] for _ in range(12)]
    assert codes[:10] == [400] * 10
    assert codes[10:] == [429, 429]


def test_database_restart_does_not_surface_as_500(client: TestClient) -> None:
    # Found by the A8 ZAP scan: after Postgres restarted, the pool handed out a dead connection (AdminShutdown -> 500).
    assert post(client, {"repo": "acme/one"})[0] == 202
    user = psycopg.conninfo.conninfo_to_dict(API)["user"]
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        n = conn.execute(
            "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = %s", (user,)
        ).fetchone()
    assert n and n[0] >= 1  # the pool's idle connection is gone, as after a restart
    assert post(client, {"repo": "acme/two"})[0] == 202


def test_finished_jobs_forget_the_client(client: TestClient, tmp_path: Path) -> None:
    # T6 / privacy note: the client pseudonym is kept only while a job is active (for the per-client cap).
    assert post(client, {"repo": "acme/orbit"})[0] == 202
    work(tmp_path)  # done by the worker
    assert post(client, {"repo": "acme/orbit"}, ip="198.51.100.1")[0] == 200  # cache hit, inserted as done
    assert post(client, {"repo": "does/not-exist"}, ip="198.51.100.2")[0] == 202
    with psycopg.connect(WORKER, autocommit=True) as conn:
        claimed = queue.claim(conn)
        assert claimed is not None
        queue.finish_failed(conn, claimed[0], "not_found")
    assert post(client, {"repo": "acme/queued"}, ip="198.51.100.3")[0] == 202  # still active
    with psycopg.connect(ADMIN) as conn:
        rows = conn.execute("SELECT status, client FROM jobs").fetchall()
    assert sorted(c for s, c in rows if s in ("done", "failed")) == ["0" * 32] * 3
    assert [c for s, c in rows if s == "queued"] != ["0" * 32]


def test_unknown_and_malformed_ids(client: TestClient) -> None:
    for jid in (uuid.uuid4().hex, "0" * 32, "../../etc/passwd", "A" * 32, "x", uuid.uuid4().hex + "0"):
        r = client.get(f"/api/v1/analyses/{jid}")
        assert r.status_code == 404
        assert r.json() == {"error": "not_found"}
    assert client.get("/api/v1/analyses").status_code in (404, 405)  # no listing endpoint (T7)


def test_failed_job_reports_reason_code_only(client: TestClient) -> None:
    _, body = post(client, {"repo": "does/not-exist"})
    with psycopg.connect(WORKER, autocommit=True) as conn:
        claimed = queue.claim(conn)
        assert claimed is not None
        queue.finish_failed(conn, claimed[0], "not_found")
    r = client.get(f"/api/v1/analyses/{body['id']}")
    assert (r.status_code, r.json()) == (422, {"error": "not_found"})


def test_client_ip_is_never_stored(client: TestClient) -> None:
    post(client, {"repo": "a/b"}, ip="203.0.113.77")
    with psycopg.connect(ADMIN) as conn:
        row = conn.execute("SELECT client FROM jobs").fetchone()
    assert row is not None
    assert len(row[0]) == 32 and "203.0.113.77" not in row[0]


def test_tampered_result_is_not_served(client: TestClient, tmp_path: Path) -> None:
    _, body = post(client, {"repo": "acme/orbit"})
    work(tmp_path)
    assert client.get(f"/api/v1/analyses/{body['id']}").status_code == 200  # validated once and remembered
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute("""UPDATE results SET body = convert_to('{"meta": {}}', 'UTF8')""")
    r = client.get(f"/api/v1/analyses/{body['id']}")
    assert (r.status_code, r.json()) == (500, {"error": "internal"})


def test_lost_worker_job_is_failed(client: TestClient) -> None:
    _, body = post(client, {"repo": "a/b"})
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute("UPDATE jobs SET status = 'running', updated = now() - interval '10 minutes'")
    with psycopg.connect(WORKER, autocommit=True) as conn:
        assert queue.claim(conn) is None
    r = client.get(f"/api/v1/analyses/{body['id']}")
    assert r.json() == {"error": "worker_lost"}


@pytest.mark.parametrize(
    ("dsn_name", "sql"),
    [
        ("API", "UPDATE jobs SET status = 'done'"),
        ("API", "DELETE FROM jobs"),
        ("API", "INSERT INTO results (repo, sha, analyser, body) VALUES ('a/b', repeat('a', 40), 1, '')"),
        ("API", "DELETE FROM results"),
        ("API", "CREATE TABLE x (y int)"),
        ("WORKER", "INSERT INTO jobs (id, repo, client) VALUES (gen_random_uuid(), 'a/b', repeat('0', 32))"),
        ("WORKER", "DELETE FROM jobs"),
        ("WORKER", "DELETE FROM results"),
        ("WORKER", "UPDATE jobs SET repo = 'x/y'"),
        ("WORKER", "UPDATE jobs SET client = repeat('1', 32)"),
        ("WORKER", "CREATE TABLE x (y int)"),
        ("MAINT", "INSERT INTO jobs (id, repo, client) VALUES (gen_random_uuid(), 'a/b', repeat('0', 32))"),
        ("MAINT", "UPDATE jobs SET status = 'failed'"),
        ("MAINT", "SELECT client FROM jobs"),
        ("MAINT", "INSERT INTO results (repo, sha, analyser, body) VALUES ('a/b', repeat('a', 40), 1, '')"),
        ("MAINT", "SELECT body FROM results"),
        ("MAINT", "CREATE TABLE x (y int)"),
    ],
)
def test_roles_are_least_privilege(dsn_name: str, sql: str) -> None:
    dsn = {"API": API, "WORKER": WORKER, "MAINT": MAINT}[dsn_name]
    with psycopg.connect(dsn, autocommit=True) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(sql)


def test_retention_deletes_old_jobs_and_unused_results(client: TestClient, tmp_path: Path) -> None:
    _, fresh = post(client, {"repo": "acme/orbit"})
    work(tmp_path)  # a fresh job and result: both stay
    sha = {"old": "1" * 40, "kept": "2" * 40, "v1": "3" * 40}
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        v = ANALYSER_VERSION
        for repo, key, analyser, age in (
            ("a/old", "old", v, "40 days"),  # too old, nobody asked: deleted
            ("a/kept", "kept", v, "40 days"),  # too old, but asked for recently: kept
            ("a/v1", "v1", v - 1, "1 day"),  # recent, but from an older analyser nobody uses: deleted
            ("a/young", "young", v, "10 days"),  # nobody asked, but under 30 days: kept
            (
                "a/next",
                "next",
                v + 1,
                "1 day",
            ),  # written by a newer analyser (rolling upgrade): never deleted
        ):
            conn.execute(
                "INSERT INTO results (repo, sha, analyser, body, created) "
                "VALUES (%s, %s, %s, '{}', now() - %s::interval)",
                (repo, sha.get(key, "4" * 40), analyser, age),
            )
        # Asked for again recently: its job keeps the old result alive.
        conn.execute(
            "INSERT INTO jobs (id, repo, client, status, stage, sha, analyser) "
            "VALUES (gen_random_uuid(), 'a/kept', repeat('0', 32), 'done', 'done', %s, %s)",
            (sha["kept"], v),
        )
        conn.execute(
            "INSERT INTO jobs (id, repo, client, status, stage, reason, updated) VALUES "
            "(gen_random_uuid(), 'a/gone', repeat('0', 32), 'failed', 'failed', 'not_found', now() - interval '8 days')"
        )
        conn.execute(  # an old job that is still queued is never deleted
            "INSERT INTO jobs (id, repo, client, updated) "
            "VALUES (gen_random_uuid(), 'a/wait', repeat('0', 32), now() - interval '8 days')"
        )
    with psycopg.connect(MAINT, autocommit=True) as conn:
        assert maint.prune(conn) == (1, 2)
    with psycopg.connect(ADMIN) as conn:
        jobs = sorted(r[0] for r in conn.execute("SELECT repo FROM jobs"))
        results = sorted(r[0] for r in conn.execute("SELECT repo FROM results"))
    assert jobs == ["a/kept", "a/wait", "acme/orbit"]
    assert results == ["a/kept", "a/next", "a/young", "acme/orbit"]
    assert client.get(f"/api/v1/analyses/{fresh['id']}").status_code == 200


def test_readyz_reports_a_stalled_queue(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app_main, "READY_CACHE_S", 0.0)  # every request re-checks (the cache is tested below)
    assert client.get("/readyz").json() == {"status": "ok"}
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO jobs (id, repo, client, created) "
            "VALUES (gen_random_uuid(), 'a/b', repeat('1', 32), now() - interval '10 minutes')"
        )
    r = client.get("/readyz")
    assert (r.status_code, r.json()) == (503, {"status": "queue_stalled"})
    with psycopg.connect(ADMIN, autocommit=True) as conn:  # left running by a crashed worker: still stalled
        conn.execute(
            "INSERT INTO jobs (id, repo, client, status, stage, updated) "
            "VALUES (gen_random_uuid(), 'c/d', repeat('1', 32), 'running', 'cloning', now() - interval '5 minutes')"
        )
    assert client.get("/readyz").json() == {"status": "queue_stalled"}
    with psycopg.connect(ADMIN, autocommit=True) as conn:  # its heartbeat is recent: a live worker is busy
        conn.execute("UPDATE jobs SET updated = now() WHERE repo = 'c/d'")
    assert client.get("/readyz").status_code == 200


def test_readyz_is_cached(client: TestClient) -> None:
    """A flood of /readyz requests costs one query per READY_CACHE_S, not one each (SECURITY T11)."""
    assert client.get("/readyz").json() == {"status": "ok"}
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO jobs (id, repo, client, created) "
            "VALUES (gen_random_uuid(), 'a/b', repeat('1', 32), now() - interval '10 minutes')"
        )
    assert client.get("/readyz").json() == {"status": "ok"}  # the answer from a moment ago


def test_heartbeat_keeps_a_slow_job_alive(client: TestClient) -> None:
    _, body = post(client, {"repo": "a/b"})
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute("UPDATE jobs SET status = 'running', updated = now() - interval '80 seconds'")
    with psycopg.connect(WORKER, autocommit=True) as conn:
        assert queue.claim(conn) is None  # 80 s without a beat is still inside LOST_AFTER
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        assert conn.execute("SELECT status FROM jobs").fetchone() == ("running",)
        conn.execute("UPDATE jobs SET updated = now() - interval '100 seconds'")
    with psycopg.connect(WORKER, autocommit=True) as conn:
        queue.claim(conn)
    assert client.get(f"/api/v1/analyses/{body['id']}").json() == {"error": "worker_lost"}


def test_limiter_and_gate_units() -> None:
    rl = RateLimiter(rate=2, per=60)
    assert rl.check("k") == 0 and rl.check("k") == 0
    assert rl.check("k") > 0
    assert rl.check("other") == 0
    g = Gate(per_key=1, total=2, max_age=60)
    assert g.enter("a") and not g.enter("a")
    assert g.enter("b") and not g.enter("c")
    g.leave("a")
    assert g.enter("c")


def test_job_changes_notify_progress_streams(client: TestClient, tmp_path: Path) -> None:
    with psycopg.connect(ADMIN, autocommit=True) as listener:
        listener.execute("LISTEN job_progress")
        _, a = post(client, {"repo": "a/first"}, ip="203.0.113.1")
        _, b = post(client, {"repo": "a/second"}, ip="203.0.113.2")
        work(tmp_path)  # claims the older job, runs it to done
        payloads = [n.payload for n in listener.notifies(timeout=1.0)]
    assert payloads.count("*") >= 4  # two enqueued, one started, one finished: queue positions moved
    assert a["id"] in payloads and b["id"] not in payloads  # only the job whose progress changed
    assert all(p == "*" or re.fullmatch(r"[0-9a-f]{32}", p) for p in payloads)  # ids only, no data


def test_queue_position(client: TestClient) -> None:
    ids = [uuid.UUID(hex=post(client, {"repo": f"q/r{i}"}, ip=f"203.0.113.{i}")[1]["id"]) for i in range(3)]

    async def ahead() -> list[int | None]:
        async with await psycopg.AsyncConnection.connect(API) as conn:
            return [await db.queue_ahead(conn, i) for i in ids]

    assert asyncio.run(ahead()) == [0, 1, 2]
    with psycopg.connect(WORKER, autocommit=True) as conn:
        assert queue.claim(conn) is not None
    assert asyncio.run(ahead()) == [None, 0, 1]


def test_listener_wakes_streams_on_job_changes(client: TestClient) -> None:
    """End to end: a worker's update reaches a waiting stream through NOTIFY, well before the fallback poll."""
    _, a = post(client, {"repo": "n/one"}, ip="203.0.113.1")

    async def scenario() -> tuple[float, bool, bool]:
        hub = Hub()
        task = asyncio.create_task(listen(API, hub))
        own = hub.subscribe(a["id"])
        queued = hub.subscribe(ALL)  # what a queued stream also waits on
        other = hub.subscribe("f" * 32)
        await asyncio.sleep(0.5)  # LISTEN is up
        own.clear(), queued.clear(), other.clear()  # connecting wakes everyone once
        start = asyncio.get_running_loop().time()
        with psycopg.connect(WORKER, autocommit=True) as conn:
            assert queue.claim(conn) is not None  # queued -> running: the job's own event and the queue event
        await asyncio.wait_for(own.wait(), 1.5)
        took = asyncio.get_running_loop().time() - start
        await asyncio.sleep(0.2)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        return took, queued.is_set(), other.is_set()

    took, queued, other = asyncio.run(scenario())
    assert took < SSE_POLL_S
    assert queued and not other


def test_wait_estimate(client: TestClient) -> None:
    async def stats() -> tuple[float, int] | None:
        async with await psycopg.AsyncConnection.connect(API) as conn:
            return await db.run_stats(conn)

    assert asyncio.run(stats()) is None  # nothing finished today: no estimate rather than a guess
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        for i, secs in enumerate((10, 30, 90)):
            conn.execute(
                "INSERT INTO jobs (id, repo, client, status, stage, reason, started, updated) "
                "VALUES (gen_random_uuid(), %s, repeat('0', 32), 'failed', 'failed', 'x', "
                "now() - make_interval(secs => %s), now())",
                (f"w/r{i}", secs),
            )
    assert asyncio.run(stats()) == (30.0, 0)  # median run time; no live worker

    post(client, {"repo": "w/queued"})
    job = post(client, {"repo": "w/mine"}, ip="198.51.100.9")[1]["id"]
    events = client.get(f"/api/v1/analyses/{job}/events", timeout=5)
    first = json.loads(next(line[6:] for line in events.text.splitlines() if line.startswith("data: ")))
    assert (first["ahead"], first["wait"]) == (1, 60)  # one job ahead, one worker assumed: two run times


def test_badge(client: TestClient, tmp_path: Path) -> None:
    missing = client.get("/api/v1/badges/acme/orbit.svg")
    assert missing.status_code == 200 and b"not analysed" in missing.content
    assert missing.headers["cache-control"] == "public, max-age=300"
    post(client, {"repo": "acme/orbit"})
    work(tmp_path)
    r = client.get("/api/v1/badges/Acme/Orbit.svg")
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/svg+xml")
    assert b"acme/orbit" in r.content and b"not analysed" not in r.content
    assert r.headers["cache-control"] == "public, max-age=3600"
    for bad in ("acme/orbit.png", "acme/..svg", "-x/y.svg", "a/b.git.svg"):
        assert client.get(f"/api/v1/badges/{bad}").status_code == 404
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        assert conn.execute("SELECT count(*) FROM jobs").fetchone() == (1,)  # a badge never queues work
