"""Hostile repositories (SECURITY T2, T3, T5, T6). The author of the repo controls every byte we parse."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

from core.repo import RepoRef
from core.schema import MAX_PATH, Result
from worker.analyse import analyse
from worker.git import AnalysisError, Caps

from .gitfixture import GITLINK, SYMLINK, C, append_raw_path, make_repo

REPO = RepoRef("evil", "repo")
CAPS = Caps(allow_file_protocol=True, wall_s=120)
UNSAFE = re.compile("[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")


def run(tmp: Path, commits: list[C], caps: Caps = CAPS) -> Result:
    url = make_repo(tmp, commits)
    scratch = tmp / "scratch"
    scratch.mkdir(exist_ok=True)
    return analyse(REPO, scratch, caps, url=url)


def test_hostile_paths_are_neutralised(tmp_path: Path) -> None:
    nasty = {
        "a\nb.py": "x\n",
        "src/\u202etxt.exe": "x\n",
        "src/\x1b[31mred\x1b[0m.py": "x\n",
        "x/" + "a" * 5000: "x\n",
        "ok/normal.py": "1\n",
    }
    url = make_repo(tmp_path, [C(nasty)])
    append_raw_path(url, ["..", "..", "etc", "passwd"], b"root\n")
    (tmp_path / "scratch").mkdir()
    result = analyse(REPO, tmp_path / "scratch", CAPS, url=url)
    paths = [f.path for f in result.files]
    assert len(paths) == len(nasty) + 1
    assert "../../etc/passwd" in paths  # kept as an inert display string; never used as a filesystem path
    for p in paths + [d.name for d in result.dirs]:
        assert not UNSAFE.search(p), p
        assert len(p) <= MAX_PATH
    assert "ok/normal.py" in paths


def test_submodule_symlink_lfs_are_inert(tmp_path: Path) -> None:
    lfs = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "0" * 64 + "\nsize 999999999\n"
    result = run(
        tmp_path,
        [
            C(
                {
                    ".gitmodules": '[submodule "x"]\n\tpath = vendor\n\turl = ext::sh -c "touch /tmp/pwned"\n',
                    "vendor": GITLINK,
                    "link": SYMLINK + "/etc/passwd",
                    "big.bin": lfs,
                }
            )
        ],
    )
    by = {f.path: f for f in result.files}
    assert by["link"].loc == 1  # the link target text, never the file it points at
    assert by["big.bin"].loc == 3
    assert by["vendor"].loc == 0  # gitlink: nothing fetched
    assert not (tmp_path / "scratch" / "hist.git" / "modules").exists()


def test_host_git_config_is_ignored(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A poisoned global config (hooks, filters, url rewrites) on the host must have no effect."""
    canary = tmp_path / "canary"
    hooks = tmp_path / "hooks"
    hooks.mkdir()
    for hook in ("post-checkout", "post-merge", "reference-transaction"):
        h = hooks / hook
        h.write_text(f"#!/bin/sh\ntouch '{canary.as_posix()}'\n")
        h.chmod(0o755)
    gitconfig = tmp_path / "evilconfig"
    gitconfig.write_text(
        f"[core]\n\thooksPath = {hooks.as_posix()}\n"
        f"[filter \"evil\"]\n\tsmudge = touch '{canary.as_posix()}'\n"
        '[url "https://evil.example/"]\n\tinsteadOf = file://\n'
    )
    url = make_repo(tmp_path, [C({".gitattributes": "* filter=evil\n", "a.py": "1\n"})])  # before poisoning
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "scratch").mkdir()
    result = analyse(REPO, tmp_path / "scratch", CAPS, url=url)
    assert {f.path for f in result.files} == {".gitattributes", "a.py"}
    assert not canary.exists()


def test_gigantic_commit_message_is_never_read(tmp_path: Path) -> None:
    result = run(tmp_path, [C({"a.py": "1\n"}, message=b"A" * 20_000_000)])
    assert result.meta.commits == 1


def test_author_identity_never_leaks(tmp_path: Path) -> None:
    result = run(
        tmp_path,
        [
            C({"a.py": "1\n"}, author='\x1b]0;pwned\x07Mallory "script"', email="mallory@evil.example"),
            C({"b.py": "1\n"}, author="Eve\u202e", email="eve@evil.example", time=1_700_000_100),
        ],
    )
    dump = result.model_dump_json()
    assert "evil.example" not in dump and "Mallory" not in dump and "Eve" not in dump
    assert not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", dump)  # T6: no email-shaped strings anywhere


def test_history_cap_truncates_to_most_recent(tmp_path: Path) -> None:
    commits = [C({f"f{i % 50}.py": f"{i}\n"}, time=1_600_000_000 + i) for i in range(1_500)]
    result = run(tmp_path, commits, Caps(allow_file_protocol=True, commits=1_000))
    assert result.meta.truncated.commits
    assert result.meta.commits == 1_000
    assert result.meta.span[1] == 1_600_000_000 + 1_499


def test_huge_commit_is_capped(tmp_path: Path) -> None:
    files: dict[str, object] = {f"d{i % 100}/f{i}.py": "x\n" for i in range(100_000)}
    result = run(tmp_path, [C(files)], Caps(allow_file_protocol=True, files=50_000, wall_s=300))
    assert result.meta.truncated.files
    assert len(result.files) == 50_000
    assert result.meta.files == 100_000


def test_zip_bomb_blob_is_not_counted(tmp_path: Path) -> None:
    result = run(
        tmp_path,
        [C({"bomb.txt": b"\n" * 5_000_000, "ok.py": "1\n"})],
        Caps(allow_file_protocol=True, blob_bytes=1_000_000),
    )
    by = {f.path: f for f in result.files}
    assert by["bomb.txt"].loc == 0
    assert by["ok.py"].loc == 1
    assert result.meta.truncated.sizes  # the UI must say line counts are incomplete


def test_history_pack_cap_fails_closed(tmp_path: Path) -> None:
    commits = [C({f"d{i}/f{j}.py": f"{i}\n" for j in range(20)}, time=1_600_000_000 + i) for i in range(200)]
    with pytest.raises(AnalysisError) as err:
        run(tmp_path, commits, Caps(allow_file_protocol=True, pack_bytes=20_000))
    assert err.value.reason == "too_large"


def test_head_pack_cap_degrades_to_no_sizes(tmp_path: Path) -> None:
    """Line counts need file contents; if those are over the cap we still analyse history, flagged."""
    big = os.urandom(3_000_000)  # incompressible, so the depth-1 clone is large while history is tiny
    result = run(
        tmp_path, [C({"r.bin": big, "a.py": "1\n"})], Caps(allow_file_protocol=True, pack_bytes=1_000_000)
    )
    assert result.meta.truncated.sizes
    assert all(f.loc == 0 for f in result.files)


def test_wall_time_cap(tmp_path: Path) -> None:
    with pytest.raises(AnalysisError) as err:
        run(tmp_path, [C({"a.py": "1\n"})], Caps(allow_file_protocol=True, wall_s=0.001))
    assert err.value.reason == "timeout"


@pytest.mark.parametrize(
    "url",
    [
        "ext::sh -c 'touch {canary}'",
        "http://127.0.0.1:1/x.git",
        "ssh://git@127.0.0.1:1/x.git",
        "git://127.0.0.1:1/x.git",
    ],
)
def test_only_https_is_allowed(tmp_path: Path, url: str) -> None:
    canary = tmp_path / "canary"
    scratch = tmp_path / "s"
    scratch.mkdir()
    with pytest.raises(AnalysisError) as err:
        analyse(REPO, scratch, Caps(wall_s=20), url=url.format(canary=canary.as_posix()))
    assert err.value.reason == "clone_failed"
    assert not canary.exists()


def test_file_protocol_is_off_by_default(tmp_path: Path) -> None:
    url = make_repo(tmp_path, [C({"a.py": "1\n"})])
    scratch = tmp_path / "s"
    scratch.mkdir()
    with pytest.raises(AnalysisError):
        analyse(REPO, scratch, Caps(wall_s=20), url=url)


def test_no_lazy_fetch(tmp_path: Path) -> None:
    """Reading file contents from the history clone must fail, never silently fetch from the remote."""
    run(tmp_path, [C({"a.py": "secret\n"})])
    hist = tmp_path / "scratch" / "hist.git"
    proc = subprocess.run(
        ["git", "--git-dir", str(hist), "cat-file", "-p", "HEAD:a.py"],
        env={**os.environ, "GIT_NO_LAZY_FETCH": "1"},
        capture_output=True,
    )
    assert proc.returncode != 0
