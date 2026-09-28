/**
 * "What changed since last time" (docs/ROADMAP.md #8): compare this analysis with the previous stored one of the
 * same repository, file by file (by path). Uses only fields both results have, so it is exact for the files in both.
 */
import type { Result } from './result';

/** Building marks shared with the PR overlay slot: 1 = changed again since then, 3 = new since then. */
export type Since = { marks: Map<number, 1 | 3>; fresh: number; again: number; changes: number; removed: number; partial: boolean };

export function since(cur: Result, prev: Result): Since {
  const before = new Map(prev.files.map((f) => [f.path, f]));
  const marks = new Map<number, 1 | 3>();
  let changes = 0;
  cur.files.forEach((f, i) => {
    const p = before.get(f.path);
    if (!p) {
      if (f.birth > prev.meta.span[1]) marks.set(i, 3); // created after the previous analysis' HEAD
      return;
    }
    if (f.changes > p.changes) {
      marks.set(i, 1);
      changes += f.changes - p.changes;
    }
  });
  const now = new Set(cur.files.map((f) => f.path));
  let removed = 0;
  for (const f of prev.files) if (!now.has(f.path)) removed++;
  let fresh = 0;
  for (const v of marks.values()) if (v === 3) fresh++;
  return {
    marks,
    fresh,
    again: marks.size - fresh,
    changes,
    removed,
    // Either side dropped files (file cap) or cut history: the comparison only covers what both contain.
    partial: cur.meta.truncated.files || prev.meta.truncated.files || cur.meta.truncated.commits || prev.meta.truncated.commits,
  };
}
