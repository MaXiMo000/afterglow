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
