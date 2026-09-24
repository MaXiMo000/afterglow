# CLAUDE.md

Afterglow = FastAPI backend that analyses a public GitHub repo's git history + a scroll-driven WebGL
"night city" frontend. Read `docs/PLAN.md`, then `docs/EXPERIENCE.md`, `docs/SECURITY.md`, `docs/PROTOTYPE.md`.

## Non-negotiable rules
1. **Security rules in `docs/SECURITY.md` are requirements.** Never weaken a check, test, header or CI gate to get green. If a task conflicts with one, stop and ask.
2. **Untrusted input everywhere.** Repo names, file paths, branch names, commit messages, author names and URL params all come from strangers. Validate on the server, render with `textContent` only, never `innerHTML`/`eval`/`new Function`.
3. **No inline script or style in production.** Strict CSP, no `unsafe-inline`, Trusted Types on. (The prototype uses inline code; do not copy that.)
4. **No third-party origins at runtime.** Self-host fonts, libraries and assets. No analytics/telemetry without asking the owner.
5. **No secrets in the repo**, no personal data in responses (no author emails), no tokens in URLs or browser storage.
6. **Data honesty.** Anything shown that is simulated, sampled or truncated must be labelled in the UI.
7. **Performance budgets in `docs/PLAN.md` section 6 are requirements.** Measure; do not guess. State what you could not measure.
8. **Accessibility is a requirement:** keyboard-complete, `prefers-reduced-motion`, screen-reader summary, 2D fallback without WebGL.

## Working style
- One milestone at a time, one PR per coherent task, conventional commits.
- Every task ends with: what changed, how it was verified, what was NOT verified.
- Update `docs/` in the same PR as behaviour changes.
- Ask the owner before: paid services, analytics, license change, sending user data anywhere new.

## Commands (fill in as they are created)
backend: `pip install -e ".[dev]" && ruff check . && mypy --strict app && bandit -q -r app && pytest`
frontend: `npm ci --ignore-scripts && npm run typecheck && npm test && npm run build && npm run e2e`
