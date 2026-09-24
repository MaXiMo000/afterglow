# Performance log

Budgets: `docs/PLAN.md` section 6. Record every measurement here in the same PR as the change that affects it.
Numbers must come from a named device and tool; anything estimated or not measured says so.

| Date | Milestone | Device / browser | Metric | Result | Budget | Tool | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-24 | A0 | n/a (build output) | Initial JS gzip | 0.12 KB JS + 0.43 KB CSS | <= 400 KB | `vite build` | Placeholder page only; no renderer yet |
| 2026-09-25 | A1 | Windows 11 laptop, local git 2.55 | Analysis wall time, fastapi/typer (1,762 commits, 775 files) | ~4 s | 90 s cap | `python -m worker` | Includes both clones over the network |
| 2026-09-25 | A1 | same | Analysis wall time, fastapi/fastapi (7,713 commits, 3,139 files) | ~7 s | 90 s cap | `python -m worker` | |
| 2026-09-25 | A1 | n/a | Result size, fastapi/fastapi (3,139 files) | 606 KB raw, 55 KB gzip | <= 1.5 MB gzip at 50k files | gzip -6 | Linear extrapolation to 50k files is ~0.9 MB gzip as JSON; the binary format decision is re-measured in A2 |

Reference low-end device: to be chosen in A3.
Not measured in A0: frame rate, first frame, input latency, heap (nothing renders yet).
