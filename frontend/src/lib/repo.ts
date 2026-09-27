/**
 * Client-side mirror of the server's repo validation (docs/PLAN.md section 4, SECURITY T1).
 * The server re-validates everything; this only gives fast feedback in the form.
 */
const REPO_RE = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

export type RepoRef = { readonly owner: string; readonly name: string };

export function parseRepo(input: string): RepoRef | null {
  const m = REPO_RE.exec(input.trim());
  if (!m) return null;
  const [, owner, name] = m;
  if (owner === undefined || name === undefined) return null;
  if (name === '.' || name === '..') return null;
  return { owner, name };
}

/** First path segments the site itself serves (Caddy falls back to index.html for missing files under them). */
const RESERVED = new Set(['api', 'assets', 'demo', 'healthz', 'readyz', 'node_modules']);

/**
 * Clean links (N1): `/owner/name` names a repository. Only exactly two segments, each matching the same strict
 * rule as the form; anything else (encoded characters, extra segments, the site's own folders) is not a repo.
 */
export function repoFromPath(pathname: string): RepoRef | null {
  const m = /^\/([^/]+)\/([^/]+?)\/?$/.exec(pathname);
  if (!m || RESERVED.has(m[1]!.toLowerCase())) return null;
  return parseRepo(`${m[1]}/${m[2]}`);
}

/** The clean path for a repository (the server lower-cases names; GitHub treats them case-insensitively). */
export const repoPath = (r: RepoRef): string => `/${r.owner}/${r.name}`;
