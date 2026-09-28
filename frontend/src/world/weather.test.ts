import { expect, it } from 'vitest';
import type { Result } from '../lib/result';
import { weather } from './weather';

const res = (acts: number[], quiet: boolean[]): Result =>
  ({
    dirs: quiet.map((q, i) => ({ name: `d${i}`, files: 10 - i, quiet: q })),
    files: acts.map((n, i) => ({ dir: i, changes_12m: n })),
  }) as unknown as Result;

it('rains on the busiest quarter of active districts and fogs the quiet ones', () => {
  const w = weather(res([5, 50, 0, 20, 1, 3, 9, 2], [false, false, true, false, false, true, false, false]));
  expect(w.rain).toEqual([1, 3]); // 7 active districts -> top 2
  expect(w.fog).toEqual([2, 5]); // larger first
});

it('a repo with one active district still gets a shower; none active, no rain', () => {
  expect(weather(res([0, 4], [false, false])).rain).toEqual([1]);
  expect(weather(res([0, 0], [true, false])).rain).toEqual([]);
});
