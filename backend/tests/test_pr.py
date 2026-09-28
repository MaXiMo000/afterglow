"""PR overlay worker (docs/ROADMAP.md #7): GitHub's test merge vs its first parent, trees only."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from core.repo import RepoRef
from worker.git import AnalysisError, Caps
from worker.pr import analyse_pr, parse_name_status

from .gitfixture import C, make_repo

REPO = RepoRef("acme", "Orbit")
CAPS = Caps(allow_file_protocol=True, wall_s=60)


def pr_repo(tmp: Path) -> str:
    """main = base commit; refs/pull/1/merge = a test merge of a feature branch onto it."""
    url = make_repo(
        tmp,
        [
            C({"a.py": "1\n", "b.py": "2\n", "old.py": "3\n", "keep.py": "4\n"}, time=1_700_000_000),
            C({"a.py": "1\nx\n", "b.py": None, "old.py": None, "new.py": "3\n", "c.py": "5\n"}, time=1_700_000_100),
            C({"a.py": "1\nx\n", "b.py": None, "old.py": None, "new.py": "3\n", "c.py": "5\n"},
              time=1_700_000_200, parent=1, merge=2),
        ],
    )  # fmt: skip
    git = ["git", "--git-dir", str(tmp / "src")]
    merge = subprocess.run(
        [*git, "rev-parse", "main"], check=True, capture_output=True, text=True
    ).stdout.strip()
    subprocess.run([*git, "update-ref", "refs/pull/1/merge", merge], check=True)
    subprocess.run([*git, "update-ref", "refs/heads/main", f"{merge}^1"], check=True)
    return url


def test_pr_changes_come_from_the_test_merge(tmp_path: Path) -> None:
    url = pr_repo(tmp_path)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    r = analyse_pr(REPO, 1, scratch, CAPS, url=url)
    assert r.repo == "acme/orbit" and r.pr == 1 and not r.truncated
    got = {c.path: (c.status, c.old) for c in r.changes}
    assert got == {
        "a.py": ("modified", None),
        "b.py": ("deleted", None),
        "c.py": ("added", None),
        "new.py": ("renamed", "old.py"),  # exact rename, detected from blob ids
    }
    assert "keep.py" not in got
    assert len(r.merge) == 40 and len(r.base) == 40 and r.merge != r.base


def test_a_pr_without_a_test_merge_is_not_found(tmp_path: Path) -> None:
    url = pr_repo(tmp_path)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    with pytest.raises(AnalysisError) as e:
        analyse_pr(REPO, 2, scratch, CAPS, url=url)
    assert e.value.reason == "pr_not_found"


def test_name_status_parsing_is_strict_and_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    changes, cut = parse_name_status(b"M\0a\0R100\0x\0y\0D\0z\0")
    assert [(c.status, c.path, c.old) for c in changes] == [
        ("modified", "a", None),
        ("renamed", "y", "x"),
        ("deleted", "z", None),
    ]
    assert not cut
    with pytest.raises(AnalysisError):
        parse_name_status(b"Q\0a\0")
    with pytest.raises(AnalysisError):
        parse_name_status(b"R100\0only-one\0")
    monkeypatch.setattr("worker.pr.MAX_PR_PATHS", 2)
    changes, cut = parse_name_status(b"M\0a\0M\0b\0M\0c\0")
    assert len(changes) == 2 and cut
