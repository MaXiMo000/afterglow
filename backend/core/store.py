"""Immutable result store on disk, keyed by `owner/repo@sha` and analyser version (SECURITY T12).

Only schema-valid results are written, and results are re-validated on read, so a corrupted or planted file
is treated as a miss rather than served.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

from pydantic import ValidationError

from core.repo import RepoRef
from core.schema import ANALYSER_VERSION, Result

_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


class ResultStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, repo: RepoRef, sha: str) -> Path:
        # Components are safe as file names: the slug passed parse_repo, the sha is hex.
        if not _SHA.fullmatch(sha):
            raise ValueError("bad sha")
        owner, name = repo.slug.split("/")
        return self.root / owner / name / f"{sha}.v{ANALYSER_VERSION}.json"

    def get(self, repo: RepoRef, sha: str) -> Result | None:
        try:
            raw = self._path(repo, sha).read_bytes()
        except FileNotFoundError:
            return None
        try:
            result = Result.model_validate_json(raw)
        except ValidationError:
            return None
        return result if result.meta.repo == repo.slug and result.meta.sha == sha else None

    def put(self, repo: RepoRef, result: Result) -> None:
        if result.meta.repo != repo.slug:
            raise ValueError("result does not belong to this repo")
        path = self._path(repo, result.meta.sha)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(result.model_dump_json().encode())
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
