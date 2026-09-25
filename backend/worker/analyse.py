"""Turn a public repository's history into a `core.schema.Result`.

Two clones, both bare and capped (docs/PLAN.md section 3):
- history: blobless, full history. Read with `git log --name-status -z --no-renames` only; rename detection
  would need file contents, which a blobless clone does not have (and lazy fetching is disabled).
- head: depth 1, contents of the current tree only, used for line counts. Never checked out.
Commit messages and author emails are never requested from git.
"""

from __future__ import annotations

import time
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from core.repo import RepoRef
from core.schema import (
    ANALYSER_VERSION,
    MAX_COUPLING,
    MAX_DIRS,
    MAX_PEOPLE,
    Coupling,
    Dir,
    File,
    Insights,
    Meta,
    Month,
    Person,
    Result,
    Truncated,
    clean_text,
)
from worker.git import AnalysisError, Caps, Git

YEAR = 365 * 86_400
QUIET_AFTER = 2 * YEAR
HOT_MIN_CHANGES = 5  # changes in the last 12 months
HOT_MAX_AUTHORS = 3  # "few people": distinct authors in the last 12 months
HOT_MAX = 20
COUPLING_WINDOW = 10_000  # most recent commits considered for co-change
COUPLING_MAX_FILES = 20  # commits touching more files are bulk edits, not coupling
COUPLING_MIN_COUNT = 3
_STATUSES = {b"A", b"M", b"D", b"T"}


@dataclass(slots=True)
class Commit:
    time: int
    author: int  # index into the author table; names never leave this module
    changes: list[tuple[bytes, bytes]]  # (status, raw path)


@dataclass(slots=True)
class FileStats:
    last: int
    birth: int
    alive: bool  # latest status seen (newest first) was not a delete
    changes: int = 0
    changes_12m: int = 0
    authors: set[int] = field(default_factory=set)
    authors_12m: set[int] = field(default_factory=set)


def parse_log(
    chunks: object, caps: Caps, tick: Callable[[int], None] | None = None
) -> tuple[list[Commit], bool]:
    """Parse `git log -z --name-status --format=%x00%H%x00%at%x00%an` output, newest first.

    Tokens are NUL-separated; an empty token starts a commit (paths and statuses are never empty). Anything
    that does not fit the expected shape fails closed instead of being guessed at.
    """
    commits: list[Commit] = []
    authors: dict[bytes, int] = {}
    buf = b""
    tokens: list[bytes] = []

    def flush(rec: list[bytes]) -> None:
        if len(rec) < 3:
            raise AnalysisError("unparseable")
        sha, at, name, *rest = rec
        if len(sha) not in (40, 64) or not at.isdigit() or len(rest) % 2:
            raise AnalysisError("unparseable")
        changes = []
        for i in range(0, len(rest), 2):
            status = rest[i].lstrip(b"\n")[:1]
            if status not in _STATUSES:
                raise AnalysisError("unparseable")
            changes.append((status, rest[i + 1]))
        commits.append(Commit(int(at), authors.setdefault(name, len(authors)), changes))

    rec: list[bytes] | None = None
    for chunk in chunks:  # type: ignore[attr-defined]
        buf += chunk
        *tokens, buf = buf.split(b"\0")
        for tok in tokens:
            if tok in (b"", b"\n"):  # record boundary; a lone newline follows a commit with no file changes
                if rec:
                    flush(rec)
                    if tick and len(commits) % 2000 == 0:
                        tick(len(commits))
                    if len(commits) >= caps.commits:
                        if tick:
                            tick(len(commits))
                        return commits, True
                rec = []
            elif rec is None:
                raise AnalysisError("unparseable")
            else:
                rec.append(tok)
    tail = buf.strip(b"\n")
    if tail:
        if rec is None:
            raise AnalysisError("unparseable")
        rec.append(tail)
    if rec:
        flush(rec)
    if tick:
        tick(len(commits))
    return commits, False


def district(path: str, split_top: str | None) -> str:
    parts = path.split("/")
    if len(parts) == 1:
        return "(root)"
    if parts[0] == split_top and len(parts) > 2:
        return f"{parts[0]}/{parts[1]}"
    return parts[0]


def line_counts(git: Git, head: Path, caps: Caps) -> tuple[dict[bytes, int], bool]:
    """Line counts for blobs at HEAD. Returns (counts by raw path, complete?). Binary files count 0."""
    entries: dict[bytes, list[bytes]] = defaultdict(list)
    for rec in git.run(head, "ls-tree", "-r", "-z", "--full-tree", "HEAD").split(b"\0"):
        if not rec:
            continue
        meta, _, path = rec.partition(b"\t")
        _mode, kind, oid = meta.split(b" ")
        if kind == b"blob":  # skips submodule gitlinks; symlinks are blobs holding the target text
            entries[oid].append(path)
    if not entries:
        return {}, True
    oid_file = git.scratch / "oids"
    oid_file.write_bytes(b"\n".join(entries) + b"\n")
    sizes: dict[bytes, int] = {}
    for line in git.run(
        head, "cat-file", "--batch-check=%(objectname) %(objectsize)", stdin=oid_file
    ).splitlines():
        oid, size = line.split(b" ")
        sizes[oid] = int(size)

    wanted = [o for o in entries if sizes.get(o, caps.blob_bytes + 1) <= caps.blob_bytes]
    complete = len(wanted) == len(entries)
    budget, batch = caps.total_blob_bytes, []
    for oid in wanted:
        if sizes[oid] > budget:
            complete = False
            break
        budget -= sizes[oid]
        batch.append(oid)
    counts: dict[bytes, int] = {}
    if batch:
        oid_file.write_bytes(b"\n".join(batch) + b"\n")
        out = git.run(head, "cat-file", "--batch", stdin=oid_file)
        pos = 0
        while pos < len(out):
            nl = out.index(b"\n", pos)
            header = out[pos:nl].split(b" ")
            if len(header) != 3:
                raise AnalysisError("unparseable")
            oid, _, size = header
            body = out[nl + 1 : nl + 1 + int(size)]
            pos = nl + 1 + int(size) + 1
            n = (
                0
                if b"\0" in body[:8000]
                else body.count(b"\n") + (1 if body and not body.endswith(b"\n") else 0)
            )
            for path in entries[oid]:
                counts[path] = n
    return counts, complete


def build_result(repo: RepoRef, sha: str, commits: list[Commit], history_truncated: bool,
                 loc: dict[bytes, int], sizes_complete: bool, caps: Caps) -> Result:  # fmt: skip
    if not commits:
        raise AnalysisError("empty_repo")
    head_t = commits[0].time
    recent = head_t - YEAR
    stats: dict[bytes, FileStats] = {}
    paths_truncated = False
    author_commits: Counter[int] = Counter()
    months: dict[int, list[int]] = defaultdict(lambda: [0, 0])

    for c in commits:  # newest first
        author_commits[c.author] += 1
        dt = datetime.fromtimestamp(c.time, UTC)
        month = months[dt.year * 12 + dt.month - 1]
        month[0] += 1
        for status, path in c.changes:
            s = stats.get(path)
            if s is None:
                if len(stats) >= caps.tracked_paths:
                    paths_truncated = True
                    continue
                s = stats[path] = FileStats(last=c.time, birth=c.time, alive=status != b"D")
            s.birth = min(s.birth, c.time)
            if status == b"A":
                month[1] += 1
            s.changes += 1
            s.authors.add(c.author)
            if c.time >= recent:
                s.changes_12m += 1
                s.authors_12m.add(c.author)

    alive = [(clean_text(p), p, s) for p, s in stats.items() if s.alive]
    alive.sort(key=lambda t: (-t[2].changes, -t[2].last, t[0]))
    files_truncated = len(alive) > caps.files or paths_truncated
    alive = alive[: caps.files]

    tops = Counter(p.split("/")[0] for p, _, _ in alive if "/" in p)
    top, n_top = tops.most_common(1)[0] if tops else (None, 0)
    split_top = top if n_top > len(alive) / 2 else None
    dir_of = {raw: district(p, split_top) for p, raw, _ in alive}
    dir_names = sorted(set(dir_of.values()), key=lambda d: (d == "(root)", d))[:MAX_DIRS]
    dir_index = {d: i for i, d in enumerate(dir_names)}
    alive = [t for t in alive if dir_of[t[1]] in dir_index]
    file_index = {raw: i for i, (_, raw, _) in enumerate(alive)}

    # Hotspots: most changed in the last 12 months, among files few people touched in that period.
    hot_candidates = [
        i for i, (_, _, s) in enumerate(alive)
        if s.changes_12m >= HOT_MIN_CHANGES and len(s.authors_12m) <= HOT_MAX_AUTHORS
    ]  # fmt: skip
    hotspots = sorted(hot_candidates, key=lambda i: -alive[i][2].changes_12m)[:HOT_MAX]
    hot_set = set(hotspots)

    files = [
        File(
            path=path, dir=dir_index[dir_of[raw]], loc=loc.get(raw, 0), birth=s.birth, last=s.last,
            changes=s.changes, changes_12m=s.changes_12m, authors=len(s.authors), hot=i in hot_set,
            dead=s.last < head_t - QUIET_AFTER,
        )
        for i, (path, raw, s) in enumerate(alive)
    ]  # fmt: skip

    # Per-district commit counts by author (each commit counted once per district it touches).
    dir_authors: list[Counter[int]] = [Counter() for _ in dir_names]
    for c in commits:
        for dname in {dir_of[p] for _, p in c.changes if p in file_index}:
            dir_authors[dir_index[dname]][c.author] += 1

    by_dir: list[list[File]] = [[] for _ in dir_names]
    for f in files:
        by_dir[f.dir].append(f)
    dirs = []
    for d, name in enumerate(dir_names):
        members = by_dir[d]
        last = max(f.last for f in members)
        dirs.append(
            Dir(
                name=name,
                files=len(members),
                loc=sum(f.loc for f in members),
                last=last,
                bus_factor=bus_factor(dir_authors[d]),
                quiet=last < head_t - QUIET_AFTER,
            )
        )

    coupling = co_change(commits[:COUPLING_WINDOW], file_index, files)

    ranked_people = [a for a, _ in author_commits.most_common(MAX_PEOPLE)]
    people = []
    for rank, author in enumerate(ranked_people):
        areas = Counter({d: n for d, cnt in enumerate(dir_authors) if (n := cnt[author])})
        people.append(
            Person(
                handle=f"Contributor {rank + 1}",
                commits=author_commits[author],
                areas=[d for d, _ in areas.most_common(3)],
            )
        )

    by_risk = [d for d in range(len(dirs)) if dirs[d].files >= 5]
    by_risk.sort(key=lambda d: (dirs[d].bus_factor, -dirs[d].files))
    quiet = sorted((d for d in range(len(dirs)) if dirs[d].quiet), key=lambda d: dirs[d].last)

    first_month = min(months)
    timeline = [
        Month(t=_month_start(m), commits=months[m][0], added=months[m][1])  # defaultdict fills empty months
        for m in range(max(first_month, max(months) - 1199), max(months) + 1)
    ]

    return Result(
        meta=Meta(
            repo=repo.slug, sha=sha, analyser=ANALYSER_VERSION, generated_at=int(time.time()),
            commits=len(commits), files=sum(s.alive for s in stats.values()),
            people=len(author_commits), span=[commits[-1].time, head_t],
            truncated=Truncated(files=files_truncated, commits=history_truncated, sizes=not sizes_complete),
        ),
        dirs=dirs, files=files, coupling=coupling, people=people,
        insights=Insights(hotspots=hotspots, bus_factor=by_risk[:10], quiet=quiet[:10],
                          coupling=list(range(min(10, len(coupling))))),
        timeline=timeline,
    )  # fmt: skip


def _month_start(m: int) -> int:
    return int(datetime(m // 12, m % 12 + 1, 1, tzinfo=UTC).timestamp())


def bus_factor(counts: Counter[int]) -> int:
    """Fewest authors whose commits cover at least half of the district's commits (0 if no commits)."""
    total, covered = sum(counts.values()), 0
    for k, (_, n) in enumerate(counts.most_common(), start=1):
        covered += n
        if covered * 2 >= total:
            return k
    return 0


def co_change(commits: list[Commit], file_index: dict[bytes, int], files: list[File]) -> list[Coupling]:
    # ponytail: pair counting is O(commits x files_per_commit^2) in memory; bounded by COUPLING_WINDOW and
    # COUPLING_MAX_FILES (<= 1.9M pairs worst case). Switch to a count-min sketch if that ever bites.
    pairs: Counter[tuple[int, int]] = Counter()
    for c in commits:
        idx = sorted({file_index[p] for _, p in c.changes if p in file_index})
        if 2 <= len(idx) <= COUPLING_MAX_FILES:
            for i, a in enumerate(idx):
                for b in idx[i + 1 :]:
                    pairs[(a, b)] += 1
    scored = [
        (n / min(files[a].changes, files[b].changes), n, a, b)
        for (a, b), n in pairs.items()
        if n >= COUPLING_MIN_COUNT
    ]
    scored.sort(key=lambda t: (-t[0], -t[1], t[2], t[3]))
    return [Coupling(a=a, b=b, count=n, strength=min(1.0, s)) for s, n, a, b in scored[:MAX_COUPLING]]


Progress = Callable[[str, int, int], None]  # (stage, n, total); stages match the jobs.stage column


def analyse(
    repo: RepoRef, scratch: Path, caps: Caps, *, url: str | None = None, progress: Progress | None = None
) -> Result:
    """Clone, read and score one repository. `url` overrides the GitHub URL for local test fixtures only."""
    report = progress or (lambda *_: None)
    git = Git(scratch, caps, time.monotonic() + caps.wall_s)
    source = url or repo.clone_url
    report("cloning", 0, 0)
    hist = git.clone(source, "hist.git", "--filter=blob:none")
    try:
        sha = git.run(hist, "rev-parse", "--verify", "HEAD^{commit}").strip().decode("ascii")
    except AnalysisError:
        raise AnalysisError("empty_repo") from None
    report("counting", 0, 0)
    total = min(int(git.run(hist, "rev-list", "--count", "HEAD").strip() or 0), caps.commits)

    def tick(n: int) -> None:
        report("parsing", n, total)

    commits, truncated = parse_log(
        git.stream(hist, "log", "-z", "--no-renames", "--name-status", "--no-color",
                   "--format=%x00%H%x00%at%x00%an", "HEAD"),
        caps,
        tick,
    )  # fmt: skip
    report("sizing", 0, 0)
    try:
        head = git.clone(source, "head.git", "--depth=1")
        loc, complete = line_counts(git, head, caps)
    except AnalysisError as exc:
        if exc.reason not in ("too_large", "clone_failed"):
            raise
        loc, complete = {}, False
    report("scoring", 0, 0)
    return build_result(repo, sha, commits, truncated, loc, complete, caps)
