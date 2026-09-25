import { describe, expect, it } from 'vitest';
import { decodeView, encodeView } from './share';

describe('share links (T15)', () => {
  it('round-trips a view', () => {
    const v = { repo: { owner: 'pallets', name: 'flask' }, cam: { yaw: 7.5, pitch: 0.5, dist: 80, x: -3.25, z: 12 }, t: 0.5 };
    const back = decodeView(encodeView(v))!;
    expect(back.repo).toEqual(v.repo);
    expect(back.cam!.yaw).toBeCloseTo(7.5 - 2 * Math.PI, 3);
    expect(back.cam!.dist).toBe(80);
    expect(back.t).toBe(0.5);
  });

  it.each([
    '#v=1&r=a/b&c=1,2,3,4,5&t=0.5&x=1', // unknown key
    '#v=1&r=a/b&r=c/d', // duplicate key
    '#v=2&r=a/b', // unknown version
    '#v=1&r=https://evil.example/a', // not owner/name
    '#v=1&r=a/b&c=1,2,3', // wrong arity
    '#v=1&r=a/b&c=NaN,0.5,80,0,0',
    '#v=1&r=a/b&c=1e9,0.5,80,0,0',
    '#v=1&r=a/b&c=1,0.5,80,0,Infinity',
    '#v=1&r=a/b&t=2', // out of range
    '#v=1&r=a/b&t=<img src=x onerror=alert(1)>',
    '#v=1&r=a%2Fb',
    '#v=1&r=a/b&' + 'x'.repeat(400),
    'v=1&r=a/b', // no hash
    '#chapter-3',
  ])('rejects %j', (hash) => {
    expect(decodeView(hash)).toBeNull();
  });

  it('accepts a bare repo link', () => {
    expect(decodeView('#v=1&r=fastapi/typer')).toEqual({ repo: { owner: 'fastapi', name: 'typer' }, cam: null, t: null });
  });
});
