import { describe, expect, it } from 'vitest';
import { DynRes } from './dynres';

const run = (d: DynRes, ms: number, n: number): number => {
  let changes = 0;
  for (let i = 0; i < n; i++) if (d.frame(ms)) changes++;
  return changes;
};

describe('DynRes', () => {
  it('holds steady at 60 Hz vsync', () => {
    const d = new DynRes(2);
    expect(run(d, 16.7, 5000)).toBe(0);
    expect(d.scale).toBe(1);
  });

  it('steps down on sustained slow frames, then tier, never below the lowest tier', () => {
    const d = new DynRes(1);
    run(d, 30, 400);
    expect(d.tier).toBe(0);
    expect(d.scale).toBeGreaterThanOrEqual(0.6);
    expect(run(d, 30, 400)).toBe(0); // nothing left to drop: no pointless reallocations
  });

  it('recovers at 60 Hz after a hitch (the old controller never did)', () => {
    const d = new DynRes(2);
    run(d, 40, 60);
    expect(d.scale).toBeLessThan(1);
    run(d, 16.7, 6000);
    expect(d.scale).toBe(1);
  });

  it('a single long hitch (tab switch) changes nothing', () => {
    const d = new DynRes(2);
    expect(d.frame(1200)).toBe(false);
    expect(run(d, 16.7, 100)).toBe(0);
  });
});
