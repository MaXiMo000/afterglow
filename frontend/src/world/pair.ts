/**
 * Two cities side by side (docs/ROADMAP.md #11). Each repository is laid out as its own city with the same
 * building rules (heights use one absolute scale), on one shared calendar (both normalised to the union of their
 * spans, so the timeline shows both at the same real date), then placed on neighbouring islands: A to the west,
 * B to the east. The merged result keeps A's files first, so a building index below `split` is A's.
 */
import type { Month, Result } from '../lib/result';
import { buildWorld, INST, type World } from './build';
import { fileTypes } from './types';

/** Both together must stay within one city's file budget (PLAN section 6). */
export const PAIR_MAX_FILES = 50_000;
const GAP = 24;

/** `centres`: the islands' x positions (A, B), for the name labels. */
export type Pair = { a: Result; b: Result; split: number; world: World; result: Result; centres: [number, number] };

export function pair(a: Result, b: Result): Pair {
  const span: [number, number] = [Math.min(a.meta.span[0], b.meta.span[0]), Math.max(a.meta.span[1], b.meta.span[1])];
  const onSpan = (r: Result): Result => ({ ...r, meta: { ...r.meta, span } });
  const wa = buildWorld(onSpan(a));
  const wb = buildWorld(onSpan(b));
  const offset = wa.radius + wb.radius + GAP; // island centres this far apart
  const ax = -offset * (wb.radius / (wa.radius + wb.radius)); // keep the pair centred on the origin
  const bx = ax + offset;
  const split = a.files.length;
  const nd = a.dirs.length;

  const shiftInst = (src: Float32Array, dx: number, dirOffset: number): Float32Array => {
    const out = src.slice();
    for (let o = 0; o < out.length; o += INST) {
      out[o] = out[o]! + dx;
      out[o + 12] = out[o + 12]! + dirOffset;
    }
    return out;
  };
  const shiftPos = (src: Float32Array, dx: number): Float32Array => {
    const out = src.slice();
    for (let i = 0; i < out.length; i += 3) out[i] = out[i]! + dx;
    return out;
  };
  const inst = new Float32Array(wa.inst.length + wb.inst.length);
  inst.set(shiftInst(wa.inst, ax, 0), 0);
  inst.set(shiftInst(wb.inst, bx, nd), wa.inst.length);
  const pos = new Float32Array(wa.pos.length + wb.pos.length);
  pos.set(shiftPos(wa.pos, ax), 0);
  pos.set(shiftPos(wb.pos, bx), wa.pos.length);
  const curves = [...wa.curves, ...wb.curves].map((c, k) => {
    const pts = c.pts.slice();
    const dx = k < wa.curves.length ? ax : bx;
    for (let i = 0; i < pts.length; i += 4) pts[i] = pts[i]! + dx;
    return { ...c, pts };
  });

  const result = mergeResults(a, b);
  const world: World = {
    ...wa,
    result,
    t0: span[0],
    t1: Math.max(span[1], span[0] + 1),
    dists: [...wa.dists.map((d) => ({ ...d, x: d.x + ax })), ...wb.dists.map((d) => ({ ...d, x: d.x + bx, index: d.index + nd }))],
    inst,
    pos,
    hot: [...wa.hot, ...wb.hot.map((i) => i + split)],
    curves,
    lanterns: [...wa.lanterns, ...wb.lanterns].map((l, k) => ({ ...l, wp: l.wp.map(([x, y, z]) => [x + (k < wa.lanterns.length ? ax : bx), y, z] as [number, number, number]) })),
    radius: Math.max(Math.abs(ax) + wa.radius, bx + wb.radius),
    heightFromChanges: wa.heightFromChanges || wb.heightFromChanges,
    types: fileTypes(result),
  };
  return { a, b, split, world, result, centres: [ax, bx] };
}

/**
 * One result for the pair, A's parts first. Kept to what stays true of a merged view: owners are dropped (people
 * indices belong to each repository), people are relabelled "repo · Contributor N", the timeline is summed by month.
 */
export function mergeResults(a: Result, b: Result): Result {
  const nfa = a.files.length;
  const nda = a.dirs.length;
  const nca = a.coupling.length;
  const label = (r: Result) => (p: Result['people'][number]) => ({ ...p, handle: `${r.meta.repo} · ${p.handle}`, areas: [] });
  const months = new Map<number, Month>();
  for (const m of [...a.timeline, ...b.timeline]) {
    const x = months.get(m.t);
    months.set(m.t, x ? { t: m.t, commits: x.commits + m.commits, added: x.added + m.added, ...(x.removed !== undefined && m.removed !== undefined ? { removed: x.removed + m.removed } : {}) } : { ...m });
  }
  return {
    meta: {
      ...a.meta,
      files: a.meta.files + b.meta.files,
      commits: a.meta.commits + b.meta.commits,
      people: a.meta.people + b.meta.people,
      span: [Math.min(a.meta.span[0], b.meta.span[0]), Math.max(a.meta.span[1], b.meta.span[1])],
      truncated: {
        files: a.meta.truncated.files || b.meta.truncated.files,
        commits: a.meta.truncated.commits || b.meta.truncated.commits,
        sizes: a.meta.truncated.sizes || b.meta.truncated.sizes,
      },
    },
    dirs: [...a.dirs, ...b.dirs].map(({ owners: _o, ...d }, i) => ({ ...d, name: `${i < nda ? a.meta.repo : b.meta.repo} › ${d.name}` })),
    files: [...a.files, ...b.files.map((f) => ({ ...f, dir: f.dir + nda }))],
    coupling: [...a.coupling, ...b.coupling.map((c) => ({ ...c, a: c.a + nfa, b: c.b + nfa }))],
    people: [...a.people.map(label(a)), ...b.people.map(label(b))],
    insights: {
      hotspots: [...a.insights.hotspots, ...b.insights.hotspots.map((i) => i + nfa)],
      bus_factor: [...a.insights.bus_factor, ...b.insights.bus_factor.map((i) => i + nda)],
      quiet: [...a.insights.quiet, ...b.insights.quiet.map((i) => i + nda)],
      coupling: [...a.insights.coupling, ...b.insights.coupling.map((i) => i + nca)],
    },
    timeline: [...months.values()].sort((x, y) => x.t - y.t),
  };
}

/** Side-by-side numbers for the comparison panel: each is a plain count or sum of the result's fields. */
export function pairStats(r: Result): { label: string; value: number }[] {
  const years = (r.meta.span[1] - r.meta.span[0]) / (365.25 * 86400);
  return [
    { label: 'files', value: r.meta.files },
    { label: 'commits analysed', value: r.meta.commits },
    { label: 'people', value: r.meta.people },
    { label: 'hotspots', value: r.insights.hotspots.length },
    { label: 'bus-factor-1 districts', value: r.dirs.filter((d) => d.bus_factor === 1 && d.files >= 5).length },
    { label: 'changes (12 mo)', value: r.files.reduce((n, f) => n + f.changes_12m, 0) },
    { label: 'years analysed', value: Math.round(years * 10) / 10 },
  ];
}
