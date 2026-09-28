# Changelog

Release notes with SBOMs and provenance are on the [releases page](https://github.com/MaXiMo000/afterglow/releases).
Versions come from the git tag (`v*`); the package manifests stay at `0.0.0`.

## Unreleased

- Two cities side by side (`7`, or `?vs=owner/name`): compare two repositories on neighbouring islands, one calendar,
  one height scale, with a comparison panel.
- Ambient sound (`?` panel, off by default): a synthesised pad that follows the history's activity and a chime on the
  hotspot tour. No audio files; nothing plays until you turn it on; no header change.
- Embeddable city: `/embed/owner/name` shows the newest stored analysis in an iframe on any https site ("Copy embed
  code" in the `?` panel). Only that page may be framed; everything else keeps `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`.
- Featured cities on the start page: a strip of skyline tiles (`AFTERGLOW_FEATURED`, up to 12), kept fresh by the
  API when the queue is idle.
- District drill-down (`Enter`, or the inspector button): open a district as its own city of sub-folders, drill again,
  `Backspace` climbs out.
- Fixed: Enter or other keys that close a dialog (the search palette) no longer also act on the city.
- What changed since the previous analysis (`6`): new files glow green, files changed again glow cyan, removals are
  counted; compares with the newest earlier analysis stored on the site.
- The hint line hides while a building is selected, so the place caption (and the hotspot tour line) never overlap it.
- PR overlay (`N`): enter an open pull request's number and the buildings it changes light up (deleted ones in red),
  from GitHub's test merge through the existing github.com-only egress (file names only). **Upgrading:** apply
  `deploy/db/upgrades/0004-pr-overlay.sql` before starting the new containers (see `docs/DEPLOY.md`).
- Bus-factor "what if" (Insights, Bus factor): pick a contributor and the districts nobody else knows go dark.
  Analyser 5 (`dirs[].owners`, top 5 authors per district by commit share); cached results are recomputed.
- Weather (`Z`): rain over the busiest districts of the last 12 months and low haze over quiet ones, with a legend
  that says exactly that.
- Video export (`O`, or photo mode): record a 12 s orbit or the whole history in 20 s as a WebM, captioned like the
  PNG poster. Recorded entirely in the browser.
- Walk mode (`X`): explore the city on foot at street level with W A S D and mouse or arrow-key look; buildings
  block the way and you slide along walls.
- Hotspot tour: `J` / `K` fly to the next / previous hotspot with a caption of why it is hot.
- Colour by file type (`Y`): buildings take their extension's colour, with a legend of the 8 most common types and
  their counts; the inspector and the table gain a Type column.
- Keys: Share moved from S to U, so S walks backward again (S was swallowed by Share). A unit test keeps actions
  off movement keys.
- Queue: a queued job shows an estimated wait next to its position, from the median run time of recent jobs and the
  number of live workers, labelled an estimate. **Upgrading:** apply `deploy/db/upgrades/0003-queue-wait.sql` before
  starting the new worker (see `docs/DEPLOY.md`).
- README badge: `GET /api/v1/badges/owner/name.svg` draws a small skyline of the repository's most-changed files from
  its newest stored analysis (never starts one); the city's Badge button copies the Markdown.
- Fixed (analyser 4; cached results are recomputed): "Open on GitHub" 404ed for paths the display form changed, such
  as decomposed (NFD) Unicode names written by macOS; the link now uses the real path. Compare mode's "Removed in
  this window" count is exact instead of rounded to whole months.

- Retention: a new `maint` service deletes finished job records after 7 days, and cached results once they are over
  30 days old and nobody has asked for that commit in the last 7 days. **Upgrading:** run `scripts/dev-env.sh` (adds
  `AFTERGLOW_DB_MAINT_PASSWORD`), then apply `deploy/db/upgrades/0002-retention.sql` (see `docs/DEPLOY.md`).
- Database roles have statement and idle-transaction timeouts.
- API: results are re-validated off the event loop (a 50k-file result blocked it for ~0.2 s); IPv6 clients are
  rate-limited per /64; progress-stream slots can no longer leak.
- Progress: streams are woken by a database notification when their job changes instead of polling three times a
  second, and a queued job shows how many jobs are ahead of it. The notification trigger ships in
  `0002-retention.sql` too.
- Link previews: a new preview image made for chat apps (words inside the centre square that WhatsApp crops to,
  baseline JPEG, 91 KB), `og:image:type`/`secure_url`/alt tags, and a cache-busting `?v=` so apps that cached the old
  image fetch the new one. `npm run og-image` regenerates it; an e2e test guards the tags, size and format.
- Analysis (analyser 3; cached results are recomputed on the next request):
  - Moved and renamed files keep their history (exact renames, detected from blob ids with no file contents).
  - The repository's `.mailmap` is applied, so one person with two name spellings counts once in bus factor.
  - On histories past the commit cap, files untouched in the analysed window stay in the city, labelled "before".
  - Changes per quarter for the last two years, shown as a sparkline in the file inspector, with a "heating up" /
    "cooling down" trend there, in the hotspot list and in the screen-reader summary.
  - Compare mode counts removed files. Result size grows ~14% (measured, `docs/PERF-LOG.md`), within budget.
- Clean links: `afterglow.example/owner/name` opens that repository's story, and the address bar follows the loaded
  repository, so a copied URL is shareable as is.
- Release: images are scanned before they are pushed.
- Worker: all clones of a job share one 512 MB scratch budget and line counts are streamed, so a large repository can
  no longer exhaust the worker's memory; a heartbeat during git calls lets a dead worker's job fail after 90 s
  instead of 3 minutes; line counts come from the analysed commit itself (fetched by id), not whatever HEAD is later.
- Health: the worker container has a health check, and `/readyz` reports a down database or a stalled queue (a job
  left running by a crashed worker does not hide it; the answer is cached for 5 s). Docker Engine 25+ is required.
- Frontend: the scene renders at 30 fps when nothing but ambient animation moves (full rate on input) and not at all
  behind the table view; fewer per-frame allocations; plain messages for every server error code; no broken "Open on
  GitHub" link for paths that were cleaned up for display.

## v0.2.0 (2026-09-27)

- Default graphics: cinematic on desktops, balanced on phones and low-core devices; Graphics setting
  (Auto/Fast/Balanced/Cinematic) in the help panel.
- City: distant coastline skyline mirrored in the water, red aviation lights on tall towers, slow window glow, contact
  shadows and lit parapets.
- Navigation: browser Back, Esc and Backspace step out from city to story to start page; the logo links home.
- Link previews (Open Graph and Twitter card), SVG/PNG favicons and apple-touch icon.
- Responsive layout from 320 to 1920 px; Share button in the city toolbar.
- Fixed: a frozen story chapter showed half-grown glowing buildings; canvas blinks on load; the story snapping back a
  chapter; camera shake and drift near hotspot beams.
- Fixed: `scripts/build-frontend.sh` is executable; the API health check works on every deployment.
- `scripts/build-frontend.sh` fills link-preview URLs from `AFTERGLOW_PUBLIC_ORIGIN` (or `AFTERGLOW_SITE_URL`).

## v0.1.0 (2026-09-26)

First release: repository analysis worker, scroll story, explorable city, 2D table fallback, accessibility and
performance gates, and the release supply chain (CycloneDX SBOMs, build provenance, images by digest).
