import { describe, expect, it } from 'vitest';
import type { Result } from '../lib/result';
import { CRANE_DAYS, livingCity, MAX_CRANES, STYLE, styleOf } from './living';

describe('styleOf', () => {
  it('turns test files into trees', () => {
    for (const p of ['tests/test_app.py', 'src/a.test.ts', 'pkg/api_test.go', 'spec/x_spec.rb', 'conftest.py', 'src/FooTest.java'])
      expect(styleOf(p), p).toBe(STYLE.tree);
  });
  it('turns docs into houses and generated or vendored files into warehouses', () => {
    for (const p of ['README.md', 'docs/guide.html', 'LICENSE', 'notes.txt']) expect(styleOf(p), p).toBe(STYLE.house);
    for (const p of ['package-lock.json', 'vendor/x/y.go', 'Cargo.lock', 'app.min.js', 'api.pb.go', 'x_pb2.py', 'go.sum'])
      expect(styleOf(p), p).toBe(STYLE.warehouse);
  });
  it('leaves ordinary source to size and age', () => {
    for (const p of ['src/app.py', 'contest.py', 'latest/app.ts', 'docsy.py']) expect(styleOf(p), p).toBeNull();
  });
});

describe('livingCity', () => {
  const DAY = 86400;
  const t1 = 1000 * DAY;
  const file = (path: string, o: Partial<Result['files'][number]> = {}) =>
    ({ path, loc: 10, changes: 1, changes_12m: 1, birth: 500 * DAY, last: 900 * DAY, dead: false, ...o }) as Result['files'][number];
  const result = (files: Result['files']): Result => ({ meta: { span: [0, t1] }, files }) as unknown as Result;

  it('picks towers by size and brick by age', () => {
    const files = [...Array.from({ length: 20 }, (_, i) => file(`s${i}.py`)), file('big.py', { loc: 5000 }), file('old.py', { birth: 10 * DAY, changes_12m: 0 })];
    const l = livingCity(result(files));
    expect(l.style[20]).toBe(STYLE.tower);
    expect(l.style[21]).toBe(STYLE.brick);
    expect(l.style[0]).toBe(STYLE.office);
    expect(l.counts.reduce((a, b) => a + b, 0)).toBe(files.length);
  });
  it('raises cranes only on recent, living, non-test files, at most MAX_CRANES', () => {
    const recent = t1 - (CRANE_DAYS - 1) * DAY;
    const files = [
      file('old.py'),
      file('dead.py', { last: recent, dead: true }),
      file('tests/t.py', { last: recent }),
      ...Array.from({ length: MAX_CRANES + 5 }, (_, i) => file(`r${i}.py`, { last: recent, changes_12m: i })),
    ];
    const l = livingCity(result(files));
    expect(l.crane[0]).toBe(0);
    expect(l.crane[1]).toBe(0);
    expect(l.crane[2]).toBe(0);
    expect(l.cranes).toBe(MAX_CRANES);
    expect(l.crane[files.length - 1]).toBe(1); // the most-changed recent file always gets one
    expect(l.crane[3]).toBe(0); // the least-changed is cut
  });
});
