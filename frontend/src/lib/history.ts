/**
 * Derived history facts shown in the inspector, insights and compare legend (D4, D5, N3 in the audit).
 * Each is a plain count or comparison of result fields, so the UI can say exactly what it means.
 */
import type { FileRec, Result } from './result';

/** Files kept from before a truncated history window: no change inside the analysed commits. */
export const beforeWindow = (f: FileRec): boolean => f.changes === 0;

export type Trend = 'heating' | 'cooling' | 'steady';

/**
 * Compare the latest four calendar quarters with the four before them. "Heating up" needs at least three changes
 * in the latest year and twice as many as the year before; "cooling down" is the mirror image. null: no data.
 */
export function trend(quarters: readonly number[]): { kind: Trend; recent: number; before: number } | null {
  if (quarters.length !== 8) return null;
  const before = quarters.slice(0, 4).reduce((a, b) => a + b, 0);
  const recent = quarters.slice(4).reduce((a, b) => a + b, 0);
  const kind: Trend = recent >= 3 && recent >= 2 * before ? 'heating' : before >= 3 && before >= 2 * recent ? 'cooling' : 'steady';
  return { kind, recent, before };
}

export const TREND_TEXT: Record<Trend, string> = { heating: 'heating up', cooling: 'cooling down', steady: 'steady' };

/** Files removed in (a, b]: null when the analysis predates removal counts. Month granularity. */
export function removedBetween(r: Result, a: number, b: number): number | null {
  if (r.timeline.some((m) => m.removed === undefined)) return null;
  return r.timeline.reduce((n, m) => (m.t > a && m.t <= b ? n + (m.removed ?? 0) : n), 0);
}

/** Label for the quarter `i` (0 = oldest) of a result whose HEAD is at `head`. */
export function quarterLabel(head: number, i: number): string {
  const d = new Date(head * 1000);
  const q = d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3) - (7 - i);
  return `Q${(q % 4) + 1} ${Math.floor(q / 4)}`;
}
