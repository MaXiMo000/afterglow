# Changelog

Release notes with SBOMs and provenance are on the [releases page](https://github.com/MaXiMo000/afterglow/releases).
Versions come from the git tag (`v*`); the package manifests stay at `0.0.0`.

## Unreleased

- Streets: districts are laid out as blocks of 3 x 3 lots with roads between them (kerbs, centre lines and
  streetlights at the crossings).
- Walk (`X`, or the Walk button) starts on a street crossing in the district you are looking at, at street height.
  An on-screen pad walks, turns and sidesteps while held, for touch and mouse. The islands' edges stop you; you can
  no longer walk out over the water. The finding-to-finding tour moves to the More menu as "Tour the findings" (`9`).
- Trees and houses are real low-poly models (trunk and layered crown; walls, lit windows and a pitched roof)
  instead of reshaped boxes. Cranes are smaller and stand at the building's corner; the scaffolding grid is gone.
- Less visual noise: half the film grain, and fireflies near the camera stay small.
- Living City: buildings take a style that says what kind of file they are, from the path, size and dates only.
  Test files are trees and test-heavy districts become parks, docs are houses, generated or vendored files are
  warehouses, the largest source files are glass towers, old untouched files are brick, files changed in the last
  14 days carry a crane (up to 24), and files untouched for two years grow vines. Streets get lamps. `8` shows the
  city key with counts (open by default, folded on small screens; closing it is remembered on the device), and a
  button inside it switches to plain boxes.
- Guided walk (`9`, or the Walk button): scroll, swipe or use the arrow keys to walk at street level from finding to
  finding (hotspots, the biggest park, a quiet district, a crane site), with a caption and the inspector at each stop.
  `J`/`K` jump between stops, Esc leaves.
- Easier to get around: the city moves like a map (drag to move with momentum, right-drag or a modifier to turn and
  tilt; two fingers pinch, twist and move on touch), held keys ease in and out instead of stepping, and on-screen
  buttons zoom, turn, tilt and return home.
- Clearer UI: toolbar buttons have icons, the less frequent actions (share, badge, photo, another repository) sit in
  a More menu, and help leads with getting around and the most used keys, the rest under "All shortcuts".
- Phones and tablets: icon-only toolbar on narrow screens, panels as bottom sheets, a compact layout for short
  (landscape) screens, safe-area insets for notches and home indicators, and larger touch targets.
- Repository: internal planning notes are no longer published; added SECURITY.md, CONTRIBUTING.md and .env.example.
  The default start-page gallery lists well-known projects.
- Touch: every mode a key turns on now has an on-screen way off. Legends (PR, changes since, what-if, weather,
  file types, compare dates, side by side) have a close button; walk mode, recording and a district opened as a city
  show a "Leave walk mode" / "Stop recording" / "Climb out" button under the place name.
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
  - Compare mode counts removed files. Result size grows ~14% (measured), within budget.
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
