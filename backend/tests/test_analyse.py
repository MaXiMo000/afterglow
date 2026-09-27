"""Golden results on a small fixture: every metric checked against hand-computed values."""

from __future__ import annotations

import itertools
import time
from pathlib import Path

import pytest

from core.repo import RepoRef
from core.schema import Result
from worker import git as worker_git
from worker.analyse import YEAR, analyse, bus_factor, line_counts
from worker.git import Caps, Git

from .gitfixture import C, make_repo

T0 = 1_600_000_000
REPO = RepoRef("acme", "Orbit")
CAPS = Caps(allow_file_protocol=True, wall_s=60)


def run(tmp: Path, commits: list[C], caps: Caps = CAPS) -> Result:
    url = make_repo(tmp, commits)
    scratch = tmp / "scratch"
    scratch.mkdir()
    return analyse(REPO, scratch, caps, url=url)


@pytest.fixture(scope="module")
def golden(tmp_path_factory: pytest.TempPathFactory) -> Result:
    old = T0 - 3 * YEAR
    commits = [
        C({"README.md": "hi\n", "legacy/old.py": "a\nb\nc\n"}, author="Ann", time=old),
        C({"core/app.py": "1\n2\n", "core/util.py": "x"}, author="Ann", time=T0 - 100),
        C({"gone.txt": "bye\n"}, author="Bo", time=T0 - 90),
        C({"gone.txt": None}, author="Bo", time=T0 - 80),
    ]
    # core/app.py and core/util.py change together 6 times, by Ann only -> hotspot + coupling.
    commits += [
        C({"core/app.py": f"1\n2\n{i}\n", "core/util.py": f"x{i}"}, author="Ann", time=T0 - 50 + i)
        for i in range(6)
    ]
    commits.append(C({"core/app.py": "1\n2\n3\n4\n"}, author="Cy", time=T0))
    return run(tmp_path_factory.mktemp("golden"), commits)


def test_meta(golden: Result) -> None:
    m = golden.meta
    assert m.repo == "acme/orbit"
    assert m.commits == 11
    assert m.files == 4  # gone.txt was deleted
    assert m.people == 3
    assert m.span == [T0 - 3 * YEAR, T0]
    assert not m.truncated.files and not m.truncated.commits and not m.truncated.sizes


def test_files(golden: Result) -> None:
    by = {f.path: f for f in golden.files}
    assert set(by) == {"README.md", "legacy/old.py", "core/app.py", "core/util.py"}
    app = by["core/app.py"]
    assert (app.loc, app.changes, app.changes_12m, app.authors) == (4, 8, 8, 2)
    assert app.birth == T0 - 100 and app.last == T0
    assert by["core/util.py"].loc == 1  # no trailing newline still counts as a line
    assert by["legacy/old.py"].dead and not app.dead
    assert app.hot and by["core/util.py"].hot and not by["README.md"].hot


def test_dirs_and_insights(golden: Result) -> None:
    names = [d.name for d in golden.dirs]
    assert names == ["core", "legacy", "(root)"]
    legacy = golden.dirs[names.index("legacy")]
    assert legacy.quiet and legacy.files == 1 and legacy.loc == 3
    assert golden.insights.quiet[0] == names.index("legacy")
    core = golden.dirs[names.index("core")]
    assert core.bus_factor == 1  # Ann made 7 of 8 commits touching core


def test_coupling(golden: Result) -> None:
    assert len(golden.coupling) == 1
    c = golden.coupling[0]
    pair = {golden.files[c.a].path, golden.files[c.b].path}
    assert pair == {"core/app.py", "core/util.py"}
    assert c.count == 7  # created together + 6 joint edits
    assert c.strength == pytest.approx(7 / 7)


def test_people_are_pseudonymous(golden: Result) -> None:
    assert [p.handle for p in golden.people] == ["Contributor 1", "Contributor 2", "Contributor 3"]
    assert golden.people[0].commits == 8
    dump = golden.model_dump_json()
    for secret in ("Ann", "Bo", "Cy", "example.com", "@"):
        assert secret not in dump


def test_timeline(golden: Result) -> None:
    months = golden.timeline
    assert months[0].t <= T0 - 3 * YEAR < months[1].t
    assert sum(m.commits for m in months) == 11
    assert sum(m.removed for m in months) == 1  # gone.txt
    assert all(b.t > a.t for a, b in itertools.pairwise(months))


def test_quarters(golden: Result) -> None:
    by = {f.path: f for f in golden.files}
    assert by["core/app.py"].quarters == [0] * 7 + [8]  # all in HEAD's quarter
    assert by["legacy/old.py"].quarters == []  # three years old: nothing in the last 8 quarters


def test_exact_renames_keep_history(tmp_path: Path) -> None:
    """A folder move and a later file rename keep birth, change counts and hotspot status (D1)."""
    commits = [C({"old/a.py": "1\n", "old/b.py": "2\n"}, time=T0)]
    commits += [C({"old/a.py": f"1\n{i}\n"}, time=T0 + 10 + i) for i in range(5)]
    commits.append(
        C({"old/a.py": None, "old/b.py": None, "new/a.py": "1\n4\n", "new/b.py": "2\n"}, time=T0 + 20)
    )
    commits.append(C({"new/b.py": None, "new/c.py": "2\n"}, time=T0 + 30))  # b.py -> c.py
    commits.append(C({"new/a.py": "edited\n"}, time=T0 + 40))
    result = run(tmp_path, commits)
    by = {f.path: f for f in result.files}
    assert set(by) == {"new/a.py", "new/c.py"}
    a, c = by["new/a.py"], by["new/c.py"]
    assert (a.birth, a.changes) == (T0, 8)  # created, 5 edits, the move, 1 edit
    assert a.hot
    assert (c.birth, c.changes) == (T0, 3)  # created, moved, renamed
    assert sum(m.removed for m in result.timeline) == 0  # moves are not removals
    assert sum(m.added for m in result.timeline) == 2


def test_rename_back_and_forth(tmp_path: Path) -> None:
    commits = [
        C({"a.py": "x\n"}, time=T0),
        C({"a.py": None, "b.py": "x\n"}, time=T0 + 10),
        C({"b.py": None, "a.py": "x\n"}, time=T0 + 20),
    ]
    (f,) = run(tmp_path, commits).files
    assert (f.path, f.birth, f.changes) == ("a.py", T0, 3)


def test_mailmap_merges_spellings(tmp_path: Path) -> None:
    """One person committing under two names counts once when the repository's .mailmap says so (D2)."""
    commits = [
        C({"a.py": "1\n"}, author="Ann Lee", email="ann@example.com", time=T0),
        C({"a.py": "2\n"}, author="ann", email="ann@example.com", time=T0 + 10),
        C({"a.py": "3\n"}, author="A. Lee", email="ann@work.example", time=T0 + 20),
        C({"b.py": "1\n"}, author="Bo", email="bo@example.com", time=T0 + 30),
        C({".mailmap": "Ann Lee <ann@example.com>\nAnn Lee <ann@example.com> <ann@work.example>\n"},
          author="Bo", email="bo@example.com", time=T0 + 40),
    ]  # fmt: skip
    result = run(tmp_path, commits)
    assert result.meta.people == 2
    assert [p.commits for p in result.people] == [3, 2]
    assert {f.path: f.authors for f in result.files}["a.py"] == 1
    assert "Ann" not in result.model_dump_json() and "@" not in result.model_dump_json()


def test_without_mailmap_names_stay_apart(tmp_path: Path) -> None:
    commits = [
        C({"a.py": "1\n"}, author="Ann Lee", time=T0),
        C({"a.py": "2\n"}, author="ann", time=T0 + 10),
    ]
    assert run(tmp_path, commits).meta.people == 2


def test_files_before_a_truncated_window_are_kept(tmp_path: Path) -> None:
    """Past the commit cap, files at HEAD last touched before the window stay in the city with changes=0 (D4)."""
    commits = [C({"ancient.py": "1\n2\n"}, time=T0)]
    commits += [C({"new.py": f"{i}\n"}, time=T0 + YEAR + i) for i in range(5)]
    result = run(tmp_path, commits, Caps(allow_file_protocol=True, wall_s=60, commits=3))
    by = {f.path: f for f in result.files}
    assert set(by) == {"ancient.py", "new.py"}
    old = by["ancient.py"]
    assert (old.changes, old.changes_12m, old.quarters, old.loc) == (0, 0, [], 2)
    assert old.birth == old.last == result.meta.span[0]  # an upper bound: the window's first commit
    assert result.meta.truncated.commits and not result.meta.truncated.files


def test_files_at_head_come_from_the_tree(tmp_path: Path) -> None:
    """Regression: a side branch edits a.py *after* (by date) main deleted it; the merge keeps the deletion.
    The newest change in history is an edit, but a.py does not exist at HEAD and must not be a building."""
    commits = [
        C({"a.py": "1\n", "b.py": "1\n"}, time=T0),
        C({"a.py": None}, time=T0 + 10),  # main deletes a.py
        C({"a.py": "2\n"}, time=T0 + 20, parent=1),  # side branch edits it later
        C({}, time=T0 + 30, parent=2, merge=3),  # merge resolved with a.py deleted
    ]
    result = run(tmp_path, commits)
    assert {f.path for f in result.files} == {"b.py"}
    assert result.meta.files == 1


def test_bus_factor() -> None:
    from collections import Counter

    assert bus_factor(Counter()) == 0
    assert bus_factor(Counter({1: 10})) == 1
    assert bus_factor(Counter({1: 5, 2: 5})) == 1
    assert bus_factor(Counter({1: 3, 2: 3, 3: 3, 4: 3})) == 2


def test_empty_repo_fails_cleanly(tmp_path: Path) -> None:
    import subprocess

    from worker.git import AnalysisError

    bare = tmp_path / "empty"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    scratch = tmp_path / "s"
    scratch.mkdir()
    with pytest.raises(AnalysisError) as err:
        analyse(REPO, scratch, CAPS, url=bare.resolve().as_uri())
    assert err.value.reason in ("empty_repo", "clone_failed")


def test_line_counts_across_stream_chunks(tmp_path: Path) -> None:
    # Many blobs and one larger than a 64 KiB read chunk: the streamed cat-file parser must split them exactly.
    files: dict[str, object] = {f"many/f{i}.txt": "line\n" * (i + 1) for i in range(300)}
    files["big.txt"] = "x" * 99 + "\n" + "y\n" * 70_000
    files["no_newline.txt"] = "a\nb"
    by = {f.path: f.loc for f in run(tmp_path, [C(files)]).files}
    assert by["many/f0.txt"] == 1 and by["many/f299.txt"] == 300
    assert by["big.txt"] == 70_001
    assert by["no_newline.txt"] == 2


def test_sizes_come_from_the_analysed_commit(tmp_path: Path) -> None:
    # A push between reading history and fetching contents must not change the sizes: they are fetched by id.
    url = make_repo(tmp_path, [C({"a.py": "1\n"}, time=T0), C({"a.py": "1\n2\n3\n"}, time=T0 + 1)])
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    git = Git(scratch, CAPS, time.monotonic() + 30)
    hist = git.clone(url, "hist.git", "--filter=blob:none")
    first = git.run(hist, "rev-parse", "HEAD~1").strip().decode()
    head = git.fetch_commit(url, "head.git", first)
    loc, complete = line_counts(git, head, CAPS, first)
    assert (loc, complete) == ({b"a.py": 1}, True)


def test_heartbeat_beats_while_git_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worker_git, "HEARTBEAT_S", 0.0)
    beats: list[None] = []
    url = make_repo(tmp_path, [C({"a.py": "1\n"})])
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    analyse(REPO, scratch, CAPS, url=url, heartbeat=lambda: beats.append(None))
    assert len(beats) >= 3


@pytest.mark.parametrize(
    "mailmap",
    [
        {".mailmap/x": "Ann Lee <ann@example.com> <ann@work.example>\n"},  # a directory, not a file
        {".mailmap": "symlink:/etc/passwd"},  # a symlink: its target text is not a mailmap
        {".mailmap": "Ann Lee <ann@work.example>\n" + "#" * (2 * 1024**2)},  # over MAILMAP_BYTES
    ],
)
def test_unusable_mailmaps_are_ignored(tmp_path: Path, mailmap: dict[str, object]) -> None:
    commits = [
        C({"a.py": "1\n"}, author="Ann Lee", email="ann@example.com", time=T0),
        C({"a.py": "2\n"}, author="A. Lee", email="ann@work.example", time=T0 + 10),
        C(mailmap, author="Ann Lee", email="ann@example.com", time=T0 + 20),
    ]
    assert run(tmp_path, commits).meta.people == 2  # a usable mailmap would merge them into one
