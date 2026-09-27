"""Turn a public repository's history into a `core.schema.Result`.

Two clones, both bare and capped (docs/PLAN.md section 3):
- history: blobless, full history. Read with `git log --name-status -z -M100%`: exact renames (same blob id,
  so a pure move) are followed with no file contents; similarity-based detection would need the blobs, which a
  blobless clone does not have (and lazy fetching is disabled).
- head: the analysed commit only (fetched by id, depth 1), used for line counts and the repository's
  `.mailmap` (so one person's spellings of their name count once). Never checked out.
Commit messages and author emails are never requested from git (git reads emails internally to apply the
mailmap; they never reach this process).
"""

from __future__ import annotations

import os
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
    QUARTERS,
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

MAILMAP_BYTES = 1024**2
_STATUSES = {b"A", b"M", b"D", b"T"}


@dataclass(slots=True)
class Commit:
    time: int
    author: int  # index into the author table; names never leave this module
    changes: list[
        tuple[bytes, bytes]
    ]  # (status, raw path); renamed paths are already mapped to the newest name


@dataclass(slots=True)
class FileStats:
    last: int
    birth: int
    alive: bool  # latest status seen (newest first) was not a delete
    changes: int = 0
    quarters: list[int] = field(default_factory=lambda: [0] * QUARTERS)
    changes_12m: int = 0
    authors: set[int] = field(default_factory=set)
    authors_12m: set[int] = field(default_factory=set)


def parse_log(
    chunks: object, caps: Caps, tick: Callable[[int], None] | None = None
) -> tuple[list[Commit], bool]:
    """Parse `git log -z --name-status -M100% --format=%x00%H%x00%at%x00%aN` output, newest first.

    Tokens are NUL-separated; an empty token starts a commit (paths and statuses are never empty). A change is
    `status path`, or `R<score> old new` for a rename. Anything that does not fit the expected shape fails
    closed instead of being guessed at.

    Renames: reading newest first, a rename `old -> new` means every older change to `old` belongs to the file
    now called `new` (or whatever `new` was renamed to later), so those changes are recorded under that name
    and the rename itself counts as a change (M). The file keeps its birth date and history across moves.
    """
    commits: list[Commit] = []
    authors: dict[bytes, int] = {}
    paths: dict[bytes, bytes] = {}  # one bytes object per distinct path: 200k commits repeat the same paths
    renamed: dict[bytes, bytes] = {}  # older path -> newest name of the same file
    buf = b""
    tokens: list[bytes] = []

    def flush(rec: list[bytes]) -> None:
        if len(rec) < 3:
            raise AnalysisError("unparseable")
        sha, at, name, *rest = rec
        if len(sha) not in (40, 64) or not at.isdigit():
            raise AnalysisError("unparseable")
        changes = []
        i = 0
        while i < len(rest):
            status = rest[i].lstrip(b"\n")
            if status.startswith(b"R") and status[1:].isdigit() and i + 2 < len(rest):
                old, new = rest[i + 1], rest[i + 2]
                i += 3
                target = renamed.get(new, new)
                renamed[old] = paths.setdefault(target, target)
                changes.append((b"M", renamed[old]))
                continue
            if status[:1] not in _STATUSES or len(status) != 1 or i + 1 >= len(rest):
                raise AnalysisError("unparseable")
            path = rest[i + 1]
            i += 2
            path = renamed.get(path, path)
            changes.append((status, paths.setdefault(path, path)))
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


def line_counts(git: Git, head: Path, caps: Caps, rev: str = "HEAD") -> tuple[dict[bytes, int], bool]:
    """Line counts for blobs at `rev`. Returns (counts by raw path, complete?). Binary files count 0."""
    entries: dict[bytes, list[bytes]] = defaultdict(list)
    for rec in git.run(head, "ls-tree", "-r", "-z", "--full-tree", rev).split(b"\0"):
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
        # Streamed: one blob (<= caps.blob_bytes) plus one chunk is held at a time, never the whole batch.
        buf = bytearray()
        want: tuple[bytes, int] | None = None  # (oid, size) of the blob being read
        for chunk in git.stream(head, "cat-file", "--batch", stdin=oid_file):
            buf += chunk
            while True:
                if want is None:
                    nl = buf.find(b"\n")
                    if nl < 0:
                        break
                    header = bytes(buf[:nl]).split(b" ")
                    if len(header) != 3 or not header[2].isdigit() or header[0] not in entries:
                        raise AnalysisError("unparseable")
                    want = (header[0], int(header[2]))
                    del buf[: nl + 1]
                oid, blen = want
                if len(buf) < blen + 1:
                    break
                body = bytes(buf[:blen])
                del buf[: blen + 1]
                want = None
                n = (
                    0
                    if b"\0" in body[:8000]
                    else body.count(b"\n") + (1 if body and not body.endswith(b"\n") else 0)
                )
                for path in entries[oid]:
                    counts[path] = n
        if want is not None or buf:
            raise AnalysisError("unparseable")
    return counts, complete


def build_result(repo: RepoRef, sha: str, commits: list[Commit], history_truncated: bool,
                 loc: dict[bytes, int], sizes_complete: bool, caps: Caps,
                 head_paths: set[bytes] | None = None) -> Result:  # fmt: skip
    if not commits:
        raise AnalysisError("empty_repo")
    head_t = commits[0].time
    recent = head_t - YEAR
    stats: dict[bytes, FileStats] = {}
    paths_truncated = False
    author_commits: Counter[int] = Counter()
    months: dict[int, list[int]] = defaultdict(lambda: [0, 0, 0])  # commits, files added, files removed
    head_dt = datetime.fromtimestamp(head_t, UTC)
    head_q = head_dt.year * 4 + (head_dt.month - 1) // 3

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
                gone = path not in head_paths if head_paths is not None else not s.alive
                if status == b"D" and gone:  # its newest change removed it, and it is not at HEAD
                    month[2] += 1
            s.birth = min(s.birth, c.time)
            if status == b"A":
                month[1] += 1
            q = QUARTERS - 1 - (head_q - (dt.year * 4 + (dt.month - 1) // 3))
            if 0 <= q < QUARTERS:
                s.quarters[q] += 1
            s.changes += 1
            s.authors.add(c.author)
            if c.time >= recent:
                s.changes_12m += 1
                s.authors_12m.add(c.author)

    # History cut at the commit cap: files at HEAD not touched in the window still belong in the city. They
    # get changes=0 (which no file inside the window can have) and the window's first date as an upper bound
    # for birth and last change; the UI labels them "before the analysed history" (CLAUDE.md rule 6).
    if history_truncated and head_paths is not None and not paths_truncated:
        window_start = commits[-1].time
        for p in head_paths:
            if p not in stats:
                stats[p] = FileStats(last=window_start, birth=window_start, alive=True)

    # Files that exist now come from HEAD's tree: "newest change was not a delete" is wrong when
    # a side branch edits a file after (by date) it was deleted on main and the merge keeps the deletion.
    exists = (lambda p, s: p in head_paths) if head_paths is not None else (lambda p, s: s.alive)
    alive = [(clean_text(p), p, s) for p, s in stats.items() if exists(p, s)]
    at_head = len(head_paths) if head_paths is not None else sum(s.alive for s in stats.values())
    alive.sort(key=lambda t: (-t[2].changes, -t[2].last, t[0]))
    files_truncated = len(alive) > caps.files or paths_truncated or len(alive) < at_head
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
            dead=s.last < head_t - QUIET_AFTER, quarters=s.quarters if any(s.quarters) else [],
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
        Month(
            t=_month_start(m), commits=months[m][0], added=months[m][1], removed=months[m][2]
        )  # defaultdict fills empty months
        for m in range(max(first_month, max(months) - 1199), max(months) + 1)
    ]

    return Result(
        meta=Meta(
            repo=repo.slug, sha=sha, analyser=ANALYSER_VERSION, generated_at=int(time.time()),
            commits=len(commits), files=at_head,
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


def read_mailmap(git: Git, head: Path, sha: str) -> Path | None:
    """Copy `.mailmap` from the analysed commit into scratch; None if it is missing, not a file or too big."""
    try:
        kind = git.run(head, "cat-file", "-t", f"{sha}:.mailmap").strip()
        size = int(git.run(head, "cat-file", "-s", f"{sha}:.mailmap").strip() or 0)
        if kind != b"blob" or size > MAILMAP_BYTES:
            return None
        data = git.run(head, "cat-file", "blob", f"{sha}:.mailmap")
    except (AnalysisError, ValueError):
        return None
    path = git.scratch / "mailmap"
    path.write_bytes(data)
    return path


Progress = Callable[[str, int, int], None]  # (stage, n, total); stages match the jobs.stage column


def analyse(
    repo: RepoRef,
    scratch: Path,
    caps: Caps,
    *,
    url: str | None = None,
    progress: Progress | None = None,
    heartbeat: Callable[[], None] | None = None,
) -> Result:
    """Clone, read and score one repository. `url` overrides the GitHub URL for local test fixtures only."""
    report = progress or (lambda *_: None)
    git = Git(scratch, caps, time.monotonic() + caps.wall_s, heartbeat)
    source = url or repo.clone_url
    report("cloning", 0, 0)
    hist = git.clone(source, "hist.git", "--filter=blob:none")
    try:
        sha = git.run(hist, "rev-parse", "--verify", "HEAD^{commit}").strip().decode("ascii")
    except AnalysisError:
        raise AnalysisError("empty_repo") from None
    # Trees are part of a blobless clone, so HEAD's file list is available without any file contents.
    head_paths = {
        p
        for p in git.run(hist, "ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD").split(b"\0")
        if p
    }
    report("counting", 0, 0)
    total = min(int(git.run(hist, "rev-list", "--count", "HEAD").strip() or 0), caps.commits)

    def tick(n: int) -> None:
        report("parsing", n, total)

    try:
        head: Path | None = git.fetch_commit(source, "head.git", sha)
    except AnalysisError as exc:
        if exc.reason not in ("too_large", "clone_failed"):
            raise
        head = None
    mailmap = read_mailmap(git, head, sha) if head else None

    # mailmap.blob is emptied so git never looks for HEAD:.mailmap in the blobless clone (a lazy fetch).
    commits, truncated = parse_log(
        git.stream(hist, "-c", "mailmap.blob=", "-c", f"mailmap.file={mailmap or os.devnull}",
                   "log", "-z", "-M100%", "--name-status", "--no-color",
                   "--format=%x00%H%x00%at%x00%aN", "HEAD"),
        caps,
        tick,
    )  # fmt: skip
    report("sizing", 0, 0)
    loc: dict[bytes, int] = {}
    complete = False
    if head is not None:
        try:
            loc, complete = line_counts(git, head, caps, sha)
        except AnalysisError as exc:
            if exc.reason not in ("too_large", "clone_failed"):
                raise
    report("scoring", 0, 0)
    return build_result(repo, sha, commits, truncated, loc, complete, caps, head_paths)
