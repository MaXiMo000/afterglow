# Afterglow

Paste a public GitHub repository and its whole history grows into a night city you can scroll through and fly.

**Live: https://afterglow.name**

![The pallets/flask city: districts are top-level folders, beams mark hotspots](docs/screenshots/city.webp)

| What you see | What it means |
| --- | --- |
| Building | A file; height is its size in lines |
| Glass tower / brick / warehouse | The largest source files / old files untouched this year / generated, vendored or lock files |
| Tree, park | A test file; districts made mostly of tests become parks |
| House | Docs and text files |
| Crane | Changed in the last 14 days of the analysed history |
| Vines | No change in over two years |
| Lit windows | Recent activity |
| Red beam | Hotspot: changed often in the last year by three people or fewer |
| Dark, fogged district | Untouched for over two years |
| Lanterns | Contributors (pseudonymous), roaming the files they work on |
| Arcs | Folders whose files change together |

A short scroll story walks through the findings, then the city opens for free exploration. It moves like a map: drag to
move, right-drag (or two fingers) to turn, wheel or pinch to zoom, with on-screen buttons for the same. The city key
explains every building style. Districts are blocks with streets: **Walk** (`X`) puts you on one, to walk with WASD or
the on-screen pad, and a tour (`9`) flies you from finding to finding as you scroll, with a caption at each stop. It
works on phones and tablets in either orientation. Also: search (`/`), an insights
panel (hotspots, bus factor, quiet areas, coupling), a timeline to replay history, compare two dates, share links,
photo mode, a graphics-quality setting, and a full keyboard map (`?`). The browser's Back button, Esc and Backspace
step back through city, story and start page. Everything also works as a plain table, with or without WebGL.

![Story chapter: hotspots, with the hottest file called out](docs/screenshots/story.webp)

## How it works

```
Browser --https--> Caddy (TLS, strict CSP, static files) --/api--> FastAPI --> Postgres (queue + results)
                                                                                 ^
                                            sandboxed worker (git) --egress proxy (github.com only)--+
```

- The worker makes a bare, blobless clone and reads `git log` metadata: paths, dates, change counts and line counts.
  Moved files keep their history, and the repository's `.mailmap` merges one person's name spellings. It never
  checks out files, never reads email addresses, and shows contributors as `Contributor 1, 2, ...`.
- Results are cached per commit and validated against a strict schema on both server and client.
- Public repositories only. What is stored and for how long: [privacy note](frontend/privacy.html).

## Run it locally

Needs Docker and Node 24 (on Windows, run the commands in Git Bash).

```bash
scripts/dev-env.sh                  # writes deploy/.env with random secrets
(cd frontend && npm ci --ignore-scripts && npm run build)
docker compose -f deploy/compose.yaml --profile worker up -d --build --wait
```

Open https://localhost:8443 (a local certificate, so the browser warns once). Configuration keys are listed in
[`.env.example`](.env.example).

## Tests

```bash
(cd frontend && npm ci --ignore-scripts && npm run typecheck && npm test && npm run build && npm run e2e)
eval "$(scripts/test-db.sh)"        # Postgres for the backend tests
(cd backend && pip install --require-hashes --no-deps -r requirements-dev.lock   && pip install --no-deps --no-build-isolation -e .   && ruff check . && mypy --strict app core worker egress && pytest)
```

More in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Deploy

On any Linux server with Docker and a domain name: point DNS at the server, add five lines to `deploy/.env`, and
start the same stack; Caddy gets the HTTPS certificate on its own. Step by step: [`docs/DEPLOY.md`](docs/DEPLOY.md), including operations and troubleshooting.

Release images are published to GHCR with build provenance; pin them by digest from the
[release notes](https://github.com/MaXiMo000/afterglow/releases) and check them with
`gh attestation verify oci://<image@digest> --repo MaXiMo000/afterglow`.

## Security and quality

Every pull request runs typed checks, unit and end-to-end tests (including accessibility, CSP and performance
budgets), CodeQL, Semgrep, Trivy, gitleaks and dependency audits. How the service is protected, and how to
report a problem privately: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
