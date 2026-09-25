# Security model

**Honest framing:** "zero risk" does not exist. This file defines what we protect, from whom, the controls,
where they live, and how each is tested. Controls not yet built must be marked `[planned]`. Do not claim
"secure" in the README until section 8 is ticked with evidence and an independent review has happened.

## 1. Assets and actors
Assets: server availability and cost; the analysis workers and their host; the result store; visitors' browsers; the repo and release pipeline;
contributor data (names in commits are personal data); the owner's secrets.
Actors: anonymous internet users; abusive scrapers/DoS; **malicious repository authors** (they control every byte the worker parses);
malicious sites targeting visitors (XSS, clickjacking, CSRF); network attackers; compromised or typosquatted dependencies; a contributor who commits a secret.

## 2. Trust boundaries
Browser <-> Caddy <-> API <-> queue <-> worker <-> github.com. Repository content is untrusted at every hop. The result store is trusted only for data the API itself wrote.

## 3. Threats and controls
| # | Threat | Control | Test | Status |
| --- | --- | --- | --- | --- |
| T1 | SSRF / arbitrary clone target | Only `owner/name` accepted; server builds `https://github.com/<owner>/<name>.git` itself; regex + reserved-name checks; no redirects followed to other hosts; worker egress allowlist = github.com (network policy, not just code) | table-driven tests incl. unicode, `..`, `@`, `:`, `%`, whitespace, 10k chars | [done] A1+A2: strict `owner/name` parser on the API (400 `invalid_repo`, table tests incl. URLs, `..`, `@`, `:`, `%`, whitespace, unicode, 10k chars) and again in the worker; URL built server-side; no redirects; worker egress only via CONNECT proxy to `github.com:443` on public IPs |
| T2 | Malicious repo attacks the worker (git hooks, config, submodules, filters, LFS, symlinks, `.gitattributes`) | Bare blobless clone, **no checkout, no working tree**; `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `-c core.hooksPath=/dev/null`, `-c protocol.allow=never -c protocol.https.allow=always`, `--no-tags`, `--no-recurse-submodules`; never run anything from the repo | hostile fixtures in CI | [done] A1: bare clones only (blobless history + depth-1 head), `--no-lazy-fetch`, scrubbed env (no system/global config, no prompts, no credential helper), hooks to /dev/null, https-only protocol allowlist, no submodules. Hostile fixtures: newline/`..`/bidi/ANSI paths, gitlink, symlink, LFS pointer, `.gitattributes` filter, poisoned host config, `ext::`/ssh/git/http URLs (`tests/test_hostile.py`) |
| T3 | Resource exhaustion by huge repos | Caps on pack size, commits, files, path length, memory (cgroup), wall time (kill process group), output size; truncate-and-flag instead of failing open | cap tests; k6 | [done] A1: caps on wall time (process group killed), clone size on disk, commits (most recent kept, flagged), files (most changed kept, flagged), tracked paths, per-blob and total bytes read for line counts (flagged), raw log bytes; container mem/cpu/pids limits. k6: A8 |
| T4 | Worker escape | Separate container: non-root, read-only rootfs, tmpfs scratch with size limit, `cap_drop: ALL`, `no-new-privileges`, seccomp default+, no docker socket, no shared volumes with API, no secrets inside, PID/memory limits, network policy egress github.com:443 only, ephemeral per job | container config tests + manual `docker inspect` review | [partial] A1: worker and egress in their own images, users and networks; worker network `internal` (verified: no DNS, no direct IP, API unreachable); read-only rootfs, capped tmpfs scratch, cap_drop ALL, no-new-privileges, mem/cpu/pids limits, Docker default seccomp, no shared volumes with the API. Not yet: container-per-job (needs an orchestrator), custom seccomp profile, gVisor |
| T5 | Injection through repo-controlled strings (paths, names, messages) | Server: strip control chars/bidi overrides, cap lengths, normalise unicode, never build shell/SQL from them (argv arrays, parameterised queries). Client: `textContent` only, no `innerHTML`, no dynamic `href` except validated GitHub URL builder | fuzz + Playwright XSS payload fixtures | [done] A1-A3: server `clean_text` + schema re-check; client renders repo strings with `textContent` only (build fails on HTML sinks); Playwright injects `<img onerror>` / `<script>` paths and district names and asserts they render as text, run nothing, and cause no CSP violation (`tests/e2e/app.spec.ts`) |
| T6 | Personal data leakage | Never return or log author emails; contributors pseudonymised by default; logs redact IPs after 24 h or hash them; no analytics; result cache contains no email | schema test asserts no `@`-emails in any response | [partial] A1+A2: git never asked for emails; `Contributor N` pseudonyms; tests assert no names/emails in results; client IPs are HMAC'd with a secret key before use and never stored or logged (test). Log retention note: A8 |
| T7 | Data leakage across users | Result ids unguessable (128-bit); no listing endpoint; cache keyed by public `owner/repo@sha` only (public data) | authz tests | [done] A2: job ids are random UUIDv4 (122 bits); no listing endpoint; malformed/unknown ids are 404 (tests); cache keyed by public `owner/repo@sha` only |
| T8 | XSS | CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'`; no inline script/style; Trusted Types policy; no `eval`/`new Function` (also no shader-string `Function` tricks) | CSP violation = failing e2e test | [done] A0: Caddy CSP + `trusted-types 'none'`; e2e proves inline script and innerHTML are blocked; bundle sink check |
| T9 | Clickjacking / MIME / referrer | `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP `same-origin`, CORP `same-origin`, HSTS with preload once stable, `Permissions-Policy` denying everything unused | header tests via `curl -I` in CI | [done] A0: header set asserted by `deploy/check-headers.sh`; HSTS preload deferred until domain is stable |
| T10 | CSRF / CSWSH | State-changing endpoint is JSON-only with `Content-Type` enforced, custom header required, `Origin` allowlist checked; no cookies used for auth; SSE is GET-only and read-only | tests with foreign Origin | [done] A2: POST requires `application/json` (415), `X-Afterglow: 1` (403) and a matching `Origin` when present (403); no cookies; SSE is GET-only (tests) |
| T11 | Abuse / DoS | Per-IP and global rate limits; queue depth cap with `429`/`503` + `Retry-After`; per-repo dedupe (one running job per repo@sha); request size limits; timeouts everywhere; SSE connection caps; edge limits at Caddy/CDN | k6 | [partial] A2: per-client and global token buckets (429 + Retry-After), per-client active-job quota, queue-depth cap (503 + Retry-After), one active job per repo (unique index), 1 KB API body cap + 16 KB edge cap, SSE caps per client/global and 5 min max; Caddy overwrites X-Real-IP (edge test + mutation check). Limits are per API process (one replica today). k6: A8 |
| T12 | Cache poisoning | Cache only worker-produced, schema-validated results; version the schema; key includes sha and analyser version | tests | [done] A1: store keyed by `owner/repo@sha` + analyser version; only schema-valid results written; re-validated on read, tampered files are misses (`tests/test_core.py`) |
| T13 | Host-header / DNS rebinding | Exact `TrustedHost` list; no wildcards (startup validation fails otherwise) | tests | [done] A0: exact TrustedHost list; wildcards rejected at startup (tests) |
| T14 | Info disclosure via errors | Generic error bodies with safe reason codes; no stack traces; docs/OpenAPI disabled in prod; server header removed | tests | [done] A2: fixed reason codes only (`invalid_repo`, `not_found`, `rate_limited`, ...); FastAPI validation errors replaced (they echo input); no docs/OpenAPI in prod; no Server header (tests) |
| T15 | Share-link / URL param abuse | Hash params parsed by a strict schema (numbers with ranges, enums); anything else ignored; never inserted into DOM as HTML | unit + fuzz | [partial] A4: URL hash accepts only bare tokens `#chapter-1`..`#chapter-9` and `#explore` (regex, then bounded by the chapter count); `?quality=` accepts only the three tier names. Full share links (repo + camera + time): A5 |
| T16 | Supply chain | Lockfiles committed; `npm ci --ignore-scripts`; hash-pinned Python requirements; Dependabot; pip-audit/npm audit/Trivy/Semgrep/CodeQL in CI; GitHub Actions pinned to commit SHAs with `permissions: contents: read`; SBOM + build provenance attestation; minimal dependencies, each justified in the PR | CI | [partial] A0: lockfiles, hash-pinned Python, `npm ci --ignore-scripts`, SHA-pinned actions, read-only token, Dependabot, pip-audit, npm audit, Trivy, Semgrep, CodeQL. SBOM + provenance: A8 |
| T17 | Secrets in a public repo | `.gitignore`, `.env.example` only, gitleaks pre-commit + CI, GitHub secret scanning + push protection | CI | [done] A0: gitleaks pre-commit + CI (full history), GitHub secret scanning + push protection |
| T18 | Weak prod config | Startup validation: prod requires HTTPS origins, strong random secrets, debug off; fail closed | tests | [partial] A2: startup fails without a postgresql:// URL and a >= 32-byte IP key; DB role passwords must be >= 32 chars or the DB refuses to initialise; `scripts/dev-env.sh` generates random secrets into a gitignored file. Prod secret manager: A8 |
| T19 | Local CLI (private repos) | Runs entirely offline; produces the same result schema; never uploads; the web app validates the dropped file with the same strict schema and size cap before use | tests | [planned] after A2 |
| T20 | Client-side leakage | No tokens, no localStorage of anything sensitive (only UI prefs), no third-party requests (verify with a Playwright network assertion: only same-origin requests), no `console` dumping of data in prod | e2e | [partial] A3-A4: e2e asserts only same-origin requests; no cookies; no localStorage; sessionStorage holds only the story scroll position (a number) per repo, a UI preference. No console output of data. Fonts self-hosted |
| T21 | WebGL/GPU hostile input | Cap instance counts from server data before allocating buffers; validate array lengths and finite numbers; handle context loss and shader-compile failure with the 2D fallback | tests | [done] A3: client re-validates every result before sizing any buffer (lengths, integer ranges, finite numbers, index bounds; `src/lib/result.ts`); e2e feeds NaN, out-of-range indices and 50,001 files and asserts a clean failure with no render; context loss and shader failure fall back to the 2D table |

## 4. Secure development rules
Allowlist schemas out, strict validation in. Fail closed. No dynamic code. No wildcards. Least privilege for every container and token.
Every security control has a test that fails if the control is removed. Never loosen a test, header or CI gate to get green.

## 5. Logging and privacy
Structured logs with redaction; never log request bodies, headers, or repo contents beyond `owner/repo@sha` and outcome codes. Publish a short privacy note describing exactly what is stored and for how long.

## 6. Deployment
Single public origin behind Caddy (automatic TLS). API and worker on private networks; worker has a separate egress policy.
Postgres is reachable only from the API and worker networks. Two login roles with column-level grants: `afterglow_api`
(insert jobs, read jobs/results) and `afterglow_worker` (update job progress/outcome, insert results); neither can delete
or alter schema (tested in `tests/test_api.py`). Config only via environment/secret manager. Backups of the result store are optional and contain only public-derived data.

## 7. Residual risks we accept (and why)
- Volumetric DDoS: handled by the CDN/provider, not the app.
- A zero-day in git, the kernel or the container runtime: mitigated by sandbox layers and rapid patching, not eliminated. Consider gVisor/Firecracker for the worker if the service becomes popular.
- Supply chain can be reduced, not zeroed.
- GitHub availability/rate limits; anonymous clones may be throttled (degrade gracefully, cache aggressively).
- WebGL fingerprinting is inherent to WebGL; we add no analytics.

## 8. Pre-launch checklist (tick with evidence, link the output)
- [ ] All T1-T21 tests exist and pass; removing a control makes a test fail (spot-check 5 at random)
- [ ] Hostile-repo fixtures cannot exceed caps or leave the sandbox (verify with `strace`/audit log of the worker)
- [ ] `curl -I` shows the full header set; securityheaders.com / Mozilla Observatory grade A+; no `Server` header
- [ ] Browser console has zero CSP or Trusted Types violations across a full walkthrough; network tab shows only same-origin requests
- [ ] ZAP baseline + authenticated-free API scan: no medium or higher
- [ ] k6: rate limits hold, memory flat, queue backpressure works, SSE cap works
- [ ] pip-audit, npm audit, Trivy, Semgrep, CodeQL, gitleaks all clean; full-history secret scan clean
- [ ] SBOM + provenance attached to the release; images pinned by digest
- [ ] Independent review (another person or a paid pentest) completed and findings addressed
- [ ] Privacy note published; no emails anywhere in responses, logs or cache
