#!/usr/bin/env bash
# Apply GitHub-side security settings. First run against MaXiMo000/afterglow on 2026-09-24: all calls ok,
# settings read back and confirmed. Idempotent; safe to re-run.
# Usage: ./scripts/harden-repo.sh owner repo
set -uo pipefail
OWNER="${1:?owner}"; REPO="${2:?repo}"
api() { gh api -H "Accept: application/vnd.github+json" "$@" >/dev/null && echo "ok   $*" || echo "FAIL $*"; }

# Secret scanning + push protection (blocks pushes that contain secrets)
gh api -X PATCH "repos/$OWNER/$REPO" --input - >/dev/null <<'JSON' && echo "ok   settings" || echo "FAIL settings"
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  },
  "delete_branch_on_merge": true,
  "allow_merge_commit": false,
  "allow_squash_merge": true,
  "allow_rebase_merge": false,
  "has_wiki": false
}
JSON

api -X PUT "repos/$OWNER/$REPO/private-vulnerability-reporting"
api -X PUT "repos/$OWNER/$REPO/vulnerability-alerts"
api -X PUT "repos/$OWNER/$REPO/automated-security-fixes"
# Actions: read-only default token; workflows cannot approve PRs
api -X PUT "repos/$OWNER/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Protect main: PR + status checks, no force-push/deletion. Admin (you) can still bypass.
gh api -X PUT "repos/$OWNER/$REPO/branches/main/protection" --input - >/dev/null <<'JSON' && echo "ok   branch protection" || echo "FAIL branch protection"
{
  "required_status_checks": { "strict": true, "contexts": ["backend", "frontend", "gitleaks"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
