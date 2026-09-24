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

## Commands
backend DB for tests (repo root): `eval "$(scripts/test-db.sh)"` (starts Postgres, exports AFTERGLOW_TEST_*_URL; stop the stack's worker first or it will steal test jobs)
backend (in `backend/`): `pip install --require-hashes --no-deps -r requirements-dev.lock && pip install --no-deps --no-build-isolation -e . && ruff check . && ruff format --check . && mypy --strict app core worker egress && bandit -q -r app core worker egress && pytest && pip-audit -r requirements-dev.lock --require-hashes --disable-pip`
backend lock (after editing `pyproject.toml`): `pip-compile --generate-hashes --allow-unsafe --strip-extras -o requirements.lock pyproject.toml` and the same with `--extra dev -o requirements-dev.lock`
frontend (in `frontend/`): `npm ci --ignore-scripts && npm run typecheck && npm test && npm run build && npm run e2e`
local stack (repo root, after `scripts/dev-env.sh` and `npm run build`): `docker compose -f deploy/compose.yaml --profile worker up -d --build --wait`, then `bash deploy/check-headers.sh`; site at https://localhost:8443
pre-commit: `pip install pre-commit && pre-commit install` (gitleaks runs from its pinned image; needs Docker)
Pins: GitHub Actions by commit SHA, images by digest, Python by hash, npm by lockfile. Never replace a pin with a tag. Do not use `aquasecurity/trivy-action` (tag hijack, CVE-2026-33634); Trivy runs from its pinned image.
