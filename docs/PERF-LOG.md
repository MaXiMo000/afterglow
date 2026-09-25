# Performance log

Budgets: `docs/PLAN.md` section 6. Record every measurement here in the same PR as the change that affects it.
Numbers must come from a named device and tool; anything estimated or not measured says so.

| Date | Milestone | Device / browser | Metric | Result | Budget | Tool | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-24 | A0 | n/a (build output) | Initial JS gzip | 0.12 KB JS + 0.43 KB CSS | <= 400 KB | `vite build` | Placeholder page only; no renderer yet |
| 2026-09-25 | A1 | Windows 11 laptop, local git 2.55 | Analysis wall time, fastapi/typer (1,762 commits, 775 files) | ~4 s | 90 s cap | `python -m worker` | Includes both clones over the network |
| 2026-09-25 | A1 | same | Analysis wall time, fastapi/fastapi (7,713 commits, 3,139 files) | ~7 s | 90 s cap | `python -m worker` | |
| 2026-09-25 | A1 | n/a | Result size, fastapi/fastapi (3,139 files) | 606 KB raw, 55 KB gzip | <= 1.5 MB gzip at 50k files | gzip -6 | Linear extrapolation to 50k files is ~0.9 MB gzip as JSON; the binary format decision is re-measured in A2 |
| 2026-09-25 | A2 | Docker Desktop, full stack | Result on the wire, fastapi/fastapi (3,139 files) | 62.5 KB gzip | <= 1.5 MB gzip at 50k files | curl via Caddy | JSON kept; binary format dropped (PLAN section 3) |
| 2026-09-25 | A2 | same | POST -> done, fastapi/fastapi, cold | ~9 s | 90 s cap | curl + SSE | Includes queue pickup (<= 1 s poll) |
| 2026-09-25 | A3 | n/a (build output) | Initial JS gzip | 20.6 KB JS + 3.4 KB CSS (+ fonts ~110 KB woff2, cached) | <= 400 KB | `vite build` | Renderer included; no Three.js |
| 2026-09-25 | A3 | Windows laptop, headless Chromium (ANGLE d3d11, real GPU), 1440x900 | Frame rate, fastapi/typer city, cinematic | 60 fps (vsync-capped) | 60 fps | rAF counter over 120 frames | Not a phone. Not a sustained profile |
| 2026-09-25 | A3 | same, local stack | Hero ready incl. demo city (620 KB JSON) | 2.5 s | first frame <= 2.5 s on 4G | Playwright timing | Local network, desktop CPU: says nothing about 4G/mid-range Android |

Reference low-end device: budget Android class (Mali-G57 / Adreno 610, 4 GB), e.g. Galaxy A14 (PLAN section 6).
**Not measured yet (no hardware in this environment):** any phone, the reference low-end device, 4G first frame, INP.
Not measured in A0: frame rate, first frame, input latency, heap (nothing renders yet).
