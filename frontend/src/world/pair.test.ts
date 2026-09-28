import { expect, it } from 'vitest';
import type { Result } from '../lib/result';
import { INST } from './build';
import { mergeResults, pair } from './pair';

const f = (path: string, dir: number, birth: number) => ({ path, dir, loc: 40, birth, last: birth + 10, changes: 3, changes_12m: 1, authors: 1, hot: false, dead: false, quarters: [] });
const res = (repo: string, span: [number, number], files: ReturnType<typeof f>[], dirs: string[]): Result =>
  ({
    meta: { repo, sha: 'a'.repeat(40), analyser: 5, generated_at: 0, commits: 10, files: files.length, people: 1, span, truncated: { files: false, commits: false, sizes: false } },
    dirs: dirs.map((name, i) => ({ name, files: files.filter((x) => x.dir === i).length, loc: 1, last: span[1], bus_factor: 1, quiet: false, owners: [{ person: 0, share: 1 }] })),
    files,
    coupling: [{ a: 0, b: 1, count: 2, strength: 0.5 }],
    people: [{ handle: 'Contributor 1', commits: 10, areas: [0] }],
    insights: { hotspots: [1], bus_factor: [0], quiet: [], coupling: [0] },
    timeline: [{ t: span[0], commits: 4, added: 2, removed: 0 }],
  }) as unknown as Result;

const A = res('acme/a', [1000, 5000], [f('x/1.py', 0, 1000), f('x/2.py', 0, 2000)], ['x']);
const B = res('acme/b', [3000, 9000], [f('y/1.go', 0, 3000), f('z/2.go', 1, 4000), f('z/3.go', 1, 8000)], ['y', 'z']);

it('merges results with B shifted after A, owners dropped and people labelled', () => {
  const m = mergeResults(A, B);
  expect(m.files.map((x) => [x.path, x.dir])).toEqual([['x/1.py', 0], ['x/2.py', 0], ['y/1.go', 1], ['z/2.go', 2], ['z/3.go', 2]]);
  expect(m.dirs.map((d) => d.name)).toEqual(['acme/a › x', 'acme/b › y', 'acme/b › z']);
  expect(m.dirs.every((d) => d.owners === undefined)).toBe(true);
  expect(m.coupling[1]).toMatchObject({ a: 2, b: 3 });
  expect(m.insights.hotspots).toEqual([1, 3]);
  expect(m.people.map((p) => p.handle)).toEqual(['acme/a · Contributor 1', 'acme/b · Contributor 1']);
  expect(m.meta.span).toEqual([1000, 9000]);
  expect(m.meta.files).toBe(5);
});

it('lays the two cities out on separate islands on one calendar', () => {
  const p = pair(A, B);
  expect(p.split).toBe(2);
  const xs = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => p.world.inst[(from + k) * INST]!);
  expect(Math.max(...xs(0, 2))).toBeLessThan(Math.min(...xs(2, 5))); // A west of B
  expect(p.world.inst[2 * INST + 12]).toBeGreaterThanOrEqual(1); // B's district indices come after A's
  expect([p.world.t0, p.world.t1]).toEqual([1000, 9000]);
  // Shared calendar: a file born at 3000 sits at the same normalised time in either city.
  expect(p.world.inst[2 * INST + 5]).toBeCloseTo((3000 - 1000) / 8000, 5);
});
