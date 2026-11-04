/**
 * Scroll walk: a street-level route through the city's most telling places, driven by a single progress value
 * (scroll, arrows, swipe). Stops are real findings: hotspots, the biggest park (tests), a quiet district and a
 * crane site. The walker stands on each island's shore facing the stop, and crosses the water between islands,
 * lifted just enough to clear any towers on the way: that lift is camera movement only, it carries no meaning.
 */
import { clamp, lerp, smoothstep, type V3 } from '../render/math';
import { CELL, INST, type World } from './build';
import { STYLE } from './living';

export type StopKind = 'hotspot' | 'park' | 'quiet' | 'crane';
/** `file` is the building looked at (-1 for a whole district); `stand` is where the walker stops. */
export type Stop = { kind: StopKind; file: number; dir: number; look: V3; stand: V3 };
export type Route = { stops: Stop[]; lift: number[] };

export const EYE = 1.9;
export const MAX_HOTSPOTS = 6;
const SHORE = 3.5; // stand this far outside the district's edge: far enough to see the stop above the front row

/** Pick the stops (in walking order, nearest-next from the first hotspot) and the clearance for each leg. */
export function walkRoute(w: World): Route {
  const { result: r, dists, pos, inst } = w;
  const picks: Omit<Stop, 'stand'>[] = [];
  const at = (fi: number): V3 => [pos[fi * 3]!, pos[fi * 3 + 1]!, pos[fi * 3 + 2]!];
  for (const fi of r.insights.hotspots.slice(0, MAX_HOTSPOTS)) picks.push({ kind: 'hotspot', file: fi, dir: r.files[fi]!.dir, look: at(fi) });
  const count = new Array<number>(dists.length).fill(0);
  for (const f of r.files) count[f.dir]!++;
  const trees = (i: number): number => (dists[i]?.park ?? 0) * (count[i] ?? 0);
  const park = [...dists].filter((d) => d.park >= 0.3 && trees(d.index) >= 5).sort((a, b) => trees(b.index) - trees(a.index))[0];
  if (park) picks.push({ kind: 'park', file: -1, dir: park.index, look: [park.x, 1, park.z] });
  const quiet = [...dists].filter((d) => r.dirs[d.index]?.quiet).sort((a, b) => b.r - a.r)[0];
  if (quiet) picks.push({ kind: 'quiet', file: -1, dir: quiet.index, look: [quiet.x, 1.5, quiet.z] });
  const crane = r.files.findIndex((_, i) => w.living.crane[i] === 1 && !picks.some((p) => p.file === i));
  if (crane >= 0) picks.push({ kind: 'crane', file: crane, dir: r.files[crane]!.dir, look: at(crane) });
  if (!picks.length) {
    // No findings at all: still walk to the biggest district.
    const big = [...dists].sort((a, b) => b.r - a.r)[0];
    if (big) picks.push({ kind: 'quiet', file: -1, dir: big.index, look: [big.x, 1.5, big.z] });
  }

  // Walking order: nearest next, starting with the first pick (the hottest file, when there is one).
  const order: Omit<Stop, 'stand'>[] = [];
  const left = [...picks];
  let cur = left.shift();
  while (cur) {
    order.push(cur);
    const c = cur;
    left.sort((a, b) => Math.hypot(a.look[0] - c.look[0], a.look[2] - c.look[2]) - Math.hypot(b.look[0] - c.look[0], b.look[2] - c.look[2]));
    cur = left.shift();
  }

  // Stand on the shore of the stop's island, on the side facing where the walker comes from.
  const stops: Stop[] = [];
  let from: [number, number] = [w.radius, w.radius]; // first approach: from the south-east, over the water
  for (const p of order) {
    const d = dists[p.dir]!;
    let ux = from[0] - d.x;
    let uz = from[1] - d.z;
    const len = Math.hypot(ux, uz) || 1;
    ux /= len;
    uz /= len;
    const stand: V3 = [d.x + ux * (d.r + SHORE), EYE, d.z + uz * (d.r + SHORE)];
    stops.push({ ...p, stand });
    from = [stand[0], stand[2]];
  }

  // Tallest building near each leg, so the walk can rise over it instead of passing through walls.
  const tall = new Map<number, number>();
  for (let o = 0; o < inst.length; o += INST) {
    const k = key(Math.floor(inst[o]! / CELL), Math.floor(inst[o + 1]! / CELL));
    tall.set(k, Math.max(tall.get(k) ?? 0, 0.28 + inst[o + 4]!));
  }
  const lift = stops.slice(1).map((s, i) => {
    const a = stops[i]!.stand;
    let top = 0;
    for (let u = 0; u <= 1; u += 1 / 48) {
      const gx = Math.floor(lerp(a[0], s.stand[0], u) / CELL);
      const gz = Math.floor(lerp(a[2], s.stand[2], u) / CELL);
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) top = Math.max(top, tall.get(key(gx + ox, gz + oz)) ?? 0);
    }
    return top ? Math.max(0, top + 1.2 - EYE) : 0;
  });
  return { stops, lift };
}

/** Camera pose at progress `s` (stop k at s = k): walk the leg, rise over what is in the way, turn to face the stop. */
export function poseAt(route: Route, s: number): { pos: V3; tgt: V3 } {
  const { stops, lift } = route;
  const n = stops.length;
  s = clamp(s, 0, n - 1);
  const k = Math.min(Math.floor(s), n - 2);
  if (n === 1 || k < 0) return { pos: [...stops[0]!.stand], tgt: [...stops[0]!.look] };
  const a = stops[k]!;
  const b = stops[k + 1]!;
  const u = s - k;
  const e = smoothstep(0, 1, u);
  const rise = (lift[k] ?? 0) * smoothstep(0, 0.2, u) * smoothstep(1, 0.8, u);
  const pos: V3 = [lerp(a.stand[0], b.stand[0], e), EYE + rise, lerp(a.stand[2], b.stand[2], e)];
  // Leave looking at the last stop, walk looking ahead, arrive looking at the next one.
  const ahead: V3 = [pos[0] + (b.stand[0] - a.stand[0]), EYE + rise * 0.6, pos[2] + (b.stand[2] - a.stand[2])];
  const from = smoothstep(0.25, 0, u);
  const to = smoothstep(0.6, 1, u);
  const tgt: V3 = [0, 1, 2].map((i) => lerp(lerp(ahead[i]!, a.look[i]!, from), b.look[i]!, to)) as V3;
  return { pos, tgt };
}

/** The stop the walker is at (within a short distance of it), or -1 while walking between stops. */
export function stopAt(route: Route, s: number): number {
  const k = Math.round(s);
  return Math.abs(s - k) < 0.12 && k >= 0 && k < route.stops.length ? k : -1;
}

/** Plain-language caption for a stop: what it is, and the numbers that put it on the route. */
export function caption(w: World, stop: Stop): { title: string; body: string } {
  const r = w.result;
  const d = r.dirs[stop.dir];
  if (stop.kind === 'park') {
    const mine = r.files.flatMap((f, i) => (f.dir === stop.dir ? [i] : []));
    const n = mine.filter((i) => w.living.style[i] === STYLE.tree).length;
    return { title: d?.name ?? '', body: `A park: ${n} of its ${mine.length} files are tests, each one a tree.` };
  }
  if (stop.kind === 'quiet') {
    return { title: d?.name ?? '', body: d?.quiet ? `Quiet for over two years: ${d.files} files nobody has changed since.` : `The biggest district: ${d?.files ?? 0} files.` };
  }
  const f = r.files[stop.file]!;
  const name = f.path.slice(f.path.lastIndexOf('/') + 1);
  if (stop.kind === 'crane') return { title: name, body: `Under construction: changed in the last days of the analysed history, in ${d?.name ?? ''}.` };
  const people = f.authors === 1 ? '1 person' : `${f.authors} people`;
  return { title: name, body: `Hotspot: ${f.changes_12m} changes in the last 12 months, by ${people} in all, in ${d?.name ?? ''}.` };
}

const key = (gx: number, gz: number): number => (gx + 4096) * 8192 + (gz + 4096);
