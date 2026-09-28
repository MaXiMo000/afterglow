import { expect, it } from 'vitest';
import { drill, HERE, topPrefix } from './drill';
import type { Result } from './result';

const f = (path: string, dir: number, last = 99_000_000) => ({ path, dir, loc: 10, birth: 0, last, changes: 1, changes_12m: 0, authors: 1, hot: false, dead: false, quarters: [] });
const r = {
  meta: { repo: 'a/b', sha: 'a'.repeat(40), analyser: 5, generated_at: 0, commits: 1, files: 5, people: 1, span: [0, 100_000_000], truncated: { files: false, commits: false, sizes: false } },
  dirs: [{ name: 'core', files: 4 }, { name: 'docs', files: 1 }],
  files: [f('core/api/x.py', 0), f('core/api/y.py', 0), f('core/db/z.py', 0, 1), f('core/main.py', 0), f('docs/a.md', 1)],
  coupling: [{ a: 0, b: 1, count: 3, strength: 0.5 }, { a: 0, b: 4, count: 2, strength: 0.4 }],
  people: [{ handle: 'Contributor 1', commits: 5, areas: [0, 1] }],
  insights: { hotspots: [4, 1], bus_factor: [0], quiet: [], coupling: [1, 0] },
  timeline: [],
} as unknown as Result;

it('turns a district into a city of its next folder level', () => {
  const { result: s, prefixes } = drill(r, 0, topPrefix('core'));
  expect(s.dirs.map((d) => [d.name, d.files])).toEqual([['api', 2], ['db', 1], [HERE, 1]]);
  expect(prefixes).toEqual(['core/api', 'core/db', 'core']);
  expect(s.files.map((x) => [x.path, x.dir])).toEqual([['core/api/x.py', 0], ['core/api/y.py', 0], ['core/db/z.py', 1], ['core/main.py', 2]]);
  expect(s.coupling).toEqual([{ a: 0, b: 1, count: 3, strength: 0.5 }]); // the pair leaving the district is dropped
  expect(s.insights).toEqual({ hotspots: [1], bus_factor: [], quiet: [1], coupling: [0] }); // db is quiet (last = 1)
  expect(s.people[0]!.areas).toEqual([]);
  expect(s.meta.files).toBe(4);
});

it('drills again from a sub-city by prefix', () => {
  const first = drill(r, 0, 'core');
  const { result: s, prefixes } = drill(first.result, 0, first.prefixes[0]!);
  expect(s.dirs.map((d) => d.name)).toEqual([HERE]);
  expect(prefixes).toEqual(['core/api']);
});
