import { describe, expect, it } from 'vitest';
import { analysedFrom, quarterLabel, removedBetween, trend } from './history';
import type { FileRec, Result } from './result';

const HEAD = Date.UTC(2026, 8, 27) / 1000; // Q3 2026; quarter 0 is Q4 2024
const OLD = Date.UTC(2020, 0, 1) / 1000;
const res = (start = OLD, truncated = false): Result =>
  ({ meta: { span: [start, HEAD], truncated: { commits: truncated, files: false, sizes: false } } }) as Result;
const file = (quarters: number[], birth = OLD): FileRec => ({ quarters, birth }) as FileRec;

describe('trend', () => {
  it('needs eight quarters', () => {
    expect(trend(res(), file([]))).toBeNull();
  });
  it('heats, cools or holds', () => {
    expect(trend(res(), file([0, 1, 0, 0, 2, 3, 1, 4]))?.kind).toBe('heating');
    expect(trend(res(), file([5, 4, 3, 2, 1, 0, 0, 1]))?.kind).toBe('cooling');
    expect(trend(res(), file([1, 1, 1, 1, 1, 1, 1, 1]))?.kind).toBe('steady');
    expect(trend(res(), file([0, 0, 0, 0, 0, 0, 1, 1]))?.kind).toBe('steady'); // two changes is not a trend
  });
  it('calls files created inside the two years new, not heating', () => {
    expect(trend(res(), file([0, 0, 0, 0, 2, 3, 1, 4], Date.UTC(2025, 5, 1) / 1000))?.kind).toBe('new');
  });
  it('has no trend when a truncated history starts inside the two years', () => {
    const r = res(Date.UTC(2025, 7, 1) / 1000, true); // window starts in Q3 2025
    expect(analysedFrom(r)).toBe(4); // Q4 2024..Q2 2025 not read, Q3 2025 only partly
    expect(trend(r, file([0, 0, 0, 0, 2, 3, 1, 4]))).toBeNull();
    expect(analysedFrom(res(Date.UTC(2025, 7, 1) / 1000, false))).toBe(0); // not truncated: real zeros
    expect(analysedFrom(res(OLD, true))).toBe(0);
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
  expect(quarterLabel(HEAD, 7)).toBe('Q3 2026');
  expect(quarterLabel(HEAD, 0)).toBe('Q4 2024');
});
