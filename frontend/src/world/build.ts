/**
 * Turn a validated analysis result into a renderable world (docs/PLAN.md section 1 table: building = file,
 * height = size, lit windows = recent activity, beacon = hotspot, fog = quiet, lanterns = people, arcs = coupling).
 *
 * Nothing here is invented: every building is a real file at HEAD and every value comes from the result. The only
 * non-data choices are layout (positions) and decorative motion, which carry no meaning.
 */
import { clamp, hashStr, rng, type V3 } from '../render/math';
import type { Result } from '../lib/result';

export const CELL = 1.6;
/** Floats per building instance: iA(x,z,w,d) iB(h,birth,last,activity) iC(palette,seed,hot,dead) iD(district,0,0,0). */
export const INST = 16;

export type District = {
  index: number;
  name: string;
  x: number;
  z: number;
  r: number;
  birth: number; // normalised 0..1 on the history timeline
  last: number;
  act: number;
  pal: number;
};
export type Curve = { pts: Float32Array; n: number; s: number; birth: number };
export type Lantern = { wp: V3[]; off: number; speed: number };

export type World = {
  result: Result;
  seed: number;
  t0: number;
  t1: number;
  dists: District[];
  inst: Float32Array; // INST floats per file, same order as result.files
  pos: Float32Array; // x, top y, z per file (for callouts and camera flights)
  hot: number[]; // file indices with a beacon
  curves: Curve[];
  lanterns: Lantern[];
  radius: number;
  /** true when heights come from change counts because line counts were unavailable (must be labelled). */
  heightFromChanges: boolean;
};

/** Palette kinds (index into uPal/uRim): 0 core teal, 1 violet, 2 tests/infra blue, 3 docs amber, 4 quiet grey. */
function paletteFor(name: string, quiet: boolean, seed: number): number {
  if (quiet) return 4;
  const n = name.toLowerCase();
  if (/(^|\/)(tests?|specs?|__tests__|e2e|ci|\.github|infra|deploy|scripts?)($|\/)/.test(n)) return 2;
  if (/(^|\/)(docs?|examples?|site|website|docs_src)($|\/)/.test(n)) return 3;
  return seed & 1;
}

export function buildWorld(result: Result): World {
  const { meta, dirs, files } = result;
  const seed = hashStr(meta.repo + '@' + meta.sha);
  const R = rng(seed);
  const t0 = meta.span[0];
  const t1 = Math.max(meta.span[1], t0 + 1);
  const norm = (t: number): number => clamp((t - t0) / (t1 - t0), 0, 1);

  // Files per district, busiest first so the most-changed files stand at each district's centre.
  const members: number[][] = dirs.map(() => []);
  files.forEach((f, i) => members[f.dir]?.push(i));
  for (const m of members) m.sort((a, b) => (files[b]?.changes ?? 0) - (files[a]?.changes ?? 0));

  // District discs sized by file count, biggest in the middle, others on a golden-angle spiral, then relaxed.
  const order = dirs.map((_, i) => i).sort((a, b) => (members[b]?.length ?? 0) - (members[a]?.length ?? 0));
  const maxC12 = Math.max(1, ...files.map((f) => f.changes_12m));
  const D: District[] = dirs.map((d, i) => {
    const count = members[i]?.length ?? 0;
    return {
      index: i,
      name: d.name,
      x: 0,
      z: 0,
      r: Math.sqrt((Math.max(count, 1) * CELL * CELL) / 0.62 / Math.PI) + 1.6,
      birth: 1,
      last: 0,
      act: 0,
      pal: paletteFor(d.name, d.quiet, hashStr(d.name)),
    };
  });
  order.forEach((di, k) => {
    const d = D[di];
    if (!d || k === 0) return;
    const a = k * 2.39996 + R() * 0.3;
    const rad = 14 + Math.sqrt(k) * 22;
    d.x = Math.cos(a) * rad;
    d.z = Math.sin(a) * rad;
  });
  // ponytail: O(n^2) relaxation; iterations shrink with district count so 2,000 districts stays under ~50 ms.
  const iters = Math.max(20, Math.min(320, Math.floor(4e6 / Math.max(1, D.length * D.length))));
  const root = order[0] ?? 0;
  const separate = (gap: number): boolean => {
    let moved = false;
    for (let i = 0; i < D.length; i++)
      for (let j = i + 1; j < D.length; j++) {
        const a = D[i]!;
        const b = D[j]!;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const dist = Math.hypot(dx, dz) || 0.01;
        const min = a.r + b.r + gap;
        if (dist >= min) continue;
        moved = true;
        const push = (min - dist) / 2 + 0.01;
        dx /= dist;
        dz /= dist;
        if (i === root) {
          b.x += dx * push * 2;
          b.z += dz * push * 2;
        } else if (j === root) {
          a.x -= dx * push * 2;
          a.z -= dz * push * 2;
        } else {
          a.x -= dx * push;
          a.z -= dz * push;
          b.x += dx * push;
          b.z += dz * push;
        }
      }
    return moved;
  };
  for (let it = 0; it < iters; it++) {
    separate(4);
    for (const d of D) if (d.index !== root) (d.x *= 0.996), (d.z *= 0.996); // gentle pull keeps the city compact
  }
  for (let it = 0; it < 500 && separate(4 + CELL * 2); it++); // then no pull until nothing overlaps
  for (const d of D) {
    d.x = Math.round(d.x / CELL) * CELL; // snapping moves each centre by < 1.2 cells, inside the extra gap above
    d.z = Math.round(d.z / CELL) * CELL;
  }

  const heightFromChanges = meta.truncated.sizes && files.every((f) => f.loc === 0);
  const inst = new Float32Array(files.length * INST);
  const pos = new Float32Array(files.length * 3);
  for (const d of D) {
    const list = members[d.index] ?? [];
    // Grid cells inside the disc, nearest to the centre first.
    const rr = d.r - 1.4;
    const cells: [number, number, number][] = [];
    for (let gx = Math.floor((d.x - rr) / CELL); gx <= Math.ceil((d.x + rr) / CELL); gx++)
      for (let gz = Math.floor((d.z - rr) / CELL); gz <= Math.ceil((d.z + rr) / CELL); gz++) {
        const x = (gx + 0.5) * CELL;
        const z = (gz + 0.5) * CELL;
        const dd = Math.hypot(x - d.x, z - d.z);
        if (dd <= rr) cells.push([x, z, dd]);
      }
    cells.sort((a, b) => a[2] - b[2]);
    let actSum = 0;
    list.forEach((fi, k) => {
      const f = files[fi]!;
      const cell = cells[k] ?? cells[cells.length - 1] ?? [d.x, d.z, 0];
      const fs = hashStr(f.path) / 4294967296;
      const size = heightFromChanges ? f.changes * 8 : f.loc;
      const h = clamp(0.8 + Math.log2(1 + size / 20) * 1.05, 0.7, 15) * (f.hot ? 1.12 : 1);
      const birth = norm(f.birth);
      const last = Math.max(norm(f.last), birth + 0.001);
      const act = f.dead ? 0.05 : f.changes_12m > 0 ? clamp(0.25 + (0.75 * Math.log1p(f.changes_12m)) / Math.log1p(maxC12), 0, 0.98) : 0.08;
      const w = 0.72 + fs * 0.56;
      const dp = 0.72 + ((fs * 7.31) % 1) * 0.56;
      inst.set([cell[0], cell[1], w, dp, h, birth, last, act, d.pal, fs, f.hot ? 1 : 0, f.dead ? 1 : 0, d.index, 0, 0, 0], fi * INST);
      pos.set([cell[0], 0.28 + h, cell[1]], fi * 3);
      d.birth = Math.min(d.birth, birth);
      d.last = Math.max(d.last, last);
      actSum += act;
    });
    d.act = list.length ? actSum / list.length : 0;
  }

  const hot = files.map((f, i) => (f.hot ? i : -1)).filter((i) => i >= 0);

  // Coupling arcs between districts: file-level co-change pairs summed per district pair (strongest 16).
  const pairCount = new Map<string, number>();
  for (const c of result.coupling) {
    const a = files[c.a]!.dir;
    const b = files[c.b]!.dir;
    if (a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + c.count);
  }
  const pairs = [...pairCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 16);
  const top = pairs[0]?.[1] ?? 1;
  const curves: Curve[] = pairs.map(([key, n]) => {
    const [ia, ib] = key.split(',').map(Number) as [number, number];
    const A = D[ia]!;
    const B = D[ib]!;
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const L = Math.hypot(dx, dz) || 1;
    const sx = A.x + (dx / L) * A.r * 0.9;
    const sz = A.z + (dz / L) * A.r * 0.9;
    const ex = B.x - (dx / L) * B.r * 0.9;
    const ez = B.z - (dz / L) * B.r * 0.9;
    const mx = (sx + ex) / 2;
    const mz = (sz + ez) / 2;
    const my = 5 + L * 0.08;
    const pts = new Float32Array(57 * 4);
    for (let i = 0; i <= 56; i++) {
      const u = i / 56;
      const a1 = (1 - u) * (1 - u);
      const b1 = 2 * (1 - u) * u;
      const c1 = u * u;
      pts.set([a1 * sx + b1 * mx + c1 * ex, 0.7 + b1 * my * 0.5, a1 * sz + b1 * mz + c1 * ez, u], i * 4);
    }
    return { pts, n: 57, s: 0.3 + 0.7 * (n / top), birth: Math.max(A.birth, B.birth) + 0.02 };
  });

  // Lanterns: the most active contributors, each roaming the busiest files of the districts they work in.
  const lanterns: Lantern[] = result.people.slice(0, 14).flatMap((p) => {
    const wp: V3[] = [];
    for (let k = 0; k < 6; k++) {
      const area = p.areas[k % Math.max(1, p.areas.length)];
      const list = area === undefined ? undefined : members[area];
      if (!list || !list.length) continue;
      const fi = list[Math.floor(R() * Math.min(list.length, 12))]!;
      wp.push([pos[fi * 3]!, pos[fi * 3 + 1]! + 1.4, pos[fi * 3 + 2]!]);
    }
    return wp.length ? [{ wp, off: R() * 10, speed: 0.5 + R() * 0.6 }] : [];
  });

  let radius = 20;
  for (const d of D) radius = Math.max(radius, Math.hypot(d.x, d.z) + d.r);

  return { result, seed, t0, t1, dists: D, inst, pos, hot, curves, lanterns, radius, heightFromChanges };
}
