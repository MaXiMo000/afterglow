/**
 * PR overlay (docs/ROADMAP.md #7): the server's list of files a pull request changes, checked strictly like the
 * analysis result (SECURITY T21), and matched to the city's buildings by path.
 */
import type { Result } from './result';

export type PrChange = { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; old?: string; href?: string };
export type Pr = { repo: string; pr: number; merge: string; base: string; truncated: boolean; changes: PrChange[] };

export const MAX_PR_PATHS = 3000;
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;

export class InvalidPr extends Error {}

function text(v: unknown): string {
  if (typeof v !== 'string' || !v.length || v.length > 512 || UNSAFE.test(v)) throw new InvalidPr('text');
  return v;
}

export function validatePr(raw: unknown): Pr {
  const r = raw as Record<string, unknown>;
  if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new InvalidPr('pr');
  const keys = Object.keys(r).sort().join(',');
  if (keys !== 'base,changes,merge,pr,repo,truncated') throw new InvalidPr('keys');
  const repo = text(r['repo']);
  if (!/^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/.test(repo)) throw new InvalidPr('repo');
  const pr = r['pr'];
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1 || pr > 10_000_000) throw new InvalidPr('pr');
  const merge = text(r['merge']);
  const base = text(r['base']);
  if (!SHA.test(merge) || !SHA.test(base) || typeof r['truncated'] !== 'boolean') throw new InvalidPr('meta');
  const list = r['changes'];
  if (!Array.isArray(list) || list.length > MAX_PR_PATHS) throw new InvalidPr('changes');
  const changes = list.map((c): PrChange => {
    const o = c as Record<string, unknown>;
    if (typeof o !== 'object' || o === null || !Object.keys(o).every((k) => ['path', 'status', 'old', 'href'].includes(k))) throw new InvalidPr('change');
    const status = o['status'];
    if (!STATUSES.includes(status as PrChange['status'])) throw new InvalidPr('status');
    const out: PrChange = { path: text(o['path']), status: status as PrChange['status'] };
    if (o['old'] !== undefined) out.old = text(o['old']);
    if (o['href'] !== undefined) {
      const h = o['href'];
      if (typeof h !== 'string' || h.length > 6144 || !/^[A-Za-z0-9%._~/-]+$/.test(h)) throw new InvalidPr('href');
      out.href = h;
    }
    return out;
  });
  return { repo, pr, merge, base, truncated: r['truncated'], changes };
}

/** Building marks: 1 = changed by the PR, 2 = deleted or moved away by it. */
export type Overlay = { marks: Map<number, 1 | 2>; changed: number; gone: number; fresh: number; unseen: number };

/**
 * Match the PR's paths to buildings. `fresh`: files the PR adds (or renames to) that are not in the city;
 * `unseen`: changed or deleted files that are not in the city either (beyond the file cap, or the city is older).
 */
export function overlay(r: Result, p: Pr): Overlay {
  const at = new Map(r.files.map((f, i) => [f.path, i]));
  const marks = new Map<number, 1 | 2>();
  let fresh = 0;
  let unseen = 0;
  for (const c of p.changes) {
    if (c.status === 'renamed') {
      const from = c.old === undefined ? undefined : at.get(c.old);
      if (from !== undefined) marks.set(from, 2);
      const to = at.get(c.path);
      if (to !== undefined) marks.set(to, 1);
      else fresh++;
      continue;
    }
    const i = at.get(c.path);
    if (i === undefined) {
      if (c.status === 'added') fresh++;
      else unseen++;
    } else marks.set(i, c.status === 'deleted' ? 2 : 1);
  }
  let changed = 0;
  for (const v of marks.values()) if (v === 1) changed++;
  return { marks, changed, gone: marks.size - changed, fresh, unseen };
}
