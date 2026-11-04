import { describe, expect, it } from 'vitest';
import { buildWorld, CELL, INST } from './build';
import { sample } from './build.test';
import { caption, EYE, poseAt, stopAt, walkRoute } from './route';

describe('walkRoute', () => {
  const w = buildWorld(sample());
  const route = walkRoute(w);

  it('visits the hotspots, the park and the quiet district, standing on each island\'s shore', () => {
    const kinds = route.stops.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'hotspot')).toHaveLength(2);
    expect(kinds).toContain('park'); // every file in tests/ is a tree
    expect(kinds).toContain('quiet'); // legacy/
    for (const s of route.stops) {
      const d = w.dists[s.dir]!;
      expect(Math.hypot(s.stand[0] - d.x, s.stand[2] - d.z)).toBeGreaterThan(d.r);
    }
    expect(route.lift).toHaveLength(route.stops.length - 1);
  });

  it('stands at each stop facing it, and never walks through a building', () => {
    route.stops.forEach((s, k) => {
      const p = poseAt(route, k);
      p.pos.forEach((v, i) => expect(v).toBeCloseTo(s.stand[i]!, 6));
      p.tgt.forEach((v, i) => expect(v).toBeCloseTo(s.look[i]!, 6));
      expect(stopAt(route, k + 0.05)).toBe(k);
    });
    for (let s = 0; s <= route.stops.length - 1; s += 0.01) {
      const { pos } = poseAt(route, s);
      for (let o = 0; o < w.inst.length; o += INST) {
        const inside = Math.abs(pos[0] - w.inst[o]!) < CELL / 2 && Math.abs(pos[2] - w.inst[o + 1]!) < CELL / 2;
        if (inside) expect(pos[1], `s=${s.toFixed(2)}`).toBeGreaterThan(0.28 + w.inst[o + 4]!);
      }
    }
    expect(stopAt(route, 0.5)).toBe(-1);
    expect(poseAt(route, -3)).toEqual(poseAt(route, 0)); // clamped
  });

  it('captions say what each stop is, with its numbers', () => {
    const hot = route.stops.find((s) => s.kind === 'hotspot')!;
    expect(caption(w, hot).body).toMatch(/^Hotspot: \d+ changes in the last 12 months/);
    expect(caption(w, route.stops.find((s) => s.kind === 'park')!).body).toBe('A park: 10 of its 10 files are tests, each one a tree.');
    expect(EYE).toBeGreaterThan(0.28);
  });
});
