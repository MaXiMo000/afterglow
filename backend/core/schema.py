"""The analysis result (docs/PLAN.md section 4). Strict, bounded, `extra=forbid`: the only shape the worker
may write, the API may serve and the store may return (SECURITY T5, T6, T12, T21).

Everything that came from a repository (paths, directory names) is re-checked here for control and bidi
characters, so a bug in the worker's sanitiser cannot leak them to browsers.
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Annotated, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

ANALYSER_VERSION = 2  # 2: files at HEAD come from HEAD's tree (A5 fix)
MAX_PATH = 512
MAX_FILES = 50_000
MAX_DIRS = 2_000
MAX_PEOPLE = 1_000
MAX_COUPLING = 300
MAX_MONTHS = 1_200

# C0/C1 controls, zero-width and bidi controls, BOM. Replaced (not dropped) so tampering stays visible.
_UNSAFE = re.compile("[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")


def clean_text(raw: bytes | str, max_len: int = MAX_PATH) -> str:
    """Make a repository-controlled string safe to store and display as plain text."""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    text = _UNSAFE.sub("\ufffd", unicodedata.normalize("NFC", text))
    return text if len(text) <= max_len else text[: max_len - 1] + "\u2026"


def _safe(value: str) -> str:
    if _UNSAFE.search(value):
        raise ValueError("unsafe characters")
    return value


def _finite(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("not finite")
    return value


SafeStr = Annotated[str, Field(min_length=1, max_length=MAX_PATH), AfterValidator(_safe)]
Count = Annotated[int, Field(ge=0, le=10**9)]
Epoch = Annotated[int, Field(ge=0, le=2**40)]
Index = Annotated[int, Field(ge=0, le=10**6)]
Ratio = Annotated[float, Field(ge=0, le=1), AfterValidator(_finite)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class Truncated(_Strict):
    files: bool  # more files at HEAD than MAX_FILES / cap: only the most changed are included
    commits: bool  # history longer than the commit cap: only the most recent commits were analysed
    sizes: bool  # some or all line counts unavailable (pack or blob size caps)


class Meta(_Strict):
    repo: Annotated[str, Field(pattern=r"^[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$")]
    sha: Annotated[str, Field(pattern=r"^([0-9a-f]{40}|[0-9a-f]{64})$")]
    analyser: Annotated[int, Field(ge=1)]
    generated_at: Epoch
    commits: Count
    files: Count
    people: Count
    span: Annotated[list[Epoch], Field(min_length=2, max_length=2)]
    truncated: Truncated


class Dir(_Strict):
    name: SafeStr
    files: Count
    loc: Count
    last: Epoch
    bus_factor: Count  # authors covering >= 50% of commits touching this district (commit-weighted)
    quiet: bool


class File(_Strict):
    path: SafeStr
    dir: Index
    loc: Count
    birth: Epoch
    last: Epoch
    changes: Count
    changes_12m: Count
    authors: Count
    hot: bool
    dead: bool


class Coupling(_Strict):
    a: Index
    b: Index
    count: Count
    strength: Ratio


class Person(_Strict):
    handle: Annotated[str, Field(pattern=r"^Contributor [0-9]{1,7}$")]
    commits: Count
    areas: Annotated[list[Index], Field(max_length=3)]


class Month(_Strict):
    t: Epoch
    commits: Count
    added: Count


class Insights(_Strict):
    hotspots: Annotated[list[Index], Field(max_length=50)]  # file indices
    bus_factor: Annotated[list[Index], Field(max_length=50)]  # dir indices, riskiest first
    quiet: Annotated[list[Index], Field(max_length=50)]  # dir indices, longest dormant first
    coupling: Annotated[list[Index], Field(max_length=50)]  # coupling indices


class Result(_Strict):
    meta: Meta
    dirs: Annotated[list[Dir], Field(max_length=MAX_DIRS)]
    files: Annotated[list[File], Field(max_length=MAX_FILES)]
    coupling: Annotated[list[Coupling], Field(max_length=MAX_COUPLING)]
    people: Annotated[list[Person], Field(max_length=MAX_PEOPLE)]
    insights: Insights
    timeline: Annotated[list[Month], Field(max_length=MAX_MONTHS)]

    @model_validator(mode="after")
    def _indices_in_range(self) -> Self:
        nd, nf, nc = len(self.dirs), len(self.files), len(self.coupling)
        ok = (
            all(f.dir < nd for f in self.files)
            and all(c.a < nf and c.b < nf for c in self.coupling)
            and all(a < nd for p in self.people for a in p.areas)
            and all(i < nf for i in self.insights.hotspots)
            and all(i < nd for i in self.insights.bus_factor + self.insights.quiet)
            and all(i < nc for i in self.insights.coupling)
        )
        if not ok:
            raise ValueError("index out of range")
        return self
