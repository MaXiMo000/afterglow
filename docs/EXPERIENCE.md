# Experience spec: scroll, camera, input, animation, UI

Goal: the site should feel like a short film you can steer. Every interaction has weight, inertia and feedback.
The original design prototype set the look; this document lists what the product must do better than it.

## 1. Scroll engine (`ScrollEngine`)
- Inertial smooth scroll (Lenis or equivalent, bundled). Tuned so it is **fast and responsive**, not floaty:
  wheel multiplier ~1.0-1.3, lerp ~0.12-0.16, touch handled natively with momentum. Expose these as config and tune by feel on a trackpad, a mouse wheel and a phone.
- Story length ~450-550vh (the prototype's 820vh was too long). Each chapter has a scroll window; windows overlap slightly for cross-fades.
- **Scroll velocity is an input** to the render: FOV kick (+2-4 degrees at speed), chromatic aberration and streak/motion-blur scale with velocity, beams lean, lanterns stretch.
  Clamp and smooth so it never causes nausea. Disabled under `prefers-reduced-motion`.
- Optional soft snap to chapter centres when the user stops (off while dragging the scrollbar; off with reduced motion).
- Keys in story: `Space`/`PageDown`/`J` next chapter, `Shift+Space`/`PageUp`/`K` previous, `Home`/`End`, `1-6` jump. Chapter rail is clickable and animates with an eased scroll (600-900 ms, cancellable by any wheel/touch).
- Reverse scroll must be perfectly symmetric: the whole story is a pure function of scroll position (no time-based one-shots inside the scrubbed range).
- Scroll position restores on reload and on returning from explore. Deep links: `#chapter-3`, `#explore` (only bare tokens; see share link in section 5).
- Scroll hijack rules: never trap the user; always show progress and a skip control; native scrollbar stays usable; text remains selectable.

## 2. Story camera rig
- Camera path = Catmull-Rom (or better: centripetal) spline with per-key FOV, roll, focus distance and easing, authored in data, not code.
- Handheld micro-motion (low-frequency noise), parallax from pointer/gyro (small, damped), cursor-driven look-around within limits.
- Chapters are **data-driven from the real analysis**: first commit, biggest growth spurt, top hotspot, longest-dormant district, lowest bus factor. If a repo lacks one, skip or substitute; never fabricate a chapter.
- Cinematic beats: focus pulls (DOF) onto the subject, subtle light changes per chapter (warm at first light, colder in quiet zones, hot red near hotspots), callouts that draw in with a line-trace animation and track the 3D anchor without jitter.

## 3. Free camera (explore)
- Orbit with **inertia** (release velocity carries and decays), pan (right-drag / two-finger / Shift-drag), dolly.
- **Zoom toward the cursor** (wheel, trackpad pinch, touch pinch): the point under the cursor stays under the cursor. Smooth, exponential, with min/max distance and ground clamp so the camera never enters buildings or the water.
- Double-click/double-tap: fly to and frame the object (eased, 700-1000 ms, cancellable). `F` frames the selection, `H` home, `R` resets view.
- View presets `1` overview, `2` street level, `3` top-down, `4` skyline, `5` cinematic auto-orbit. Preset transitions are eased flights, not cuts.
- Camera never clips; never flips at the poles; roll is always level unless a chapter authors it.

## 4. Keyboard and gestures (must all work, be discoverable via `?` overlay, and be listed in the palette)
| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `W A S D` / arrows | Move/orbit | `Q E` | Rotate |
| `+ -` / wheel / pinch | Zoom | `Shift` | Faster (x2) |
| `F` | Frame selection | `H` / `R` | Home / reset |
| `1`-`5` | View presets | `Space` | Play / pause history |
| `[` `]` | Slower / faster playback | `,` `.` | Step time back / forward |
| `T` | Toggle timeline | `C` | Compare mode (pick two dates) |
| `/` or `Cmd/Ctrl+K` | Search / palette | `I` | Insights panel |
| `P` | Photo mode | `M` | Mini-map |
| `G` | Toggle coupling arcs | `L` | Toggle lanterns |
| `?` | Help overlay | `Esc` | Back out one level (palette, photo, selection, explore) |
Gamepad not required. All controls need visible focus states and tooltips with the key.

## 5. Features that make it useful
- **Inspector drawer** for a selected file: path, size, created, last change, changes per quarter sparkline, authors (pseudonymous), coupled files, "open on GitHub" link (validated `https://github.com/<owner>/<repo>/blob/<sha>/<path-encoded>`).
- **Compare mode**: two dates -> show added / removed / heated / cooled buildings with a legend and counts.
- **Mini-map** with district labels and camera frustum; click to fly.
- **Share link**: URL hash encodes repo + camera + time as strictly validated numbers/enums (never free text). Loading a link re-validates everything.
- **Export**: PNG poster from photo mode (client-side canvas, includes repo name and a "simulated/sampled" note if applicable). No upload.
- **Palette v2**: fuzzy search files, districts, people (pseudonyms), actions, and recent items; keyboard-only; ARIA combobox pattern.
- **Data honesty strip**: shows repo, commit SHA, generated time, and any truncation ("analysed the latest 200,000 commits").

## 6. Animation and effects catalogue (build behind the quality tiers)
Signature: dusk atmosphere, reflective water, soft bloom, volumetric beams, glowing windows, drifting fireflies.
Add:
- Building **birth ripple** (a ring on the water + pad pulse) when time passes a file's creation; **death fade** as windows go dark.
- **Commit-flow pulses**: light packets travelling along coupling arcs at a rate proportional to real co-change strength.
- **Depth of field** driven by focus distance (bokeh on high tier, cheap blur on medium, off on low).
- **Lens flare + god-rays** from the moon; **wet-glass/rain** optional chapter effect on quiet zones (off on low).
- **Camera shake** (very small) when passing hotspot beams; heartbeat pulse on the hottest beam; all off under reduced motion.
- **Hover lift**: the hovered building rises slightly and its windows brighten; selection ring on the pad; neighbours dim.
- Lantern **trails** that fade; lanterns cluster visibly around low-bus-factor districts.
- TAA-lite or MSAA where affordable; filtered water normals so glints never shimmer into noise (a prototype bug).
- Silky transitions between modes (hero -> loading -> story -> explore -> photo): shared elements morph, panels slide with springs, nothing pops.
- **Loading is a scene, not a spinner**: real SSE progress drives the city un-building/rebuilding with truthful log lines.
- Micro-interactions on every control (press, hover, focus, success); spring-based, 120-220 ms, interruptible.

## 7. Visual design system
- Tokens for colour (ink, mist, dusk, amber, coral, moss, sky), type scale, spacing (4-px grid), radii, shadows, motion (durations and easings), z-layers. One source of truth (CSS variables generated from a TS/JSON tokens file).
- Typography: Cormorant Garamond (display, italic accents), IBM Plex Mono (data, labels), Instrument Sans (body). Tabular numerals for all figures.
- Panels: glass with a hairline border, restrained blur (blur is expensive: budget it, fall back to solid on low tier).
- Text over 3D always has a scrim or shadow that keeps contrast >= 4.5:1.
- Layouts verified at 360, 390, 768, 1024, 1440, 1920, ultrawide, and landscape phones; safe-area insets honoured.
- Dark theme only, by design; document that choice.

## 8. Accessibility
- Fully keyboard-operable; logical focus order; visible focus; focus trapped in dialogs and returned on close.
- `prefers-reduced-motion`: no smooth-scroll hijack, no shake/flash/velocity effects, chapters as static cards with camera crossfades.
- Screen readers: an off-canvas semantic summary (repo, size, top hotspots, quiet zones, bus factor table) and a full 2D table/treemap view (`View as table`). Live region announces selection.
- Never colour alone (hot = beacon + label + icon). Flashing below 3 per second. Text scalable to 200%.
- axe-core clean in CI; manual screen-reader pass before launch.

## 9. Performance behaviours that protect the feel
- Dynamic resolution: adjust render scale continuously (0.6-1.0 x tier DPR) to hold 16.6 ms; step tiers only for sustained misses; hysteresis on the way up.
- Async shader compile (`KHR_parallel_shader_compile`) behind the hero so first paint is never blocked; warm every program before it is needed.
- Render on demand: pause when hidden; drop to a low rate when nothing moves; wake instantly on input.
- No per-frame allocation in hot paths; typed arrays and pooled vectors; no layout reads in the frame loop; all DOM updates batched and only when values change.
- GPU picking (ID pass at low res, read one pixel, async via PBO) instead of CPU projection.
- LOD: far districts merge to impostors; far windows fade to a texture.
- Test on real hardware: one low-end Android, one mid-range Android, one recent iPhone, one integrated-GPU laptop, one desktop GPU. Record numbers.
