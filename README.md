# Afterglow

Paste a public GitHub repository. Its history grows into a cinematic night city: buildings are files,
lit windows are recent work, red beacons are hotspots, dark fog is code nobody touches, lanterns are people.
Scroll through the story, then fly the city and scrub through time.

**Status:** A0-A2 done: the API queues analyses of real public repositories, streams progress over SSE and serves
strict, validated results; the worker runs sandboxed with GitHub-only egress. There is no city UI yet (A3); the
visual prototype in `prototype/` still uses simulated data.
Afterglow is **not** yet claimed to be secure: see `docs/SECURITY.md` section 8.

| Milestone | Status |
| --- | --- |
| A0 Bootstrap | done |
| A1 Analysis core | done |
| A2 API + SSE + limits | done |
| A3 Frontend foundation | next |
| A4-A8 | planned (`docs/PLAN.md` section 5) |

| Path | What |
| --- | --- |
| `PROMPT.md` | The prompt to paste into Claude Code |
| `CLAUDE.md` | Rules Claude Code must follow every session |
| `docs/PLAN.md` | Product, architecture, milestones with acceptance gates |
| `docs/EXPERIENCE.md` | Scroll, camera, input, animation, UI spec (the "make it feel amazing" brief) |
| `docs/SECURITY.md` | Threat model and controls, end to end |
| `docs/PROTOTYPE.md` | What the reference prototype does, what is wrong with it, how to port it |
| `prototype/` | Reference implementation (single-file WebGL2, simulated data). Open `prototype/dist/afterglow.html` |
| `docs/reference/` | Screenshots of the prototype |
| `backend/` | FastAPI API (`app/`) and analysis worker (`worker/`), hash-pinned lockfiles |
| `frontend/` | Vite + TypeScript strict SPA, vitest, Playwright e2e |
| `deploy/` | Caddyfile (TLS, CSP, headers), compose stack, header checks |
| `docs/PERF-LOG.md` | Measured performance numbers |
| `scripts/` | `publish.sh` (create public repo + harden it), `harden-repo.sh` |

## Develop

Needs Python 3.12, Node 24 and Docker. Exact commands are in `CLAUDE.md`. Short version:

```bash
scripts/dev-env.sh
cd frontend && npm ci --ignore-scripts && npm run build && cd ..
docker compose -f deploy/compose.yaml --profile worker up -d --build --wait
bash deploy/check-headers.sh
```

Then open https://localhost:8443 (Caddy's local CA, so the browser will warn once).
