/**
 * Bus-factor "what if" (docs/ROADMAP.md #6): the districts left without anyone else holding a real share of the
 * commits if one contributor left. Uses `dirs[].owners` (analyser >= 5): the top 5 authors per district by commit
 * share, largest first, so "no other owner at 10%+" is exact (a 6th author has less than the 5th).
 */
import type { Result } from '../lib/result';

/** Another author at or above this share of a district's commits still knows it. */
export const OTHER_MIN = 0.1;

/** Owner data is there: analyser 5, and not a drilled-in sub-city (owners are per top-level district). */
export const hasOwners = (r: Result): boolean => r.meta.analyser >= 5 && r.dirs.some((d) => d.owners !== undefined);

/** Districts where `person` is an owner and nobody else has OTHER_MIN or more of the commits. */
export function orphaned(r: Result, person: number): number[] {
  const out: number[] = [];
  r.dirs.forEach((d, i) => {
    const o = d.owners ?? [];
    if (o.some((x) => x.person === person) && !o.some((x) => x.person !== person && x.share >= OTHER_MIN)) out.push(i);
  });
  return out;
}
