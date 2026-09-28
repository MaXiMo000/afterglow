# Roadmap (post v0.2)

One feature per PR, in this order. Each ends with: what changed, how it was verified, what was not verified
(CLAUDE.md). Rules that shape every item: no third-party origins, `textContent` only, honest labels for anything
estimated or truncated, keyboard-complete, `prefers-reduced-motion`, 2D fallback, performance budgets in PLAN
section 6. Schema changes are batched into as few analyser bumps as possible (each bump recomputes every cached
result).

Key map after this roadmap (actions must never take a movement key; `src/ui/keymap.test.ts` enforces it):
`U` share, `J`/`K` next/previous hotspot, `X` walk mode, `Y` colour mode, `O` record video, `Z` weather.

| # | Feature | Size | Server | Schema | Decision needed |
|---|---------|------|--------|--------|-----------------|
| 1 | Colour by file type (done) | S | no | no | no |
| 2 | Hotspot tour keys (done) | S | no | no | no |
| 3 | Walk mode (done) | M | no | no | no |
| 4 | Fly-through video export | S | no | no | no |
| 5 | Weather as activity | M | no | no | no |
| 6 | Bus-factor "what if" | M | worker | analyser 5 | no |
| 7 | PR overlay | M | API + worker | new table | no (no new egress, see below) |
| 8 | What changed since last time | M | API | no | no |
| 9 | District drill-down | M | no | no | no |
| 10 | Gallery of featured cities | M | API + maint | new table | which repos |
| 11 | Two cities side by side | L | no | no | no |
| 12 | Interactive embed | M | Caddy | no | **yes: loosens `frame-ancestors`** |
| 13 | Ambient sound | S | no | no | **yes: sound at all; check `autoplay=()`** |

## 1. Colour by file type
- **What:** `Y` cycles colour modes: default (heat) -> file type -> default. Types are the repo's 8 most common
  extensions plus "other" and "no extension"; a legend lists each with its file count.
- **How:** `src/world/build.ts` derives a type index per file from `path` (last `.` after the last `/`, lower-cased,
  max 12 chars, else "other"). The renderer gets one more per-instance float; the building shader picks from a fixed
  10-colour palette in `tokens.ts` (colour-blind-safe, checked with the dataviz validator). Table view gets a
  "type" column; screen-reader summary names the top three types.
- **Honesty:** legend says "by file extension, not language detection".
- **Tests:** unit (extension parsing: dotfiles, `a.b.c`, no extension, unicode); e2e legend + toggle; visual baseline.
- **Perf:** one float per instance; measure frame time before/after (PERF-LOG).

## 2. Hotspot tour keys
- **What:** `J`/`K` fly to the next/previous hotspot (the insights list order), select it, and show a caption:
  "Hotspot 3 of 12: core/app.py, 41 changes in 12 months by 2 people". Wraps around. `N`/`P` are not used: `P` is photo.
- **How:** `app.ts` keeps a tour index; reuses `select(i, true)` (fly-to) and the inspector. Caption uses the
  existing announce region, so screen readers get it too. Reduced motion: jump instead of fly.
- **Tests:** e2e: `J` twice selects hotspot 2, `K` returns to 1, announce text matches.

## 3. Walk mode
- **What:** `X` drops the camera to street height at the current target. Mouse-look with pointer lock (click to
  lock, Esc releases), WASD to walk, Shift to run, Space to jump a floor. Buildings block you: you walk between
  towers, not through them. `X` again flies back up to the orbit view.
- **How:** new `src/ui/walk.ts` (first-person pose -> same `Camera` the renderer already takes). Collision: a
  uniform grid over building footprints from `world.pos` built once per world; per frame test the 3x3 cells around
  the walker, slide along the blocking edge. Keyboard-only users: arrows turn instead of the mouse.
- **A11y:** announce "Walk mode. WASD to walk, arrows to turn, X to leave"; no pointer lock needed to use it;
  reduced motion disables head bob and jump easing.
- **Tests:** unit (collision: cannot enter a footprint, slides along a wall); e2e (enter, move, leave, Esc order:
  pointer lock -> walk mode -> panels).

## 4. Fly-through video export
- **What:** `O` (or a button in photo mode) records a WebM: either one cinematic orbit (12 s) or history playback
  (the whole timeline in 20 s). Caption burned into the last second: repo, sha, "made with Afterglow".
- **How:** `canvas.captureStream(30)` + `MediaRecorder` (browser built-ins, no library). Download the same way
  the PNG export does. Hidden where `MediaRecorder` or VP9/VP8 is unavailable (Safari: offer PNG only, say why).
- **Perf:** recording forces full frame rate; dynamic resolution locked for the clip so the video does not
  flicker between resolutions.
- **Tests:** e2e: recording starts, stops, produces a non-empty `video/webm` blob (Chromium only).

## 5. Weather as activity
- **What:** `Z` toggles weather. Light rain over districts whose changes in the last quarter are in the repo's top
  quartile; low fog over quiet districts (`dirs[].quiet`). Legend: "rain = busiest districts this quarter, fog =
  no changes in 2 years".
- **How:** rain is one instanced particle draw (short line segments, fixed count, e.g. 4k) confined to the
  districts' bounds; fog is a height-limited term in the existing fog shader weighted per district. Data comes
  from `files[].quarters` (analyser >= 3); hidden for older results, with a note.
- **Reduced motion:** static streaks and fog, no falling. Off by default on the Fast tier.
- **Perf:** must stay inside the frame budget on the Balanced tier; measure and log.

## 6. Bus-factor "what if"
- **What:** in Insights, pick "Contributor N"; districts that would drop to zero active maintainers without them
  dim, and a line says "Without Contributor 3, 4 districts (212 files) have no one else with 10%+ of their commits."
- **Data gap:** the result only has each person's top 3 districts and each district's bus factor, not per-district
  shares, so this cannot be computed honestly today.
- **Schema (analyser 5):** `dirs[].owners: [{person, share}]`, the top 5 authors per district by commit share
  (person = index into `people[]`, share 0..1). Still pseudonymous; bounded (2,000 x 5). Batch any other schema
  change planned by then into the same bump.
- **Tests:** golden fixture shares; UI e2e for the sentence and dimming; schema caps.

## 7. PR overlay
- **What:** in the city, "Overlay a PR" takes a number. Buildings the PR touches light up (added = new outline,
  modified = pulse, deleted = ghost), with counts and "PR #123 at <head sha>; compared with its merge base".
- **Egress:** none new. GitHub serves every pull request as the git ref `refs/pull/<n>/head` on `github.com`, which
  the worker already reaches through the egress proxy (allowlist stays `github.com:443`). No GitHub API, so no
  60-requests-per-hour limit and no token. PR titles, authors and descriptions are never fetched.
- **How:** new job kind `pr` (`jobs.kind`, `jobs.pr int`, CHECK 1..10^7). Worker: blobless fetch of
  `refs/pull/<n>/head` plus the analysed default-branch sha, `git merge-base`, `git diff --name-status -M100%` on
  trees only (no file contents). Result: `{repo, pr, head, base, changes: [{path, status}]}`, capped at 3,000 paths
  (truncated flag), paths through `clean_text` + `href` as in analyser 4. Stored in a `pr_results` table with the
  same retention as results. API: `POST /api/v1/analyses/{id}/prs {"pr": n}` -> job id; same rate limits and
  per-client quota as analyses.
- **Server load:** one more small job type in the same queue, same caps (512 MB scratch, 90 s, 1 CPU); trees-only
  fetches are far smaller than a history fetch. Fine for a KVM 1; if PR jobs ever crowd out analyses, give them
  their own quota.
- **Tests:** fixture repo with a `refs/pull/1/head` ref; hostile paths; not-found PR -> `pr_not_found`; roles
  (API cannot write `pr_results`); e2e overlay.

## 8. What changed since last time
- **What:** when a repo has an older stored result, "Changes since <date>" shows new towers glowing, removed ones as
  ghost outlines, grown ones (changes up) pulsing, with counts. Hidden when there is no older result.
- **How:** API `GET /api/v1/analyses/{id}/previous` -> the newest result for the same repo with an older sha from the
  same analyser (or 404). Client diffs by path (and `href`). Retention already keeps results 30 days; the UI says
  "compared with the analysis of <date>", never "last visit" (we store no visits).
- **Tests:** two stored results for one repo; diff unit tests; 404 when only one exists.

## 9. District drill-down
- **What:** double-click a district label (or Enter in the palette on a district) opens it as its own city: its
  sub-folders become districts. A breadcrumb (`repo / core / api`) and Backspace/Esc climb back out.
- **How:** client-only: filter `files[]` by district prefix and re-run `buildWorld` with districts from the next path
  segment. Coupling arcs and insights filtered to the subset. Share links gain an optional validated `d=<index>`.
- **Tests:** build unit test (sub-districts from paths); e2e drill in and out; share link round-trip.

## 10. Gallery of featured cities
- **What:** start page section with 6-12 famous repos, each a small skyline (the badge renderer at a bigger size)
  linking to `/owner/name`.
- **How:** `featured` table (repo, position) managed by the owner via SQL; maint re-queues a featured repo when its
  result is over 7 days old and never prunes featured results. API `GET /api/v1/featured` -> list with badge URLs.
- **Decision:** which repos (licence-neutral: only public repos, names only).

## 11. Two cities side by side
- **What:** `/owner/a/vs/owner/b` shows two islands with shared height and colour scales, and a comparison panel
  (files, commits, hotspots, bus-factor risk, activity per quarter).
- **How:** `buildWorld` gains an offset and a shared normaliser; renderer draws both instance sets. Two analyses
  queued (quota 2 per client already allows it).
- **Perf:** doubles building count; cap each city at 25k files in this mode and say so; measure on Balanced tier.

## 12. Interactive embed (decision needed)
- **What:** `/embed/owner/name` renders the city with minimal chrome for blogs and docs.
- **Security change:** needs `frame-ancestors *` (and no `X-Frame-Options: DENY`) on that route only, a separate CSP
  for it, and `deploy/check-headers.sh` asserting both variants. Embeds cannot start analyses (read-only, newest
  stored result), so a hostile page cannot use them to spend worker time. Requires the owner's explicit OK
  (SECURITY.md T9 changes).

## 13. Ambient sound (decision needed)
- **What:** off by default; a toggle in help. Synthesised with Web Audio (no audio files): a low pad whose brightness
  follows activity at the current time, a soft chime when flying to a hotspot.
- **Check first:** `Permissions-Policy: autoplay=()` may block audio even after a click in some browsers; verify, and
  if it does, relaxing it to `autoplay=(self)` is a header change that needs the owner's OK.
- **A11y:** never on by default, respects a muted state, no information carried by sound alone.
