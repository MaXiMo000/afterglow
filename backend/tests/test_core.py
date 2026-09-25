"""Repo validation (T1), result schema (T5, T12, T21) and the result store (T12)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from core.repo import InvalidRepoError, parse_repo
from core.schema import Result, clean_text
from core.store import ResultStore

SHA = "a" * 40


@pytest.mark.parametrize("raw", ["tiangolo/fastapi", "a-b/c.d_e-f", "A/B", "x/.github"])
def test_valid_repos(raw: str) -> None:
    assert parse_repo(raw).slug == raw.lower()


@pytest.mark.parametrize(
    "raw",
    [
        "", "fastapi", "a/b/c", "a/.", "a/..", "../x", "a/b\n", "a/b ", " a/b", "a /b", "a/b\t",
        "https://github.com/a/b", "github.com/a/b", "git@github.com:a/b", "a:b/c", "a@b/c", "a/b%2e", "a%2Fb",
        "\uff41/b", "a/b\u202e", "a/b\u200b", "-a/b", "a-/b", "a/b.git", "a/b.GIT", "a" * 40 + "/b", "a/" + "b" * 101,
        "x" * 10_000,
    ],
)  # fmt: skip
def test_invalid_repos(raw: str) -> None:
    with pytest.raises(InvalidRepoError):
        parse_repo(raw)


def test_clone_url_is_built_not_passed() -> None:
    assert parse_repo("Tiangolo/FastAPI").clone_url == "https://github.com/Tiangolo/FastAPI.git"


def test_clean_text() -> None:
    assert clean_text(b"a\nb\x1b[0m\xe2\x80\xaec\xff") == "a\ufffdb\ufffd[0m\ufffdc\ufffd"
    assert len(clean_text("x" * 5000)) == 512


def minimal(**over: object) -> dict[str, object]:
    doc: dict[str, object] = {
        "meta": {
            "repo": "a/b", "sha": SHA, "analyser": 1, "generated_at": 1, "commits": 1, "files": 1, "people": 1,
            "span": [1, 2], "truncated": {"files": False, "commits": False, "sizes": False},
        },
        "dirs": [{"name": "(root)", "files": 1, "loc": 1, "last": 2, "bus_factor": 1, "quiet": False}],
        "files": [{"path": "a.py", "dir": 0, "loc": 1, "birth": 1, "last": 2, "changes": 1, "changes_12m": 1,
                   "authors": 1, "hot": False, "dead": False}],
        "coupling": [], "people": [{"handle": "Contributor 1", "commits": 1, "areas": [0]}],
        "insights": {"hotspots": [0], "bus_factor": [], "quiet": [], "coupling": []},
        "timeline": [{"t": 0, "commits": 1, "added": 1}],
    }  # fmt: skip
    doc.update(over)
    return doc


def test_schema_accepts_minimal() -> None:
    Result.model_validate_json(json.dumps(minimal()))


@pytest.mark.parametrize(
    "bad",
    [
        {"extra": 1},
        {"files": [{**minimal()["files"][0], "path": "a\u202eb"}]},  # type: ignore[index]
        {"files": [{**minimal()["files"][0], "path": "a\nb"}]},  # type: ignore[index]
        {"files": [{**minimal()["files"][0], "dir": 5}]},  # type: ignore[index]
        {"files": [{**minimal()["files"][0], "loc": -1}]},  # type: ignore[index]
        {"files": [{**minimal()["files"][0], "email": "a@b.c"}]},  # type: ignore[index]
        {"people": [{"handle": "Linus Torvalds", "commits": 1, "areas": []}]},
        {"insights": {"hotspots": [9], "bus_factor": [], "quiet": [], "coupling": []}},
        {"coupling": [{"a": 0, "b": 0, "count": 1, "strength": 2.0}]},
    ],
)
def test_schema_rejects(bad: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Result.model_validate_json(json.dumps(minimal(**bad)))


def test_schema_rejects_nan() -> None:
    raw = json.dumps(minimal(coupling=[{"a": 0, "b": 0, "count": 1, "strength": 0.5}])).replace("0.5", "NaN")
    with pytest.raises(ValidationError):
        Result.model_validate_json(raw)


def test_store_roundtrip_and_tamper(tmp_path: Path) -> None:
    store = ResultStore(tmp_path)
    repo = parse_repo("A/B")
    result = Result.model_validate_json(json.dumps(minimal()))
    assert store.get(repo, SHA) is None
    store.put(repo, result)
    assert store.get(parse_repo("a/b"), SHA) == result
    path = next(tmp_path.rglob("*.json"))
    assert path.name == f"{SHA}.v1.json"
    path.write_text(json.dumps(minimal(extra=1)))
    assert store.get(repo, SHA) is None  # planted/corrupt file is a miss, never served
    with pytest.raises(ValueError, match="does not belong"):
        store.put(parse_repo("x/y"), result)
    with pytest.raises(ValueError, match="bad sha"):
        store.get(repo, "../../etc")
