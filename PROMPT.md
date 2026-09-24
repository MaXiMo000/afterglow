# Prompt for Claude Code

Paste everything between the lines into Claude Code, opened in the root of this repo.

---
You are building **Afterglow** from the design in this repo. Read, in order: `CLAUDE.md`, `docs/PLAN.md`, `docs/EXPERIENCE.md`,
`docs/SECURITY.md`, `docs/PROTOTYPE.md`. Then open `prototype/dist/afterglow.html` in a browser and look at `docs/reference/*.png` so you know exactly
what the look and story should be. The prototype is a **reference for look and interaction only**: it uses simulated data, inline scripts and a third-party
font host, so do not extend it; port its GLSL and camera ideas into the architecture in `docs/PLAN.md`.

The owner wants three things, in this priority order:
1. **A dramatically better experience than the prototype**: a much better UI, faster and more responsive scroll, proper zoom in/out (toward the cursor, with inertia),
   a full keyboard map, and richer effects and animations. Every requirement is in `docs/EXPERIENCE.md`. Treat it as a checklist.
2. **Real, useful data**: a FastAPI backend that analyses a public GitHub repo's history and returns hotspots, bus factor, quiet zones and coupling.
3. **Security end to end**, with tests that fail if a control is removed. `docs/SECURITY.md` is a requirement, not a suggestion.

How to work:
- Do the milestones in `docs/PLAN.md` section 5 in order, **one at a time**. After each: run every check, then stop and report:
  what you built, how you verified it, what you could NOT verify, and the measured numbers for the budgets that apply. Then wait for my go-ahead.
- Start with **A0 only**. Before writing code, reply with a short plan for A0 and a list of any decision in `docs/PLAN.md` section 3 you disagree with (with reasons).
- Never weaken a test, header, CSP directive or CI gate to make something pass. If something in the spec is impossible or wrong, say so and propose an alternative.
- Do not invent data. Anything simulated, sampled or truncated must be labelled in the UI. If you cannot measure something (real-device fps, screen-reader behaviour), say that plainly.
- Use `textContent` only, no inline script/style, no third-party origins at runtime, no author emails anywhere.
- Keep `docs/` truthful: update status tables and `docs/PERF-LOG.md` in the same PR as the change.
- Small PRs, conventional commits. Ask me before adding any paid service, analytics, or anything that sends data off the user's machine.

Definition of "perfect" for this project (I will judge against these, so measure them):
- 60 fps on a recent phone and laptop, >= 30 fps on the reference low-end phone, no jank while scrolling, zoom or orbiting; first frame <= 2.5 s on 4G mid-range Android.
- Scroll, orbit and zoom feel immediate and smooth; reverse scroll is perfectly symmetric; nothing pops between modes.
- Every feature reachable by keyboard; `?` shows the map; reduced-motion and screen-reader paths work; a 2D fallback exists.
- Zero CSP or Trusted Types violations, only same-origin network requests, security checklist in `docs/SECURITY.md` section 8 ticked with evidence.
- Hostile-repo fixtures cannot exceed caps or escape the worker sandbox.

Begin now with A0.
---
