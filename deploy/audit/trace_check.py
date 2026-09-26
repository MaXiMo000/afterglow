"""Read an `strace -f` log of the hostile-repo suite and fail on anything that leaves the sandbox (SECURITY T2-T4).

Checks: programs executed (only python and git plumbing), network (no AF_INET/AF_INET6 connect at all), and file
writes (only under the per-run scratch dir or /dev/null). Prints a summary either way.
"""

import re
import sys
from collections import Counter

EXEC = re.compile(r'execve\("([^"]+)"')
CONNECT = re.compile(r"connect\(\d+, \{sa_family=(AF_\w+)")
OPEN = re.compile(r'openat\([^,]+, "([^"]*)", ([A-Z_|]+)')
WRITE_FLAGS = ("O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND")
ALLOWED_EXEC = re.compile(r"^/usr/(local/)?(s?bin|lib/git-core)/(python3?[.\d]*|git(-[a-z-]+)?)$")
# git's file:// transport runs `sh -c "git-upload-pack '<repo>'"`. Only the test fixtures use file:// (production allows
# https only: test_file_protocol_is_off_by_default), so this exact form, on a scratch path, is the one shell allowed.
FIXTURE_SH = re.compile(r"""execve\("/bin/sh", \["/bin/sh", "-c", "git-upload-pack '/scratch/[^'"]+'",""")

log, scratch = sys.argv[1], sys.argv[2]
execs: Counter[str] = Counter()
families: Counter[str] = Counter()
writes: Counter[str] = Counter()
bad: list[str] = []
for line in open(log, encoding="utf-8", errors="replace"):
    if " = -1 " in line and "execve" in line:
        continue  # PATH lookups that did not run anything
    if m := EXEC.search(line):
        execs[m.group(1)] += 1
        if not ALLOWED_EXEC.match(m.group(1)) and not FIXTURE_SH.search(line):
            bad.append(f"exec {m.group(1)}")
    if m := CONNECT.search(line):
        families[m.group(1)] += 1
        if m.group(1) in ("AF_INET", "AF_INET6"):
            bad.append(f"network connect: {line.strip()[:160]}")
    if (m := OPEN.search(line)) and any(f in m.group(2) for f in WRITE_FLAGS) and " = -1 " not in line:
        path = m.group(1)
        top = path if not path.startswith(scratch) else scratch + "/..."
        writes[top] += 1
        if not (path.startswith(scratch + "/") or path == "/dev/null"):
            bad.append(f"write outside scratch: {path}")

print("programs executed:", dict(execs))
print("connect() families:", dict(families) or "none")
print("file writes by location:", dict(writes))
if not any("git" in e for e in execs):
    bad.append("git never ran: the trace does not cover the suite")
if bad:
    print("FAIL", *sorted(set(bad))[:40], sep="\n  ")
    sys.exit(1)
print("OK: only python/git ran, no network connections, writes only in scratch")
