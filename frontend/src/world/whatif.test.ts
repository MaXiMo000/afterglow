import { expect, it } from 'vitest';
import type { Result } from '../lib/result';
import { orphaned } from './whatif';

const r = {
  meta: { analyser: 5 },
  dirs: [
    { owners: [{ person: 0, share: 0.95 }, { person: 1, share: 0.05 }] }, // only 0 knows it
    { owners: [{ person: 0, share: 0.6 }, { person: 2, share: 0.4 }] }, // 2 also knows it
    { owners: [{ person: 1, share: 1 }] }, // 0 never touched it
    { owners: [{ person: 0, share: 0.5 }, { person: 1, share: 0.1 }] }, // 1 is exactly at the threshold
    {}, // older analysis without owners
  ],
} as unknown as Result;

it('lists districts where nobody else has 10%+ of the commits', () => {
  expect(orphaned(r, 0)).toEqual([0]);
  expect(orphaned(r, 1)).toEqual([2]);
  expect(orphaned(r, 2)).toEqual([]);
});
