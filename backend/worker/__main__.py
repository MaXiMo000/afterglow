"""Worker entry point.

- `python -m worker serve`           process jobs from Postgres forever (AFTERGLOW_WORKER_DATABASE_URL)
- `python -m worker owner/name`      analyse one repository into a local result store (--store DIR)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

from core.repo import InvalidRepoError, parse_repo
from core.store import ResultStore
from worker.analyse import analyse
from worker.git import AnalysisError, Caps, Git


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="worker")
    ap.add_argument("repo", help="`serve`, or owner/name of a public GitHub repository")
    ap.add_argument("--store", type=Path, default=Path(os.environ.get("AFTERGLOW_STORE", "store")))
    args = ap.parse_args(argv)
    caps = Caps(proxy=os.environ.get("AFTERGLOW_GIT_PROXY") or None)
    scratch_root = os.environ.get("AFTERGLOW_SCRATCH")  # tmpfs in the container

    if args.repo == "serve":
        from worker.queue import serve

        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
        dsn = os.environ.get("AFTERGLOW_WORKER_DATABASE_URL", "")
        if not dsn.startswith("postgresql://"):
            print("error AFTERGLOW_WORKER_DATABASE_URL must be a postgresql:// URL", file=sys.stderr)
            return 2
        serve(dsn, caps, scratch_root)
        return 0

    try:
        repo = parse_repo(args.repo)
    except InvalidRepoError:
        print("error invalid_repo", file=sys.stderr)
        return 2
    store = ResultStore(args.store)
    try:
        with tempfile.TemporaryDirectory(dir=scratch_root) as tmp:
            sha = Git(Path(tmp), caps, time.monotonic() + caps.wall_s).remote_head(repo.clone_url)
            if sha and (cached := store.get(repo, sha)):
                print(f"cached {repo.slug}@{sha} files={len(cached.files)}")
                return 0
            result = analyse(repo, Path(tmp), caps)
    except AnalysisError as exc:
        print(f"error {exc.reason}", file=sys.stderr)
        return 1
    store.put(repo, result)
    t = result.meta.truncated
    print(
        f"done {repo.slug}@{result.meta.sha} commits={result.meta.commits} files={len(result.files)} "
        f"truncated(files={t.files},commits={t.commits},sizes={t.sizes})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
