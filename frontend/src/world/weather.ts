/**
 * Weather as activity (docs/ROADMAP.md #5): which districts get rain and which get fog. Decorative, but tied to
 * real numbers, and the legend says which: rain = the busiest districts by changes in the last 12 months, fog =
 * districts with no change in 2 years (`dirs[].quiet`).
 */
import type { Result } from '../lib/result';

export const MAX_RAIN_DIRS = 12;

export type Weather = { rain: number[]; fog: number[] };

export function weather(r: Result): Weather {
  const act = new Array<number>(r.dirs.length).fill(0);
  for (const f of r.files) act[f.dir]! += f.changes_12m;
  const active = act.map((n, i) => ({ n, i })).filter((d) => d.n > 0);
  active.sort((a, b) => b.n - a.n || a.i - b.i);
  // The top quarter of active districts (at least one), so a quiet repo gets a shower, not a storm.
  const rain = active.slice(0, Math.min(MAX_RAIN_DIRS, Math.max(1, Math.ceil(active.length / 4)))).map((d) => d.i);
  const fog = r.dirs
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.quiet)
    .sort((a, b) => b.d.files - a.d.files || a.i - b.i)
    .map(({ i }) => i);
  return { rain, fog };
}
