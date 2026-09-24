import { describe, expect, it } from 'vitest';
import { buildWorld } from '../world/build';
import { sample } from '../world/build.test';
import { buildChapters } from './chapters';
import { centers, chapterOpacity, pose } from './rig';

const r = sample(60);
const w = buildWorld(r);
const ch = buildChapters(r, w);

describe('chapters', () => {
  it('are derived from the data, in order, ending with explore', () => {
    expect(ch.map((c) => c.id)).toEqual(['first-light', 'growth', 'hot', 'quiet', 'people', 'explore']);
  });

  it('skip chapters the data does not support instead of inventing them', () => {
    const bare = { ...r, insights: { hotspots: [], bus_factor: [], quiet: [], coupling: [] } };
    const ids = buildChapters(bare, buildWorld(bare)).map((c) => c.id);
    expect(ids).toEqual(['first-light', 'growth', 'explore']);
  });

  it('say bus factor is commit-weighted and quote real numbers', () => {
    const people = ch.find((c) => c.id === 'people')!;
    expect(people.body).toContain('Counted by commits');
    const hot = ch.find((c) => c.id === 'hot')!;
    expect(hot.callout?.name).toBe(r.files[r.insights.hotspots[0]!]!.path);
  });
});

describe('rig', () => {
  it('is a pure function of scroll position (reverse scroll is symmetric)', () => {
    const forward = Array.from({ length: 201 }, (_, k) => pose(ch, k / 200));
    const backward = Array.from({ length: 201 }, (_, k) => pose(ch, (200 - k) / 200)).reverse();
    expect(backward).toEqual(forward);
  });

  it('rests exactly on each chapter key at its centre', () => {
    centers(ch.length).forEach((c, i) => {
      const p = pose(ch, c);
      for (let k = 0; k < 3; k++) {
        expect(p.pos[k]).toBeCloseTo(ch[i]!.key.pos[k]!, 9);
        expect(p.tgt[k]).toBeCloseTo(ch[i]!.key.tgt[k]!, 9);
      }
      expect(p.chapter).toBe(i);
    });
  });

  it('moves continuously (no jumps between frames) and never goes under water', () => {
    let prev = pose(ch, 0);
    for (let k = 1; k <= 2000; k++) {
      const cur = pose(ch, k / 2000);
      const step = Math.hypot(cur.pos[0] - prev.pos[0], cur.pos[1] - prev.pos[1], cur.pos[2] - prev.pos[2]);
      expect(step).toBeLessThan(5);
      expect(cur.pos[1]).toBeGreaterThanOrEqual(1.5);
      expect(Number.isFinite(cur.fov) && Number.isFinite(cur.t)).toBe(true);
      prev = cur;
    }
  });

  it('shows one chapter at a time at its centre', () => {
    const c = centers(ch.length);
    c.forEach((p, i) => {
      expect(chapterOpacity(ch.length, i, p)).toBe(1);
      ch.forEach((_, j) => j !== i && expect(chapterOpacity(ch.length, j, p)).toBe(0));
    });
  });
});
