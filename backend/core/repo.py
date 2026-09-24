"""Repository names (SECURITY T1). Only `owner/name` is accepted; the clone URL is always built here."""

from __future__ import annotations

import re
from dataclasses import dataclass

_OWNER = re.compile(r"[A-Za-z0-9-]{1,39}")
_NAME = re.compile(r"[A-Za-z0-9._-]{1,100}")


class InvalidRepoError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class RepoRef:
    owner: str
    name: str

    @property
    def slug(self) -> str:
        """Canonical, lower-cased `owner/name` (GitHub names are case-insensitive): the cache key."""
        return f"{self.owner}/{self.name}".lower()

    @property
    def clone_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}.git"


def parse_repo(raw: str) -> RepoRef:
    # fullmatch, not match: `$` in Python also matches before a trailing newline.
    if not isinstance(raw, str) or len(raw) > 140 or raw.count("/") != 1:
        raise InvalidRepoError("expected owner/name")
    owner, name = raw.split("/")
    if not _OWNER.fullmatch(owner) or not _NAME.fullmatch(name) or name in (".", ".."):
        raise InvalidRepoError("expected owner/name")
    if owner.startswith("-") or owner.endswith("-") or name.lower().endswith(".git"):
        raise InvalidRepoError("expected owner/name")
    return RepoRef(owner, name)
