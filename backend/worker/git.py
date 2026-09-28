"""Every git invocation the worker makes (SECURITY T1-T3).

Rules enforced here, for every call:
- argv lists only, never a shell; repository names never reach argv except inside a URL built by core.repo.
- a scrubbed environment: no system/global/user config, no prompts, no credential helpers, no lazy fetches.
- hooks off, only https (plus file:// for local test fixtures), no redirects, no submodules.
- a wall-clock deadline and one size budget for the whole scratch directory (all clones and temp files
  together); on breach the whole process group is killed.
- an optional heartbeat, called at most every HEARTBEAT_S while git runs, so a job that is still working is
  never mistaken for one whose worker died.
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import signal
import subprocess  # nosec B404 - argv lists only, see Git._spawn
import sys
import tempfile
import time
from collections.abc import Callable, Iterator
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
    # On-disk size of the whole scratch dir (both clones). Scratch is a tmpfs, whose pages count against the
    # worker's 1 GB memory limit, so this budget plus git and Python must stay well under it.
    pack_bytes: int = 512 * 1024**2
    commits: int = 200_000
    files: int = 50_000
    tracked_paths: int = 500_000  # distinct paths remembered while reading history
    blob_bytes: int = 8 * 1024**2  # larger blobs are not line-counted
    total_blob_bytes: int = 256 * 1024**2  # read while counting lines; streamed, never held in memory at once
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


HEARTBEAT_S = 5.0
_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_PR_REF = re.compile(r"refs/pull/[1-9][0-9]{0,7}/merge")  # built from a validated int, checked again here


class Git:
    """One scratch area per job; all clones live under it and die with it."""

    def __init__(
        self, scratch: Path, caps: Caps, deadline: float, heartbeat: Callable[[], None] | None = None
    ) -> None:
        self.scratch, self.caps, self.deadline = scratch, caps, deadline
        self._heartbeat, self._beat = heartbeat, time.monotonic()
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
        now = time.monotonic()
        left = self.deadline - now
        if left <= 0:
            raise AnalysisError("timeout")
        if self._heartbeat and now - self._beat >= HEARTBEAT_S:
            self._beat = now
            self._heartbeat()
        return left

    def _wait(self, proc: subprocess.Popen[bytes]) -> None:
        """Wait for a short command within the deadline, beating the heartbeat while it runs."""
        while proc.poll() is None:
            self._remaining()
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(timeout=0.05)

    def _watch(self, proc: subprocess.Popen[bytes]) -> None:
        """Wait for a fetch, killing it on the deadline or when scratch outgrows the budget."""
        try:
            while proc.poll() is None:
                time.sleep(0.05)
                self._remaining()
                if _dir_size(self.scratch) > self.caps.pack_bytes:
                    raise AnalysisError("too_large")
        finally:
            self._kill(proc)
        if proc.returncode != 0:
            raise AnalysisError("clone_failed")
        if _dir_size(self.scratch) > self.caps.pack_bytes:
            raise AnalysisError("too_large")

    def clone(self, url: str, dest: str, *extra: str) -> Path:
        """Bare clone with no working tree, watched for time and size."""
        self._remaining()
        target = self.scratch / dest
        self._watch(
            self._spawn(
                ["clone", "--bare", "--quiet", "--no-tags", "--single-branch", "--no-recurse-submodules",
                 *extra, "--", url, str(target)]
            )
        )  # fmt: skip
        return target

    def fetch_commit(self, url: str, dest: str, sha: str) -> Path:
        """Bare repo holding exactly one commit (depth 1) and its tree and blobs, watched like `clone`.

        Fetching by id pins the contents to the commit the history was read at: a separate `clone --depth=1`
        would take whatever HEAD is by then.
        """
        if len(sha) not in (40, 64) or any(c not in "0123456789abcdef" for c in sha):
            raise AnalysisError("git_failed")
        return self.fetch_ref(url, dest, sha, 1)

    def fetch_ref(self, url: str, dest: str, ref: str, depth: int, *extra: str) -> Path:
        """Bare repo holding `ref` (a validated sha or `refs/pull/<n>/merge`) to `depth` commits as
        refs/heads/pinned, watched like `clone`. `extra` adds fetch options such as --filter=blob:none."""
        if not (_SHA.fullmatch(ref) or _PR_REF.fullmatch(ref)) or not 1 <= depth <= 10:
            raise AnalysisError("git_failed")
        self._remaining()
        target = self.scratch / dest
        init = self._spawn(["init", "--quiet", "--bare", str(target)])
        try:
            self._wait(init)
        finally:
            self._kill(init)
        if init.returncode != 0:
            raise AnalysisError("git_failed")
        self._watch(
            self._spawn(
                ["--git-dir", str(target), "fetch", "--quiet", f"--depth={depth}", "--no-tags", *extra,
                 "--no-recurse-submodules", "--no-write-fetch-head", "--", url, f"{ref}:refs/heads/pinned"]
            )
        )  # fmt: skip
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
                    self._wait(proc)
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

    def stream(self, repo: Path, *args: str, stdin: Path | None = None) -> Iterator[bytes]:
        """Stream stdout in chunks; the caller may stop early (the process is killed on close)."""
        with open(stdin, "rb") if stdin else contextlib.nullcontext() as fin:
            proc = self._spawn(
                ["--git-dir", str(repo), *args], stdin=fin or subprocess.DEVNULL, stdout=subprocess.PIPE
            )
        assert proc.stdout is not None  # noqa: S101 - set by stdout=PIPE  # nosec B101
        seen = 0
        try:
            while chunk := proc.stdout.read(1 << 16):
                seen += len(chunk)
                if seen > self.caps.log_bytes:
                    raise AnalysisError("too_large")
                self._remaining()
                yield chunk
            self._wait(proc)
            if proc.returncode != 0:
                raise AnalysisError("git_failed")
        finally:
            self._kill(proc)
            proc.stdout.close()

    def remote_head(self, url: str) -> str | None:
        """HEAD sha of a remote without cloning (cache check). None if the remote has no HEAD."""
        return self.remote_ref(url, "HEAD")

    def remote_ref(self, url: str, ref: str) -> str | None:
        """Sha of one ref (`HEAD` or a validated PR ref) on a remote without cloning; None if it has none."""
        if ref != "HEAD" and not _PR_REF.fullmatch(ref):
            raise AnalysisError("git_failed")
        with tempfile.TemporaryFile(dir=self.scratch) as out:
            proc = self._spawn(["ls-remote", "--", url, ref], stdout=out)
            try:
                self._wait(proc)
            finally:
                self._kill(proc)
            if proc.returncode != 0:
                raise AnalysisError("not_found")
            out.seek(0)
            line = out.read(200).split(b"\t", 1)[0].decode("ascii", "replace")
        return line if len(line) in (40, 64) and all(c in "0123456789abcdef" for c in line) else None
