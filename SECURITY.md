# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button on the
[Security tab](https://github.com/MaXiMo000/afterglow/security). Do not open a public issue. You will get a reply,
and a fix or a plan, as soon as possible.

## Protections

- **Only public GitHub repositories.** The server accepts a strict `owner/name`, builds the GitHub URL itself and
  never follows redirects to other hosts.
- **Sandboxed analysis.** The worker runs in its own container with no privileges, a read-only filesystem, resource
  caps, and network access only to `github.com` through an egress proxy. It makes bare, blobless clones and never
  checks out or runs repository content.
- **Untrusted data stays data.** Results are validated against a strict schema on the server and in the browser, and
  every repository-derived string is rendered as text, never HTML.
- **Strict browser policy.** A tight Content Security Policy with Trusted Types, no inline scripts or styles, no
  third-party origins, and framing allowed only on the read-only embed page.
- **Least-privilege database roles.** The API, worker and retention service each have their own role and can only do
  their own job.
- **Abuse limits.** Per-client rate limits and quotas, and queue backpressure.
- **Privacy.** No email addresses are read or stored; contributors are shown pseudonymously. What is stored and for
  how long is in the [privacy note](frontend/privacy.html).
- **Supply chain.** Dependencies are pinned by hash or lockfile, GitHub Actions by commit, images by digest. Every
  change runs CodeQL, Semgrep, Trivy, gitleaks and dependency audits. Release images ship with SBOMs and build
  provenance.
