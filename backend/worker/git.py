"""Every git invocation the worker makes (SECURITY T1-T3).

Rules enforced here, for every call:
- argv lists only, never a shell; repository names never reach argv except inside a URL built by core.repo.
- a scrubbed environment: no system/global/user config, no prompts, no credential helpers, no lazy fetches.
- hooks off, only https (plus file:// for local test fixtures), no redirects, no submodules.
- a wall-clock deadline and a directory-size cap; on breach the whole process group is killed.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import subprocess  # nosec B404 - argv lists only, see Git._spawn
import sys
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import IO


class AnalysisError(Exception):
    """A failure with a safe reason code; the code is the only thing ever shown to users."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class Caps:
    wall_s: float = 90.0
    pack_bytes: int = 512 * 1024**2  # per clone, on-disk size
    commits: int = 200_000
    files: int = 50_000
    tracked_paths: int = 500_000  # distinct paths remembered while reading history
    blob_bytes: int = 8 * 1024**2  # larger blobs are not line-counted
    total_blob_bytes: int = 256 * 1024**2  # held in memory while counting; worker mem_limit is 1g
    log_bytes: int = 1024**3  # raw `git log` output
    proxy: str | None = None  # e.g. http://egress:3128 in the container
    allow_file_protocol: bool = False  # tests only: local fixture repos


def _config(caps: Caps) -> list[str]:
    cfg = {
        "core.hooksPath": os.devnull,
        "core.fsmonitor": "false",
        "core.askPass": "",
        "credential.helper": "",
        "protocol.allow": "never",
        "protocol.https.allow": "always",
        "protocol.file.allow": "always" if caps.allow_file_protocol else "never",
        "http.followRedirects": "false",
        "submodule.recurse": "false",
        "fetch.recurseSubmodules": "false",
        "gc.auto": "0",
        "maintenance.auto": "false",
        "advice.detachedHead": "false",
    }
    if caps.proxy:
        cfg["http.proxy"] = caps.proxy
    return [arg for k, v in cfg.items() for arg in ("-c", f"{k}={v}")]


def _env(home: Path) -> dict[str, str]:
    env = {
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_ADVICE": "0",
        "LC_ALL": "C",
    }
    for key in ("PATH", "SYSTEMROOT"):  # SYSTEMROOT: Windows dev machines only
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def _dir_size(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            with contextlib.suppress(OSError):  # git renames temp files while we walk
                total += os.lstat(os.path.join(root, name)).st_size
    return total


class Git:
    """One scratch area per job; all clones live under it and die with it."""

    def __init__(self, scratch: Path, caps: Caps, deadline: float) -> None:
        self.scratch, self.caps, self.deadline = scratch, caps, deadline
        self.home = scratch / "home"
        self.home.mkdir(parents=True, exist_ok=True)
        self._git = shutil.which("git") or "git"

    def _argv(self, args: list[str]) -> list[str]:
        return [self._git, "--no-lazy-fetch", *_config(self.caps), *args]

    def _spawn(
        self,
        args: list[str],
        stdin: int | IO[bytes] = subprocess.DEVNULL,
        stdout: int | IO[bytes] = subprocess.DEVNULL,
    ) -> subprocess.Popen[bytes]:
        return subprocess.Popen(  # noqa: S603 - fixed argv, no shell  # nosec B603
            self._argv(args),
            env=_env(self.home),
            cwd=self.scratch,
            stdin=stdin,
            stdout=stdout,
            stderr=subprocess.DEVNULL,
            start_new_session=sys.platform != "win32",  # own process group, so kill() takes children too
        )

    @staticmethod
    def _kill(proc: subprocess.Popen[bytes]) -> None:
        if proc.poll() is not None:
            return
        if sys.platform != "win32":
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
        proc.wait()

    def _remaining(self) -> float:
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise AnalysisError("timeout")
        return left

    def clone(self, url: str, dest: str, *extra: str) -> Path:
        """Bare clone with no working tree, watched for time and size."""
        self._remaining()
        target = self.scratch / dest
        proc = self._spawn(
            ["clone", "--bare", "--quiet", "--no-tags", "--single-branch", "--no-recurse-submodules",
             *extra, "--", url, str(target)]
        )  # fmt: skip
        try:
            while proc.poll() is None:
                time.sleep(0.05)
                self._remaining()
                if target.exists() and _dir_size(target) > self.caps.pack_bytes:
                    raise AnalysisError("too_large")
        finally:
            self._kill(proc)
        if proc.returncode != 0:
            raise AnalysisError("clone_failed")
        if _dir_size(target) > self.caps.pack_bytes:
            raise AnalysisError("too_large")
        return target

    def run(self, repo: Path, *args: str, stdin: Path | None = None) -> bytes:
        """Run a short git command against a local bare repo and return stdout (bounded)."""
        with tempfile.TemporaryFile(dir=self.scratch) as out:
            fin = open(stdin, "rb") if stdin else None  # noqa: SIM115
            try:
                proc = self._spawn(
                    ["--git-dir", str(repo), *args], stdin=fin or subprocess.DEVNULL, stdout=out
                )
                try:
                    proc.wait(timeout=self._remaining())
                except subprocess.TimeoutExpired:
                    raise AnalysisError("timeout") from None
                finally:
                    self._kill(proc)
            finally:
                if fin:
                    fin.close()
            if proc.returncode != 0:
                raise AnalysisError("git_failed")
            if out.tell() > self.caps.log_bytes:
                raise AnalysisError("too_large")
            out.seek(0)
            return out.read()

    def stream(self, repo: Path, *args: str) -> Iterator[bytes]:
        """Stream stdout in chunks; the caller may stop early (the process is killed on close)."""
        proc = self._spawn(["--git-dir", str(repo), *args], stdout=subprocess.PIPE)
        assert proc.stdout is not None  # noqa: S101 - set by stdout=PIPE  # nosec B101
        seen = 0
        try:
            while chunk := proc.stdout.read(1 << 16):
                seen += len(chunk)
                if seen > self.caps.log_bytes:
                    raise AnalysisError("too_large")
                self._remaining()
                yield chunk
            if proc.wait(timeout=self._remaining()) != 0:
                raise AnalysisError("git_failed")
        finally:
            self._kill(proc)
            proc.stdout.close()

    def remote_head(self, url: str) -> str | None:
        """HEAD sha of a remote without cloning (cache check). None if the remote has no HEAD."""
        with tempfile.TemporaryFile(dir=self.scratch) as out:
            proc = self._spawn(["ls-remote", "--", url, "HEAD"], stdout=out)
            try:
                proc.wait(timeout=self._remaining())
            except subprocess.TimeoutExpired:
                raise AnalysisError("timeout") from None
            finally:
                self._kill(proc)
            if proc.returncode != 0:
                raise AnalysisError("not_found")
            out.seek(0)
            line = out.read(200).split(b"\t", 1)[0].decode("ascii", "replace")
        return line if len(line) in (40, 64) and all(c in "0123456789abcdef" for c in line) else None
