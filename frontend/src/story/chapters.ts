/**
 * Story chapters, derived from the real analysis (EXPERIENCE section 2). A chapter exists only if the data
 * supports it: no hotspots means no "hot streets" chapter, never a fabricated one.
 */
import type { V3 } from '../render/math';
import type { Result } from '../lib/result';
import type { World } from '../world/build';

export type Key = { pos: V3; tgt: V3; fov: number };
export type Chapter = {
  id: 'first-light' | 'growth' | 'hot' | 'quiet' | 'people' | 'explore';
  eyebrow: string;
  title: string;
  em: string; // italic accent, rendered after `title`
  body: string;
  stats?: { label: string; value: number }[];
  /** World-space anchor for the callout, with its label lines. */
  callout?: { at: V3; name: string; meta: string; hot: boolean };
  key: Key;
  t: number; // history position shown (0..1)
  hot: number; // hotspot beam intensity
  exposure: number; // light: warm first light, colder in quiet zones
  focus: number; // district index to focus, -1 for none
};

const YEAR = 365.25 * 86400;
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const words = (n: number): string => WORDS[n] ?? n.toLocaleString('en-US');
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** A camera looking at `tgt` from `dist` away, at a yaw/pitch, never below the water line. */
function orbitKey(tgt: V3, dist: number, yaw: number, pitch: number, fov = 50): Key {
  const cp = Math.cos(pitch);
  const pos: V3 = [tgt[0] + Math.sin(yaw) * cp * dist, Math.max(2.5, tgt[1] + Math.sin(pitch) * dist), tgt[2] + Math.cos(yaw) * cp * dist];
  return { pos, tgt, fov };
}

function fileTop(w: World, i: number): V3 {
  return [w.pos[i * 3]!, w.pos[i * 3 + 1]!, w.pos[i * 3 + 2]!];
}

export function buildChapters(r: Result, w: World): Chapter[] {
  const out: Chapter[] = [];
  const norm = (t: number): number => Math.min(1, Math.max(0, (t - w.t0) / (w.t1 - w.t0)));
  const date = (t: number): string =>
    new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  // 1. First light: the oldest file still standing.
  let first = 0;
  r.files.forEach((f, i) => {
    if (f.birth < r.files[first]!.birth) first = i;
  });
  const f0 = r.files[first];
  if (f0) {
    const top = fileTop(w, first);
    out.push({
      id: 'first-light',
      eyebrow: 'First light',
      title: 'Every codebase starts as',
      em: 'one commit.',
      body: `The oldest file still standing is ${f0.path}, first committed on ${date(f0.birth)}.`,
      callout: { at: top, name: f0.path, meta: `First commit \u00b7 ${date(f0.birth)}`, hot: false },
      key: orbitKey([top[0], top[1] * 0.5, top[2]], 16, 0.9, 0.35, 46),
      t: Math.min(1, norm(f0.birth) + 0.004),
      hot: 0.2,
      exposure: 1.12,
      focus: -1,
    });
  }

  // 2. Growth: the month that added the most files, shown from above.
  let spurt = r.timeline[0];
  for (const m of r.timeline) if (spurt && m.added > spurt.added) spurt = m;
  const years = (r.meta.span[1] - r.meta.span[0]) / YEAR;
  out.push({
    id: 'growth',
    eyebrow: 'Growth',
    title: years >= 1.5 ? `${cap(words(Math.round(years)))} years,` : 'One history,',
    em: 'one city.',
    body:
      spurt && spurt.added > 0
        ? `Each building is a file, rising the day it was created. The busiest month, ${new Date(spurt.t * 1000).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}, added ${fmt(spurt.added)} files.`
        : 'Each building is a file. It rises the day it is created and stays lit while people keep working in it.',
    stats: [
      { label: 'commits', value: r.meta.commits },
      { label: 'files', value: r.meta.files },
      { label: 'people', value: r.meta.people },
    ],
    key: orbitKey([0, 2, 0], Math.max(60, w.radius * 1.7), 2.1, 0.62, 52),
    t: spurt ? Math.max(norm(spurt.t + 31 * 86400), 0.35) : 0.7,
    hot: 0.3,
    exposure: 1,
    focus: -1,
  });

  // 3. Hot streets: the top hotspot.
  const hi = r.insights.hotspots[0];
  const hf = hi === undefined ? undefined : r.files[hi];
  if (hi !== undefined && hf) {
    const top = fileTop(w, hi);
    out.push({
      id: 'hot',
      eyebrow: 'Hot streets',
      title: 'Some files',
      em: 'never settle.',
      body: `The red beacons mark files changed at least five times in the last year by three people or fewer. That is where regressions tend to start. ${r.insights.hotspots.length > 1 ? `There are ${fmt(r.insights.hotspots.length)} here.` : ''}`.trim(),
      callout: { at: top, name: hf.path, meta: `${fmt(hf.changes_12m)} changes in the last 12 months`, hot: true },
      key: orbitKey([top[0], top[1] * 0.6, top[2]], 26, 3.4, 0.42, 48),
      t: 1,
      hot: 1,
      exposure: 1.02,
      focus: hf.dir,
    });
  }

  // 4. Quiet quarters: the longest-dormant district.
  const qi = r.insights.quiet[0];
  const qd = qi === undefined ? undefined : r.dirs[qi];
  const qdist = qi === undefined ? undefined : w.dists[qi];
  if (qi !== undefined && qd && qdist) {
    const idle = (r.meta.span[1] - qd.last) / YEAR;
    out.push({
      id: 'quiet',
      eyebrow: 'Quiet quarters',
      title: 'Nothing here has moved in',
      em: idle >= 2 ? `over ${words(Math.floor(idle))} years.` : 'two years.',
      body: `${qd.name}: ${fmt(qd.files)} files, last changed ${date(qd.last)}. Dark windows, thick fog. Nobody remembers why it works, so nobody dares to touch it.`,
      callout: { at: [qdist.x, 4, qdist.z], name: `${qd.name}/`, meta: `${fmt(qd.files)} files \u00b7 quiet for ${idle.toFixed(1)} years`, hot: false },
      key: orbitKey([qdist.x, 1.5, qdist.z], Math.max(22, qdist.r * 2.2), 4.6, 0.5, 50),
      t: 1,
      hot: 0.4,
      exposure: 0.86,
      focus: qi,
    });
  }

  // 5. The people: the district with the lowest bus factor (commit-weighted, and said so).
  const bi = r.insights.bus_factor[0];
  const bd = bi === undefined ? undefined : r.dirs[bi];
  const bdist = bi === undefined ? undefined : w.dists[bi];
  if (bi !== undefined && bd && bdist && bd.bus_factor > 0) {
    const n = bd.bus_factor;
    out.push({
      id: 'people',
      eyebrow: 'The people',
      title: n === 1 ? 'One person' : `${cap(words(n))} people`,
      em: `made at least half of all commits to ${bd.name}.`,
      body: `Each lantern is a contributor moving between the files they work on. If ${n === 1 ? 'that person' : 'they'} left tomorrow, who could explain ${bd.name}? (Counted by commits, not by lines.)`,
      callout: { at: [bdist.x, 6, bdist.z], name: `${bd.name}/`, meta: `bus factor ${n} \u00b7 ${fmt(bd.files)} files`, hot: false },
      key: orbitKey([bdist.x, 2, bdist.z], Math.max(26, bdist.r * 2.4), 5.8, 0.55, 50),
      t: 1,
      hot: 0.6,
      exposure: 1,
      focus: bi,
    });
  }

  // 6. Yours: hand over the controls.
  out.push({
    id: 'explore',
    eyebrow: 'Yours',
    title: 'Now',
    em: 'look around.',
    body: 'Drag to orbit, scroll to zoom, hover any building for its numbers, or open the table view.',
    key: orbitKey([0, 4, 0], Math.max(60, w.radius * 1.55), 0.6, 0.55, 50),
    t: 1,
    hot: 1,
    exposure: 1,
    focus: -1,
  });
  return out;
}
