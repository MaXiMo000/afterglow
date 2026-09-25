"""Golden results on a small fixture: every metric checked against hand-computed values."""

from __future__ import annotations

import itertools
from pathlib import Path

import pytest

from core.repo import RepoRef
from core.schema import Result
from worker.analyse import YEAR, analyse, bus_factor
from worker.git import Caps

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
    assert all(b.t > a.t for a, b in itertools.pairwise(months))


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
