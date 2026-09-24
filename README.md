# Afterglow

Paste a public GitHub repository. Its history grows into a cinematic night city: buildings are files,
lit windows are recent work, red beacons are hotspots, dark fog is code nobody touches, lanterns are people.
Scroll through the story, then fly the city and scrub through time.

**Status:** design + working visual prototype. The product (FastAPI backend, real data, production
frontend) is not built yet. Start with `PROMPT.md`.

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
| `scripts/` | `publish.sh` (create public repo + harden it), `harden-repo.sh` |
