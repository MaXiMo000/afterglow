/**
 * Derived history facts shown in the inspector, insights and compare legend (D4, D5, N3 in the audit).
 * Each is a plain count or comparison of result fields, so the UI can say exactly what it means.
 */
import type { Dir, FileRec, Result } from './result';

/** Files kept from before a truncated history window: no change inside the analysed commits. */
export const beforeWindow = (f: FileRec): boolean => f.changes === 0;

/** Districts whose newest change is the window's first date on a truncated history: that date is an upper bound. */
export const dirBeforeWindow = (r: Result, d: Dir): boolean => r.meta.truncated.commits && d.last <= r.meta.span[0];

const quarterOf = (epoch: number): number => {
  const d = new Date(epoch * 1000);
  return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
};
const quarterStart = (q: number): number => Date.UTC(Math.floor(q / 4), (q % 4) * 3, 1) / 1000;

/**
 * Index of the first of the 8 quarters the analysis read in full. 0 unless the history was truncated inside
 * the last two years: earlier quarters (and the one the window starts in) were not, or only partly, read, so their
 * zeros are unknowns, not "no changes".
 */
export function analysedFrom(r: Result): number {
  if (!r.meta.truncated.commits) return 0;
  const gap = quarterOf(r.meta.span[1]) - quarterOf(r.meta.span[0]); // quarters between window start and HEAD
  return Math.min(8, Math.max(0, 8 - gap));
}

export type Trend = 'heating' | 'cooling' | 'steady' | 'new';

/**
 * Compare the latest four calendar quarters (the current one so far) with the four before them. "Heating up"
 * needs at least three changes in the latest year and twice as many as the year before; "cooling down" is the
 * mirror image. A file created inside the eight quarters is "new" (no earlier year to compare with). null: no
 * data, or some of the eight quarters were not analysed.
 */
export function trend(r: Result, f: FileRec): { kind: Trend; recent: number; before: number } | null {
  if (f.quarters.length !== 8 || analysedFrom(r) > 0) return null;
  const before = f.quarters.slice(0, 4).reduce((a, b) => a + b, 0);
  const recent = f.quarters.slice(4).reduce((a, b) => a + b, 0);
  const born = f.birth >= quarterStart(quarterOf(r.meta.span[1]) - 7);
  const kind: Trend = born
    ? 'new'
    : recent >= 3 && recent >= 2 * before
      ? 'heating'
      : before >= 3 && before >= 2 * recent
        ? 'cooling'
        : 'steady';
  return { kind, recent, before };
}

export const TREND_TEXT: Record<Trend, string> = { heating: 'heating up', cooling: 'cooling down', steady: 'steady', new: 'new in the last two years' };
/** Only these get a badge; "steady" and "new" are said in the summary text only. */
export const shownTrend = (t: ReturnType<typeof trend>): t is { kind: 'heating' | 'cooling'; recent: number; before: number } =>
  t !== null && (t.kind === 'heating' || t.kind === 'cooling');

/** Files removed in (a, b]: null when the analysis predates removal counts. Month granularity. */
export function removedBetween(r: Result, a: number, b: number): number | null {
  if (r.timeline.some((m) => m.removed === undefined)) return null;
  return r.timeline.reduce((n, m) => (m.t > a && m.t <= b ? n + (m.removed ?? 0) : n), 0);
}

/** Label for the quarter `i` (0 = oldest) of a result whose HEAD is at `head`. */
export function quarterLabel(head: number, i: number): string {
  const q = quarterOf(head) - (7 - i);
  return `Q${(q % 4) + 1} ${Math.floor(q / 4)}`;
}
