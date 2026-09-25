# Plan

## 1. Product
Input: a public `github.com/<owner>/<repo>`. Output: a cinematic scroll story, then a free-fly city, and a
short list of **useful** engineering insights. It must be worth using, not just worth looking at.

| Visual | Meaning | Insight it supports |
| --- | --- | --- |
| Building | A file. Height = size (lines) | Where the mass of the codebase is |
| Lit windows | Recent activity (recency-weighted) | What is alive |
| Red beacon | Hotspot: high churn, few authors | Where regressions start |
| Dark, fogged district | Untouched for years | Code nobody dares touch |
| Lanterns | Contributors, roaming files they wrote | Who knows what |
| Arcs between districts | Co-change coupling (files that change together) | Hidden dependencies |
| Time scrubber | Whole history replayed | How the codebase grew and decayed |
| Bus factor per district | People needed to cover most surviving lines | Knowledge risk |

Insights panel: hotspots, bus factor, quiet zones, coupling pairs, growth timeline, "what changed between two dates" (compare mode).

## 2. Architecture
```
Browser (static SPA)  --https-->  Caddy (TLS, CSP, static, rate-limit at edge)
                                     |
                              FastAPI API (no git, no shell, no outbound except job queue)
                                     |  queue (Redis or Postgres SKIP LOCKED)
                              Analysis worker (separate container, sandboxed, egress = github.com only)
                                     |
                              Result store (object storage or disk) keyed by owner/repo@sha
```
- API never runs git. Workers never serve traffic. Different users, different containers, different networks.
- Results are immutable, cached by `owner/repo@head_sha`, stored in Postgres (validated on write and read) and served as
  compact JSON with `ETag` and `Cache-Control: immutable`. No volume is shared between API and worker.
- Private repos: **not supported on the hosted service.** Provide a local CLI (`afterglow scan .`) that produces the same result
  file offline; the user drags it into the page. Tokens never leave the user's machine.

## 3. Tech decisions (change only with a written reason)
| Decision | Reason |
| --- | --- |
| Python 3.12, FastAPI, Pydantic v2, uvicorn | Owner's stack; strict typed schemas at the boundary |
| Worker parses `git log --name-status -z` from a **bare, blobless** clone | Never checks out attacker-controlled files; small and fast |
| Vite + TypeScript strict, no UI framework | Small bundle, direct control of the render loop |
| ~~Three.js~~ **Raw WebGL2 in TypeScript, porting the prototype renderer** (changed in A3, owner may veto) | The prototype already is a complete, working WebGL2 renderer of exactly this look (instancing, planar reflection, HDR bloom, MSAA, tiers). Re-expressing it in Three.js abstractions adds ~150 KB gzip to the first-frame budget and gains no frame time, and GPU picking with PBO readback plus parallel shader compile need raw GL either way. The PLAN's stated condition (Three must be shown to cost frame time) is **not** what drove this: bundle size and reuse did. Revert path: the renderer is one module behind a small interface (`setWorld`, `alloc`, `render`, `pick`) |
| Lenis for scroll smoothing, bundled and version-pinned, wrapped behind our own `ScrollEngine` interface | Solid inertial scroll; replaceable. No GSAP dependency |
| Own tiny timeline + spring utilities | Avoid animation-library weight and licensing questions |
| Fonts self-hosted (Cormorant Garamond, IBM Plex Mono, Instrument Sans; subset, `font-display: swap`) | No third-party origins (CSP) |
| GPU picking via ID buffer | O(1) hover cost regardless of file count |
| Fallback 2D treemap + table | No-WebGL devices, screen readers, print |
| Queue: Postgres `SELECT ... FOR UPDATE SKIP LOCKED` (not Redis) | One stateful service that also holds result metadata. Decided before A1 (owner-approved) |
| Building height from the **current** tree only: one capped, batched blob fetch of HEAD's blobs, read as bytes to count lines, never checked out | A blobless clone has no file contents; lazy per-blob fetches during `git log` are slow and uncappable. History metrics use `--name-status` only. Decided before A1 (owner-approved) |
| Result wire format: strict JSON, compressed by Caddy (zstd/gzip). ~~Binary block for per-file columns~~ dropped in A2 | Measured: 62.5 KB gzip on the wire for 3,139 files, extrapolating to ~1 MB at the 50k-file cap, under the 1.5 MB budget. Revisit only if A3 measures JSON parse time as a frame-budget problem. Owner had approved the binary plan; this reverses it on evidence |
| Metric definitions (A1): hotspot = >= 5 changes in the 12 months before HEAD by <= 3 authors, top 20; quiet = no change in the 2 years before HEAD; bus factor = fewest authors covering >= 50% of commits touching a district; coupling = co-change count / min(changes) over the latest 10k commits, ignoring commits touching > 20 files, min 3 co-changes | Needs no file contents. Bus factor is **commit-weighted, not line-weighted** (blame needs every historical blob); the UI must say so |
| Compare mode categories (A5): added in the window, last changed in the window, still changing after it, untouched since before it. **Removed files are not shown**: the result lists files at HEAD only, and the UI says so | Uses only per-file birth/last-change, which the analysis has; per-window change counts would need a per-file time series (future schema change) |
| Inspector shows real fields only; no per-quarter sparkline or per-author list yet | Not in the result schema; the drawer says so instead of drawing an estimate |
| Effects by tier (A6): simple = none of DOF/flare; balanced = cheap DOF blur + flare ghosts; cinematic = wider DOF + flare + god rays + MSAA. Ripples, heartbeat, trails, shake are off under reduced motion | Keeps the low tier cheap; every effect degrades rather than disappears abruptly |
| Fonts (A7): every face `font-display: optional` and preloaded | A late swap re-wrapped the hero title (CLS 0.29). With `optional` a font that misses the first paint is used from the next load on; no layout shift either way |
| Dynamic resolution (A7): healthy = frame interval at or under the refresh interval; step up after ~10 s steady; measurements restart after each change | rAF intervals never go below 16.7 ms at 60 Hz, so the old 14.5 ms test meant one hitch lowered quality for the whole session |
| Accessibility gate (A7): axe (WCAG 2.2 A/AA) in every UI state, tab order, focus return, reduced motion in e2e | Regressions fail CI; contrast over the WebGL canvas is outside axe's reach, so text sits on its own scrims |
| Visual regression (A6): Linux-only baselines generated by CI (`--update-snapshots=missing`) and gated by a "baselines are committed" step; WebGL canvas masked | GPU output is not pixel-stable across drivers; the UI chrome is |
| Time reference is HEAD's commit time, not wall-clock | Results are reproducible and cacheable by sha |
| Districts = top-level directories; if one holds more than half the files it is split one level deeper | Monorepos (`src/`, `packages/`) still get useful districts |

## 4. API (v1)
- `POST /api/v1/analyses` body `{"repo":"owner/name"}`, headers `Content-Type: application/json` and `X-Afterglow: 1`
  -> `202 {"id","status":"queued"}` (new or deduplicated) or `200 {"id","status":"done"}` if a result under 1 h old exists.
  Errors: `400 invalid_repo`, `403 forbidden`, `413 too_large`, `415`, `429 rate_limited|too_many_jobs`, `503 busy` (+ `Retry-After`). Strict regex
  `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`, not `.`/`..`, no URLs, no other hosts.
- `GET /api/v1/analyses/{id}/events` -> SSE progress (`queued`, `cloning`, `parsing n/N`, `scoring`, `done`, `failed` with a safe reason code).
- `GET /api/v1/analyses/{id}` -> `200` result (schema below), `409 not_ready`, `422 <reason>` for failed jobs, `404` unknown.
  Ids are 32 lower-case hex chars (random UUIDv4). SSE frames: `{"status","stage","n","total"[,"reason"]}`; stages are
  `queued, cloning, counting, parsing, sizing, scoring, done, failed`.
- Result schema (strict, `extra=forbid`, bounded): `meta{repo,sha,generated_at,commits,files,people,span,truncated{files,commits}}`,
  `dirs[]`, `files[] {path,dir,loc,birth,last,changes_12m,authors,hot,dead}`, `coupling[] {a,b,strength}`,
  `people[] {handle,commits,areas}`, `insights{hotspots[],bus_factor[],quiet[],coupling[]}`, `timeline[]`.
- `handle` is a **pseudonym** by default ("Contributor 7"). Never return emails. Public display names only behind an explicit opt-in.
- Hard caps (config, tested): repo pack size, commits (200k), files (50k), path length, wall time (90 s), memory, output size.
  Over the cap -> analyse the most recent N, set `truncated`, and the UI must say so.

## 5. Milestones (each shippable, each has gates; do them in order)
**A0 Bootstrap.** Monorepo, lockfiles, pre-commit (gitleaks), CI (ruff, mypy strict, bandit, pip-audit, pytest; tsc, vitest, npm audit
`--ignore-scripts`, Playwright; CodeQL; Trivy image scan; Semgrep) with SHA-pinned actions and read-only tokens. Caddy + CSP skeleton served over HTTPS locally.
Gate: CI green on a fresh clone.

**A1 Analysis core.** Sandboxed worker, bare blobless clone, parser, metrics (churn, recency, authors, bus factor, coupling, quiet zones), caps,
result store, cache. Tests: golden results on small fixture repos; **hostile fixtures** (huge history, 100k-file commit, path with
newline/`../`/unicode-bidi/ANSI escapes, submodule, symlink, LFS pointer, malicious `.gitattributes`/config, gigantic commit message);
clone timeout/size-cap behaviour. Gate: all pass; no fixture escapes the sandbox or exceeds caps.

**A2 API + SSE + limits.** Endpoints above, per-IP and global rate limits, job quotas, queue backpressure, security headers, request-size limits, generic errors.
Gate: `docs/SECURITY.md` controls T1-T14 have passing tests.

**A3 Frontend foundation.** Renderer port, real-data world builder, tiers + dynamic resolution, GPU picking, async shader compile,
2D fallback, design tokens, self-hosted fonts, CSP with no inline. Gate: renders a real repo at budget on the reference devices.

**A4 Scroll story.** `ScrollEngine`, data-driven chapters, camera rig, velocity effects, chapter keys, reduced-motion path (EXPERIENCE sections 1-2).
Gate: no jank; chapter jump and reverse scroll are seamless; works with wheel, trackpad, touch, keyboard, scrollbar drag.

**A5 Explore.** Camera model, full key map, inspector, compare mode, share link, mini-map, help overlay, palette v2 (EXPERIENCE sections 3-5). Gate: keyboard-only walkthrough of every feature.

**A6 Effects + UI polish.** Motion language, DOF, flares, shake, flow pulses, birth ripples, transitions, empty/error/loading states, visual regression baselines (EXPERIENCE sections 4, 6).

**A7 Accessibility + performance hardening.** axe clean, screen-reader summary, contrast, focus order, real-device profiling, memory leak soak test.

**A8 Security verification + launch.** ZAP baseline, k6 load, dependency and image audit, SBOM + provenance, external review checklist (SECURITY section 8), `v0.1.0`.

## 6. Budgets (requirements; measure on real devices, record results in `docs/PERF-LOG.md`)
| Metric | Budget |
| --- | --- |
| Initial JS gzip (landing + renderer) | <= 400 KB; three.js tree-shaken; everything else lazy |
| Time to first rendered frame | <= 2.5 s on a mid-range Android, 4G |
| Frame rate | 60 fps desktop and recent phones; >= 30 fps on the reference low-end phone; dynamic resolution keeps frame time under 16.6 ms |
| Input latency | camera follows the smoothed scroll value within 1 frame; smoothing settles in <= 150 ms (owner-approved clarification: raw input cannot reach the camera in 1 frame through Lenis lerp); orbit/zoom feels immediate; INP < 200 ms |
| Draw calls / triangles | <= 60 low tier, <= 150 high; buildings instanced |
| Result payload | <= 1.5 MB gzip for a 50k-file repo; typed arrays, not verbose JSON |
| JS heap | <= 300 MB; no growth over a 10-minute soak |
| Layout shift | CLS 0 |
| Idle | Render at low rate or stop when nothing moves and tab is hidden |
Reference low-end device (chosen in A3): a 2023 budget Android phone class (Mali-G57 / Adreno 610 GPU, 4 GB RAM, Chrome), e.g. Samsung Galaxy A14. Not yet measured on hardware: see `docs/PERF-LOG.md`.
