# Deploy

Afterglow runs as one Docker Compose stack: Caddy (HTTPS and security headers), the API, Postgres, the analysis worker
and its egress proxy. The server needs only **git and Docker**; the frontend is built in a pinned Node container.

Use a Linux server where you control Docker (a VPS). Platforms that run each container for you (Render, Railway,
Fly, Heroku) cannot give the worker a network with no internet access or a locked-down container, which is what keeps
a hostile repository contained (docs/SECURITY.md T4).

## What you need
- A domain name you can add DNS records to.
- A VPS with Ubuntu 24.04: 2 vCPU, 4 GB RAM, 20 GB disk is comfortable (2 GB works for light use). Roughly
  $5-12 a month at Hetzner, DigitalOcean, Vultr or AWS Lightsail.
- SSH access to it.

## 1. DNS
Create an `A` record (and `AAAA` if the server has IPv6) for your hostname, e.g. `afterglow.example.com`, pointing at
the server. Do **not** put it behind a CDN proxy (e.g. Cloudflare's orange cloud): the rate limits key on the client
IP, and behind a proxy every visitor would share one. The same applies to IPv6: unless Docker gives the stack's
`edge` network IPv6 (Docker 27+ with `enable_ipv6: true` on that network, e.g. in a `compose.override.yaml`), Docker's
port proxy forwards every IPv6 visitor from one internal address, so they all share one rate limit. If you have not
set that up, leave the `AAAA` record out. Wait until it resolves:
```bash
dig +short afterglow.example.com
```

## 2. Server setup
```bash
ssh root@<server-ip>
apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 git openssl ufw
adduser --disabled-password --gecos "" afterglow && usermod -aG docker afterglow
ufw allow OpenSSH && ufw allow 443/tcp && ufw --force enable
su - afterglow
docker compose version        # must print v2.x
```
Only port 443 is published by the stack; Postgres, the API and the worker are on private Docker networks.

## 3. Get the code and configure
```bash
git clone https://github.com/MaXiMo000/afterglow.git && cd afterglow
scripts/dev-env.sh            # writes deploy/.env with random database passwords and the IP-hashing key
cat >> deploy/.env <<'EOF'
AFTERGLOW_SITE=afterglow.example.com
AFTERGLOW_PUBLIC_ORIGIN=https://afterglow.example.com
AFTERGLOW_PORT=443
AFTERGLOW_BIND=0.0.0.0
AFTERGLOW_TLS=you@example.com
EOF
```
`AFTERGLOW_TLS` is the email Let's Encrypt uses for expiry notices; with it set, Caddy obtains and renews the
certificate on its own. `scripts/build-frontend.sh` also reads `AFTERGLOW_PUBLIC_ORIGIN` to fill the link-preview
(Open Graph) URLs; set `AFTERGLOW_SITE_URL` in the shell to override it. The preview image
`frontend/public/og.jpg` (1200x630, baseline JPEG, under 300 KB so WhatsApp shows it) is rendered from the real scene
by `npm run og-image` against a running local stack; the script checks the size and format. Chat apps cache previews
by image URL, so bump `?v=` on the `og:image` tags in `frontend/index.html` whenever the image changes. To check a
deployment, paste the link into WhatsApp or the Facebook Sharing Debugger (both fetch the page themselves).

Keep a copy of `deploy/.env` in a password manager and never commit it.

The site sends `Strict-Transport-Security` with `includeSubDomains`: if you deploy on an apex domain
(`example.com`), every subdomain must also serve HTTPS. A dedicated subdomain avoids that.

## 4. Build and start
```bash
scripts/build-frontend.sh     # npm ci + typecheck + build + bundle policy check, inside node:24 (pinned)
docker compose -f deploy/compose.yaml --profile worker up -d --build --wait
```
The first run builds three images (a few minutes). Watch Caddy get the certificate:
```bash
docker compose -f deploy/compose.yaml logs -f caddy     # look for "certificate obtained successfully"
```

## 5. Check it
```bash
docker compose -f deploy/compose.yaml ps                        # all services running, api and db healthy
bash deploy/check-headers.sh https://afterglow.example.com      # "ok all security headers present"
```
Then open the site, paste a repository (e.g. `pallets/flask`) and watch the progress log. Optionally grade the
headers at https://securityheaders.com and https://developer.mozilla.org/observatory.

## Operate

| Task | Command (from the `afterglow` directory) |
| --- | --- |
| Status | `docker compose -f deploy/compose.yaml ps` (the worker reports `unhealthy` if its job loop stops) |
| Uptime monitor | Point any monitor at `https://<your hostname>/readyz`: `200 {"status":"ok"}`, or `503` with `database` (Postgres unreachable) or `queue_stalled` (jobs waiting over 5 minutes and no worker running) |
| Logs | `docker compose -f deploy/compose.yaml logs --tail 100 api worker caddy` |
| Restart | `docker compose -f deploy/compose.yaml --profile worker restart` |
| Stop | `docker compose -f deploy/compose.yaml --profile worker down` (data is kept in volumes) |
| Update | `git pull && scripts/build-frontend.sh && docker compose -f deploy/compose.yaml --profile worker up -d --build --wait` |
| Backup | `docker compose -f deploy/compose.yaml exec -T db pg_dump -U postgres -Fc afterglow > afterglow-$(date +%F).dump` |

- Containers restart on their own after a crash or reboot (`restart: unless-stopped`).
- Logs are capped at 3 x 10 MB per service. Nothing personal is stored: see `/privacy.html`.
- The database only holds job records and cached results derived from public repositories, so backups are optional;
  a lost database just means repositories are analysed again.
- The `maint` service deletes finished job records after 7 days, and cached results once they are over 30 days old and
  nobody has asked for that commit in the last 7 days. Its log line `pruned jobs=N results=M` appears hourly.
- `deploy/db/schema.sql` runs only when the database is first created. When a release changes it, it ships an upgrade
  file in `deploy/db/upgrades/` and the changelog says so. Apply them in order, as below.

### Upgrading a database created before the retention service (also adds the progress trigger)
```bash
scripts/dev-env.sh                      # adds AFTERGLOW_DB_MAINT_PASSWORD; existing secrets are kept
set -a; . deploy/.env; set +a
docker compose -f deploy/compose.yaml exec -T db psql -U postgres -d afterglow -v ON_ERROR_STOP=1 \
  -v maint_pw="$AFTERGLOW_DB_MAINT_PASSWORD" < deploy/db/upgrades/0002-retention.sql
docker compose -f deploy/compose.yaml --profile worker up -d --build --wait
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Browser shows a certificate error | DNS does not point at the server yet, or port 443 is blocked. Check `dig`, `ufw status`, and the Caddy log |
| Blank page, `400`, or a certificate for the wrong name | `AFTERGLOW_SITE` must be exactly the hostname in the address bar |
| Pasting a repo says "Something went wrong" and the browser's network tab shows `403` | `AFTERGLOW_PUBLIC_ORIGIN` is not exactly `https://<your hostname>` |
| Analyses fail with "GitHub refused the clone" | The server cannot reach `github.com:443` outbound; check the provider firewall |
| "The service is busy" | 50 analyses are queued; the worker handles one at a time. Wait, or run a bigger server |
| Changed `deploy/.env` but nothing happened | Recreate: `docker compose -f deploy/compose.yaml --profile worker up -d --wait` |
