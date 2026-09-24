import { describe, expect, it } from 'vitest';
import { validateResult, type Result } from '../lib/result';
import { buildWorld, INST } from './build';

export function sample(nFiles = 40): Result {
  const dirs = ['core', 'tests', 'docs', 'legacy'].map((name, i) => ({
    name, files: 0, loc: 0, last: 1_700_000_000, bus_factor: 1 + i, quiet: name === 'legacy',
  })); // prettier-ignore
  const files = Array.from({ length: nFiles }, (_, i) => ({
    path: `${dirs[i % 4]!.name}/f${i}.py`, dir: i % 4, loc: 10 + i * 7, birth: 1_600_000_000 + i * 1000,
    last: 1_700_000_000 - i, changes: 1 + ((50 - i) & 63), changes_12m: i % 4 === 3 ? 0 : 20 - (i % 20), authors: 1 + (i % 3),
    hot: i < 2, dead: i % 4 === 3,
  })); // prettier-ignore
  return validateResult({
    meta: {
      repo: 'acme/orbit', sha: 'a'.repeat(40), analyser: 1, generated_at: 1_700_000_100, commits: 500,
      files: nFiles, people: 3, span: [1_600_000_000, 1_700_000_000],
      truncated: { files: false, commits: false, sizes: false },
    },
    dirs,
    files,
    coupling: [{ a: 0, b: 1, count: 9, strength: 0.8 }, { a: 4, b: 8, count: 3, strength: 0.4 }],
    people: [{ handle: 'Contributor 1', commits: 300, areas: [0, 1] }, { handle: 'Contributor 2', commits: 100, areas: [2] }],
    insights: { hotspots: [0, 1], bus_factor: [0], quiet: [3], coupling: [0] },
    timeline: [{ t: 1_600_000_000, commits: 10, added: 5 }],
  }); // prettier-ignore
}

describe('buildWorld', () => {
  it('places every file once, inside its district, with normalised times', () => {
    const r = sample();
    const w = buildWorld(r);
    expect(w.inst.length).toBe(r.files.length * INST);
    const seen = new Set<string>();
    r.files.forEach((f, i) => {
      const [x, z, , , h, birth, last, act, pal, , hot, dead, dist] = w.inst.subarray(i * INST, i * INST + INST);
      const d = w.dists[f.dir]!;
      expect(dist).toBe(f.dir);
      expect(Math.hypot(x! - d.x, z! - d.z)).toBeLessThanOrEqual(d.r);
      expect(seen.has(`${x},${z}`)).toBe(false);
      seen.add(`${x},${z}`);
      expect(h).toBeGreaterThan(0.6);
      expect(birth).toBeGreaterThanOrEqual(0);
      expect(last).toBeLessThanOrEqual(1.001);
      expect(act).toBeGreaterThan(0);
      expect(hot).toBe(f.hot ? 1 : 0);
      expect(dead).toBe(f.dead ? 1 : 0);
      if (f.dir === 3) expect(pal).toBe(4); // quiet district is grey
    });
    expect(w.hot).toEqual([0, 1]);
    expect(w.heightFromChanges).toBe(false);
  });

  it('districts do not overlap', () => {
    const w = buildWorld(sample(400));
    for (const a of w.dists)
      for (const b of w.dists) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(a.r + b.r);
  });

  it('is deterministic for the same repo and sha', () => {
    const a = buildWorld(sample());
    const b = buildWorld(sample());
    expect(Array.from(a.inst)).toEqual(Array.from(b.inst));
  });

  it('aggregates coupling across districts only', () => {
    const w = buildWorld(sample());
    expect(w.curves.length).toBe(1); // 0-1 is core-tests; 4-8 is core-core and must not become an arc
  });

  it('falls back to change counts when line counts are unavailable, and says so', () => {
    const r = sample();
    const noSizes: Result = {
      ...r,
      meta: { ...r.meta, truncated: { ...r.meta.truncated, sizes: true } },
      files: r.files.map((f) => ({ ...f, loc: 0 })),
    };
    expect(buildWorld(noSizes).heightFromChanges).toBe(true);
  });
});
