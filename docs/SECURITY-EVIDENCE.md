# Security evidence (SECURITY.md section 8)

Evidence for the pre-launch checklist, gathered for A8 on 2026-09-26 against commit history up to the A8 PR.
Local runs: Windows 11 laptop, Docker Desktop, the stack from `deploy/compose.yaml`. Every script below is in the repo
and can be rerun; raw ZAP reports are regenerated in `deploy/audit/zap/out/` (not committed).

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | T1-T21 tests exist and pass; removing a control fails a test | **done, with one exception** | See [1](#1-controls-and-mutation-spot-check). T19 (local CLI) was never built, so it has no control to test |
| 2 | Hostile repos cannot exceed caps or leave the sandbox | **done** | See [2](#2-sandbox-audit) |
| 3 | Full header set, no `Server` header; securityheaders.com / Observatory A+ | **partial** | Headers: `deploy/check-headers.sh` (CI). External graders need a public deployment: **not done** |
| 4 | Zero CSP / Trusted Types violations over a full walkthrough; same-origin only | **done** | See [4](#4-browser-walkthrough) |
| 5 | ZAP baseline + API scan: no medium or higher | **done** | See [5](#5-zap) |
| 6 | k6: rate limits, memory flat, backpressure, SSE cap | **done** | See [6](#6-k6) |
| 7 | pip-audit, npm audit, Trivy, Semgrep, CodeQL, gitleaks clean | **done** | See [7](#7-audits) |
| 8 | SBOM + provenance on the release; images pinned by digest | **done** | [v0.1.0](https://github.com/MaXiMo000/afterglow/releases/tag/v0.1.0). See [8](#8-release-supply-chain) |
| 9 | Independent review | **not done** | Needs another person or a paid pentest (owner decision). Suggested scope in [9](#9-independent-review) |
| 10 | Privacy note published; no emails in responses, logs or cache | **done** | See [10](#10-privacy) |

## 1. Controls and mutation spot-check

`python scripts/mutation-spotcheck.py` (repo root, test DB env loaded, stack worker stopped). Five threats drawn at
random with a recorded seed (`random.Random(20260926).sample(...)` → T1, T3, T5, T11, T20). Each control is removed,
its tests run, the file restored:

| Threat | Control removed | Result |
| --- | --- | --- |
| T1 SSRF | `owner/name` validation in `core/repo.py` | caught: `test_invalid_repos[a/.]` did not raise |
| T3 caps | file cap at HEAD in `worker/analyse.py` | caught: `test_huge_commit_is_capped` (the schema's 50,000-file cap also refuses the result) |
| T5 injection | control/bidi stripping in `core/schema.py` | caught: raw `\n`, ESC and U+202E reached the output |
| T11 abuse | per-IP token bucket in `app/limits.py` | caught: `test_rate_limit` got 400s instead of 429s |
| T20 leakage | added `localStorage.setItem('recent', repo)` | caught by the new full-walkthrough test (`"recent"` in localStorage) |

Gap found and closed: nothing tested T20's "no sensitive browser storage" before A8.

## 2. Sandbox audit

`bash scripts/sandbox-audit.sh`: the hostile-repo suite (`backend/tests/test_hostile.py`, 17 tests: hostile paths,
submodules, symlinks, LFS, host git config, giant messages, zip-bomb blobs, pack/history/wall-time caps, protocol
allowlist, no lazy fetch) runs inside the worker image with the compose hardening (read-only rootfs, `cap_drop ALL`,
`no-new-privileges`, pids 128, 1 GB memory, capped tmpfs scratch) plus `--network none`, under `strace -f`.

```
17 passed
programs executed: python 1, /usr/bin/git 168, git-core/git 59, /bin/sh 20, git-upload-pack 20
connect() families: none
file writes by location: /scratch/... 1449, /dev/null 351
OK: only python/git ran, no network connections, writes only in scratch
```

The 20 `/bin/sh` runs are git's `file://` transport (`sh -c "git-upload-pack '<fixture>'"`), which only the fixtures
enable; the checker allows exactly that form on a scratch path. Production allows https only
(`test_file_protocol_is_off_by_default`). The checker (`deploy/audit/trace_check.py`) was self-tested on a synthetic
bad trace: it flags a hook exec, any other shell command, an `AF_INET` connect and a write outside scratch.

Not covered here: the egress proxy path over the real network (tested separately in `tests/test_egress.py`), and
a custom seccomp profile / gVisor (T4 residual risk).

## 4. Browser walkthrough

`frontend/tests/e2e/security.spec.ts`, "full walkthrough": hero → analysis → story → city → search, insights,
mini-map, compare, playback, share link, photo mode + PNG download, table view. Asserts zero `securitypolicyviolation`
events, zero console errors, zero non-same-origin requests, no cookies, empty localStorage, and only numeric values
in sessionStorage. The privacy page has its own CSP test. Runs in CI against the Caddy stack.

## 5. ZAP

`bash scripts/zap-scan.sh`: ZAP 2.17.0 (`ghcr.io/zaproxy/zaproxy@sha256:781a2bda...`), baseline (spider + passive)
and API scan (active rules, from `deploy/audit/zap/openapi.json`, with `X-Afterglow: 1` so rules reach the handlers).

Final run: **no medium or high**. Low: timestamp disclosure (commit times in the demo data and bundle: they are the
data), unexpected content type (HTML for unknown paths: the static site). Informational: cacheability notes.

Found and fixed during the scan:
- **500 after a database restart** (real bug): the API pool handed out dead connections (`AdminShutdown`). Now it
  validates connections on checkout; `test_database_restart_does_not_surface_as_500` kills the API's sessions.
- Medium 10202 "absence of anti-CSRF tokens" on `<form method="dialog">` (a close button that never sends a request;
  there are no cookies). Replaced with a plain button rather than suppressing the rule.
- Caddy `default_sni`: Java clients send no SNI for `localhost`; they now get the site certificate.

## 6. k6

`bash scripts/load-test.sh` (k6 2.2.0, `grafana/k6@sha256:9bd01d69...`). Each client is a container with its own
fixed IP on the edge network (Caddy sets `X-Real-IP` from the socket; it cannot be spoofed):

| Check | Result |
| --- | --- |
| 15 POSTs from one client in a burst | first 10 reach the API (400 for the invalid name), then 429 with `Retry-After` |
| 6 concurrent SSE streams, one client | 4 held open, 2 refused with 429 |
| 30 clients × 3 POSTs, worker stopped | exactly 50 jobs queued (`MAX_QUEUE`), later clients 503 with `Retry-After`, per-client cap 429 |
| 40 req/s mixed traffic for 3 min | no 5xx; p95 38 ms; API memory 40.5 → 41.3 MiB (flat) |

## 7. Audits

On main at `0076637` (runs [ci](https://github.com/MaXiMo000/afterglow/actions/runs/36201736438),
[security](https://github.com/MaXiMo000/afterglow/actions/runs/36201736455)): pip-audit (strict, hash lock), npm audit
(low and up), Trivy (images + config, HIGH/CRITICAL), Semgrep (default, python, typescript, dockerfile), CodeQL
(python, javascript-typescript, actions; security-extended) and gitleaks (full history) all pass. GitHub: 0 open
code-scanning, 0 secret-scanning and 0 Dependabot alerts on 2026-09-26.

## 8. Release supply chain

`.github/workflows/release.yml` on a `v*` tag (tag must be on main):
- frontend bundle tarball; images built and pushed to `ghcr.io/<owner>/afterglow-{api,worker,egress}`, recorded by
  digest in the release notes (pin the digest, not the tag); Trivy gate re-run on the pushed images;
- CycloneDX SBOMs: frontend (`npm sbom`, runtime deps), backend (Trivy over the hash lock: 17 packages, checked
  locally), and each image (Trivy: ~106 components for the API image); the job fails if any SBOM is empty;
- build provenance (`actions/attest-build-provenance`, Sigstore) for every release file and each image digest,
  pushed to the registry; `SHA256SUMS`.

**v0.1.0** (2026-09-26, commit `82877d2`, [release](https://github.com/MaXiMo000/afterglow/releases/tag/v0.1.0)):
SBOMs with 106 (api), 89 (egress), 18 (backend lock) and 4 (frontend) components, plus the worker image SBOM;
`SHA256SUMS` checks out; `gh attestation verify` passes for the frontend tarball and for
`ghcr.io/maximo000/afterglow-api@sha256:84d237d7...` (provenance v1, signer `release.yml@refs/tags/v0.1.0`); all
three images pull anonymously by digest. The first run failed at the image attestations (the job logged out of
ghcr.io too early, fixed in #24); no release had been created, so the tag was moved to the fixed commit.

## 9. Independent review

Not done. Suggested scope for a reviewer: the worker sandbox and git invocation (`backend/worker/git.py`), the
egress proxy (`backend/egress/`), API limits and CSRF (`backend/app/api.py`, `limits.py`), the CSP / Trusted Types
setup (`deploy/Caddyfile`, `frontend/`), and the residual risks in SECURITY.md section 7.

## 10. Privacy

Published at `/privacy.html` (`frontend/privacy.html`), linked from the hero. Backed by:
- **new in A8**: finished jobs no longer keep the client pseudonym (DB trigger `jobs_forget_client`, all paths;
  `test_finished_jobs_forget_the_client`); service logs capped at 3 × 10 MB per service (compose `logging`);
- no emails: result schema and tests (T6); on the live stack after real analyses of pallets/flask and fastapi/typer,
  0 email-shaped strings in the result cache, 0 in all service logs; the committed demo result has none;
- no access log in Caddy; the API runs with `--no-access-log`; the raw IP is never stored (test).

Existing databases created before A8 need the trigger added once (the `jobs_forget_client` block of
`deploy/db/schema.sql`, as the database owner); new databases get it at init.
