#!/usr/bin/env python3
"""SECURITY section 8 spot-check: remove one control at a time, run its tests, expect failure, restore."""
import os, subprocess, sys
from pathlib import Path

ROOT = Path.cwd()
M = [
    ("T1 SSRF: owner/name validation", "backend/core/repo.py",
     "    if not _OWNER.fullmatch(owner) or not _NAME.fullmatch(name) or name in (\".\", \"..\"):\n",
     "    if False:\n", "backend", ["python", "-m", "pytest", "-q", "-x", "tests/test_core.py", "tests/test_api.py"]),
    ("T3 resource caps: file cap at HEAD", "backend/worker/analyse.py",
     "    alive = alive[: caps.files]\n", "    alive = alive\n", "backend",
     ["python", "-m", "pytest", "-q", "-x", "tests/test_hostile.py", "tests/test_analyse.py"]),
    ("T5 injection: control/bidi stripping", "backend/core/schema.py",
     '    text = _UNSAFE.sub("\\ufffd", unicodedata.normalize("NFC", text))\n',
     '    text = unicodedata.normalize("NFC", text)\n', "backend",
     ["python", "-m", "pytest", "-q", "-x", "tests/test_core.py", "tests/test_hostile.py"]),
    ("T11 abuse: per-IP token bucket", "backend/app/limits.py",
     "        if b.tokens >= 1:\n", "        if True:\n", "backend",
     ["python", "-m", "pytest", "-q", "-x", "tests/test_api.py"]),
    ("T20 client leakage: nothing in browser storage", "frontend/src/ui/app.ts",
     "    this.lastRepo = `${repo.owner}/${repo.name}`;\n",
     "    this.lastRepo = `${repo.owner}/${repo.name}`;\n    localStorage.setItem('recent', this.lastRepo);\n", "frontend",
     "npm run build >/dev/null 2>&1 && npx playwright test tests/e2e/security.spec.ts -g 'full walkthrough' --reporter=line"),
]
only = sys.argv[1:]
for name, path, old, new, cwd, cmd in M:
    if only and not any(name.startswith(o) for o in only):
        continue
    f = ROOT / path
    orig = f.read_text(encoding="utf-8")
    assert orig.count(old) == 1, (name, "anchor not found")
    f.write_text(orig.replace(old, new), encoding="utf-8", newline="\n")
    try:
        r = subprocess.run(cmd, cwd=ROOT / cwd, capture_output=True, text=True, shell=isinstance(cmd, str), env=os.environ)
        out = (r.stdout + r.stderr).strip().splitlines()
        failed = [l for l in out if l.startswith(("FAILED", "  1) ", "    Error:", "E   "))][:2]
        print(f"{'CAUGHT' if r.returncode else 'MISSED'}  {name}\n        {'; '.join(x.strip()[:150] for x in failed)}")
    finally:
        f.write_text(orig, encoding="utf-8", newline="\n")
