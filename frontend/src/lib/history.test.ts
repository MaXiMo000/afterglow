import { describe, expect, it } from 'vitest';
import { quarterLabel, removedBetween, trend } from './history';
import type { Result } from './result';

describe('trend', () => {
  it('needs eight quarters', () => {
    expect(trend([])).toBeNull();
  });
  it('heats, cools or holds', () => {
    expect(trend([0, 1, 0, 0, 2, 3, 1, 4])?.kind).toBe('heating');
    expect(trend([5, 4, 3, 2, 1, 0, 0, 1])?.kind).toBe('cooling');
    expect(trend([1, 1, 1, 1, 1, 1, 1, 1])?.kind).toBe('steady');
    expect(trend([0, 0, 0, 0, 0, 0, 1, 1])?.kind).toBe('steady'); // two changes is not a trend
  });
});

describe('removedBetween', () => {
  const r = (months: Result['timeline']): Result => ({ timeline: months }) as Result;
  it('sums removals in the window', () => {
    const tl = [{ t: 10, commits: 1, added: 0, removed: 2 }, { t: 20, commits: 1, added: 0, removed: 3 }, { t: 30, commits: 1, added: 0, removed: 5 }];
    expect(removedBetween(r(tl), 10, 30)).toBe(8);
  });
  it('is unknown for older analyses', () => {
    expect(removedBetween(r([{ t: 10, commits: 1, added: 0 }]), 0, 20)).toBeNull();
  });
});

it('labels quarters back from HEAD', () => {
  const head = Date.UTC(2026, 8, 27) / 1000; // Q3 2026
  expect(quarterLabel(head, 7)).toBe('Q3 2026');
  expect(quarterLabel(head, 0)).toBe('Q4 2024');
});
