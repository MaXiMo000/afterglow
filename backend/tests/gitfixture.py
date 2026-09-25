"""Build fixture repositories with `git fast-import`, which accepts paths and objects normal porcelain refuses
(newlines, escape sequences, gitlinks), so hostile repos can be made without touching the filesystem."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

GITLINK = object()  # value marking a submodule entry
SYMLINK = "symlink:"  # value prefix marking a symlink with the given target


@dataclass
class C:
    """One commit: files maps path -> content (bytes/str), None to delete, GITLINK, or 'symlink:<target>'."""

    files: dict[str, object] = field(default_factory=dict)
    author: str = "Ann"
    email: str = "ann@example.com"
    time: int = 1_700_000_000
    message: bytes = b"change"
    parent: int | None = None  # 1-based index of the parent commit; default: the previous commit
    merge: int | None = None  # 1-based index of a second parent (makes a merge commit)


def _quote(path: str) -> bytes:
    raw = path.encode()
    if any(b in raw for b in b'\n"\\') or raw.startswith(b'"'):
        return b'"' + raw.replace(b"\\", b"\\\\").replace(b'"', b'\\"').replace(b"\n", b"\\n") + b'"'
    return raw


def make_repo(root: Path, commits: list[C], name: str = "src") -> str:
    """Create a bare repo from commits (oldest first); return a file:// URL that allows partial clones."""
    repo = root / name
    subprocess.run(["git", "init", "-q", "--bare", str(repo)], check=True)
    out = bytearray()
    for n, c in enumerate(commits, start=1):
        out += b"commit refs/heads/main\n"
        out += f"mark :{n}\n".encode()
        out += b"author " + c.author.encode() + f" <{c.email}> {c.time} +0000\n".encode()
        out += b"committer " + c.author.encode() + f" <{c.email}> {c.time} +0000\n".encode()
        out += f"data {len(c.message)}\n".encode() + c.message + b"\n"
        if n > 1:
            out += f"from :{c.parent or n - 1}\n".encode()
        if c.merge:
            out += f"merge :{c.merge}\n".encode()
        for path, content in c.files.items():
            q = _quote(path)
            if content is None:
                out += b"D " + q + b"\n"
            elif content is GITLINK:
                out += b"M 160000 " + b"1" * 40 + b" " + q + b"\n"
            elif isinstance(content, str) and content.startswith(SYMLINK):
                target = content[len(SYMLINK) :].encode()
                out += b"M 120000 inline " + q + f"\ndata {len(target)}\n".encode() + target + b"\n"
            else:
                data = content.encode() if isinstance(content, str) else content
                assert isinstance(data, bytes)
                out += b"M 100644 inline " + q + f"\ndata {len(data)}\n".encode() + data + b"\n"
        out += b"\n"
    fast_import = ["git", "-c", "core.protectNTFS=false", "--git-dir", str(repo), "fast-import", "--quiet"]
    subprocess.run(fast_import, input=bytes(out), check=True)
    for key, value in (("uploadpack.allowFilter", "true"), ("uploadpack.allowAnySHA1InWant", "true")):
        subprocess.run(["git", "--git-dir", str(repo), "config", key, value], check=True)
    subprocess.run(["git", "--git-dir", str(repo), "symbolic-ref", "HEAD", "refs/heads/main"], check=True)
    return repo.resolve().as_uri()


def append_raw_path(url: str, parts: list[str], content: bytes, time: int = 1_700_000_500) -> None:
    """Add a commit whose tree holds a path fast-import refuses (e.g. `..` components), built with mktree
    the way an attacker would."""
    from urllib.parse import unquote, urlparse

    raw = unquote(urlparse(url).path)
    repo = raw.lstrip("/") if raw[2:3] == ":" else raw  # file:///C:/... on Windows

    def git(*args: str, data: bytes | None = None) -> str:
        env = {"GIT_AUTHOR_DATE": f"{time} +0000", "GIT_COMMITTER_DATE": f"{time} +0000"}
        import os

        return subprocess.run(
            ["git", "-c", "user.name=Ann", "-c", "user.email=a@example.com", "--git-dir", repo, *args],
            input=data, capture_output=True, check=True, env={**os.environ, **env},
        ).stdout.decode().strip()  # fmt: skip

    oid = git("hash-object", "-w", "--stdin", data=content)
    entry = f"100644 blob {oid}\t{parts[-1]}\n"
    for name in reversed(parts[:-1]):
        entry = f"040000 tree {git('mktree', data=entry.encode())}\t{name}\n"
    existing = git("ls-tree", "main")  # keep the current top-level entries alongside the new one
    tree = git("mktree", data=(existing + "\n" + entry).encode())
    commit = git("commit-tree", tree, "-p", "main", "-m", "x")
    git("update-ref", "refs/heads/main", commit)
