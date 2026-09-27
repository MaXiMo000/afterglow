# Changelog

Release notes with SBOMs and provenance are on the [releases page](https://github.com/MaXiMo000/afterglow/releases).
Versions come from the git tag (`v*`); the package manifests stay at `0.0.0`.

## Unreleased

- Retention: a new `maint` service deletes finished job records after 7 days, and cached results once they are over
  30 days old and nobody has asked for that commit in the last 7 days. **Upgrading:** run `scripts/dev-env.sh` (adds
  `AFTERGLOW_DB_MAINT_PASSWORD`), then apply `deploy/db/upgrades/0002-retention.sql` (see `docs/DEPLOY.md`).
- Database roles have statement and idle-transaction timeouts.
- API: results are re-validated off the event loop (a 50k-file result blocked it for ~0.2 s); IPv6 clients are
  rate-limited per /64; progress-stream slots can no longer leak.
- Release: images are scanned before they are pushed.

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
