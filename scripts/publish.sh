#!/usr/bin/env bash
# Create the PUBLIC GitHub repo from this directory, push, then apply security settings.
# Usage: ./scripts/publish.sh [owner] [repo]      (defaults: MaXiMo000 afterglow)
# Requires: GitHub CLI (`gh`) logged in as the owner: `gh auth login`
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER="${1:-MaXiMo000}"
REPO="${2:-afterglow}"

command -v gh >/dev/null || { echo "Install the GitHub CLI first: https://cli.github.com"; exit 1; }
gh auth status >/dev/null || { echo "Run: gh auth login"; exit 1; }

# Last line of defence before anything becomes public: scan the whole history for secrets.
if command -v gitleaks >/dev/null; then
  gitleaks detect --no-banner --redact --source .
else
  echo "WARN: gitleaks not installed - skipping local scan (CI will scan after push)." >&2
fi

gh repo create "$OWNER/$REPO" --public --source . --remote origin \
  --description "Cinematic, scroll-driven 3D live infrastructure world. FastAPI + WebSocket + Three.js. Secure by design." \
  --push

./scripts/harden-repo.sh "$OWNER" "$REPO"
echo "Done: https://github.com/$OWNER/$REPO"
