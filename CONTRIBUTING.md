# Contributing

Issues and pull requests are welcome. For anything security-related, see [SECURITY.md](SECURITY.md) instead.

## Ground rules

- Everything that comes from a repository (paths, names, URL parameters) is untrusted. Validate it on the server and
  render it with `textContent`, never `innerHTML`, `eval` or `new Function`.
- No inline scripts or styles, and no third-party origins at runtime: the Content Security Policy forbids them.
- Anything estimated, sampled or truncated is labelled as such in the UI.
- Keyboard access, `prefers-reduced-motion`, the screen-reader summary and the 2D table fallback must keep working.
- Never weaken a check, test, header or CI gate to get a green build.
- Pins stay pins: GitHub Actions by commit SHA, images by digest, Python by hash, npm by lockfile.

## Checks

Frontend (in `frontend/`):

```bash
npm ci --ignore-scripts && npm run typecheck && npm test && npm run build && npm run e2e
```

Backend (in `backend/`, after `eval "$(scripts/test-db.sh)"` from the repo root):

```bash
pip install --require-hashes --no-deps -r requirements-dev.lock && pip install --no-deps --no-build-isolation -e .
ruff check . && ruff format --check . && mypy --strict app core worker egress && bandit -q -r app core worker egress
pytest && pip-audit -r requirements-dev.lock --require-hashes --disable-pip
```

After editing `pyproject.toml`, regenerate the locks:

```bash
pip-compile --generate-hashes --allow-unsafe --strip-extras -o requirements.lock pyproject.toml
pip-compile --generate-hashes --allow-unsafe --strip-extras --extra dev -o requirements-dev.lock pyproject.toml
```

Local stack and header check (repo root):

```bash
docker compose -f deploy/compose.yaml --profile worker up -d --build --wait
bash deploy/check-headers.sh
```

Pre-commit hooks: `pip install pre-commit && pre-commit install` (gitleaks runs from a pinned image and needs Docker).

Use conventional commit messages, one coherent change per pull request.
