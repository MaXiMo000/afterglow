# Performance log

Budgets: `docs/PLAN.md` section 6. Record every measurement here in the same PR as the change that affects it.
Numbers must come from a named device and tool; anything estimated or not measured says so.

| Date | Milestone | Device / browser | Metric | Result | Budget | Tool | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-24 | A0 | n/a (build output) | Initial JS gzip | 0.12 KB JS + 0.43 KB CSS | <= 400 KB | `vite build` | Placeholder page only; no renderer yet |

Reference low-end device: to be chosen in A3.
Not measured in A0: frame rate, first frame, input latency, heap (nothing renders yet).
