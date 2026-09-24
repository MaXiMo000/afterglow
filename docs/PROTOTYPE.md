# The reference prototype

`prototype/dist/afterglow.html` is a single-file, library-free WebGL2 build. Source in `prototype/src/`
(`world.js` generation, `gl.js` renderer + GLSL, `app.js` modes/camera/UI, `style.css`, `body.html`).
Build: `python3 prototype/build.py`. **It is a visual and interaction reference, not a foundation to extend.**

## What it proves
- The look: dusk sky, planar-reflected water, instanced buildings with procedural lit windows, additive beams,
  fireflies/lanterns, bloom, ACES, grain, vignette. One draw call for all buildings.
- The story: hero -> loading -> 6 scroll chapters driven by a Catmull-Rom camera path -> free explore.
- Explore tools: orbit/zoom/pan, hover tooltip, click-to-fly, insights panel (hotspots / bus factor / quiet),
  timeline scrubber with sparkline, command palette (`/`), photo mode, quality tiers with auto-downgrade.

## Known problems (fix in the real build)
| Area | Problem |
| --- | --- |
| Data | Everything is simulated from a hash of the repo name. Real data must replace `world.js`. |
| Security | Inline `<script>`/`<style>`, Google Fonts (third party), no CSP. Not acceptable for production. |
| Scroll | Native scroll with a single exponential smoothing. Feels floaty at speed; no velocity effects, no snap, no chapter keys. Story is 820vh: too long. |
| Zoom/orbit | Wheel zoom is toward the target, not the cursor. No inertia on orbit. No double-click focus, no view presets. |
| Picking | CPU screen-space projection of every file per mouse move. Replace with a GPU ID buffer. |
| Water | Specular glint aliases into noise at distance; needs filtered normals / roughness by distance. |
| Quality | Discrete tiers only. Add dynamic resolution scaling. Shader compile blocks the main thread on first load. |
| Effects | No depth of field, no lens flare, no camera shake, no commit-flow pulses along coupling curves, no birth ripples. |
| UI | Functional but plain: no design system, no motion language, no help overlay, no mini-map, no compare mode, no share link. |
| A11y | No screen-reader city summary, no 2D fallback, focus handling in the palette is basic. |
| Tests | None besides a manual headless smoke test. It was only run on a software renderer (about 3 fps), so **real-GPU frame rate was never measured**. |

## Porting notes
- The GLSL in `gl.js` (`SRC.sky/water/bld/pad/line/pts/beam/mist/bright/blur/comp`) is reusable. Port it into
  the chosen renderer (see PLAN section 3) rather than rewriting the look from scratch.
- Building instance layout: `[x,z,w,d, h,birth,lastTouch,activity, district,seed,hot,dead]`. Time is a single
  uniform `uT` in 0..1; growth, lighting and decay are all evaluated per instance in the vertex/fragment shader.
- `world.js` shows the shape of data the frontend needs; the real API must return the same concepts (section 4 of PLAN).
