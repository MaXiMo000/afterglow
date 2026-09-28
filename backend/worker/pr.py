"""Pull request overlay (docs/ROADMAP.md #7): which files a PR changes, without reading any file contents.

GitHub keeps a test merge of every open, mergeable PR at `refs/pull/<n>/merge`; its first parent is the base
branch, so `diff-tree base merge` is exactly the PR's change set. Only those two commits and their trees are
fetched (depth 2, no blobs), from github.com like every other fetch: no new egress path and no API.
Closed, merged or conflicting PRs have no test merge and are reported as `pr_not_found`.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from core.repo import RepoRef
from core.schema import MAX_PR_PATHS, PrChange, PrResult, clean_text
from worker.analyse import github_href
from worker.git import AnalysisError, Caps, Git

_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_STATUS: dict[bytes, Literal["added", "modified", "deleted"]] = {
    b"A": "added",
    b"M": "modified",
    b"T": "modified",
    b"D": "deleted",
}


def analyse_pr(
    repo: RepoRef,
    pr: int,
    scratch: Path,
    caps: Caps,
    url: str | None = None,
    heartbeat: Callable[[], None] | None = None,
) -> PrResult:
    if not 1 <= pr <= 10_000_000:
        raise AnalysisError("pr_not_found")
    ref = f"refs/pull/{pr}/merge"
    src = url or repo.clone_url
    git = Git(scratch, caps, time.monotonic() + caps.wall_s, heartbeat)
    if git.remote_ref(src, ref) is None:
        raise AnalysisError("pr_not_found")
    target = git.fetch_ref(src, "pr", ref, 2, "--filter=blob:none")
    shas = git.run(target, "rev-parse", "refs/heads/pinned", "refs/heads/pinned^1").split()
    if len(shas) != 2:
        raise AnalysisError("git_failed")
    merge, base = (s.decode("ascii", "replace") for s in shas)
    if not (_SHA.fullmatch(merge) and _SHA.fullmatch(base)):  # validated before they go on an argv
        raise AnalysisError("git_failed")
    # Exact renames only: -M100% compares blob ids, so no blob is ever needed (and none is fetched).
    raw = git.run(target, "diff-tree", "-r", "-z", "--no-commit-id", "-M100%", "--name-status", base, merge)
    changes, truncated = parse_name_status(raw)
    return PrResult(repo=repo.slug, pr=pr, merge=merge, base=base, truncated=truncated, changes=changes)


def parse_name_status(raw: bytes) -> tuple[list[PrChange], bool]:
    """`git diff-tree -z --name-status` output -> changes (at most MAX_PR_PATHS) and whether more were cut."""
    tokens = raw.split(b"\0")
    out: list[PrChange] = []
    i = 0
    while i < len(tokens) and tokens[i]:
        status = tokens[i][:1]
        if status == b"R":
            if i + 2 >= len(tokens) or not tokens[i + 1] or not tokens[i + 2]:
                raise AnalysisError("unparseable")
            old, new = tokens[i + 1], tokens[i + 2]
            path = clean_text(new)
            change = PrChange(path=path, status="renamed", old=clean_text(old), href=github_href(path, new))
            i += 3
        elif status in _STATUS and i + 1 < len(tokens) and tokens[i + 1]:
            raw_path = tokens[i + 1]
            path = clean_text(raw_path)
            change = PrChange(path=path, status=_STATUS[status], href=github_href(path, raw_path))
            i += 2
        else:
            raise AnalysisError("unparseable")
        if len(out) == MAX_PR_PATHS:
            return out, True
        out.append(change)
    return out, False
