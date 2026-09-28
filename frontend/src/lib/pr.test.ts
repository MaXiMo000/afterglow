import { describe, expect, it } from 'vitest';
import { overlay, validatePr } from './pr';
import type { Result } from './result';

const sha = 'a'.repeat(40);
const good = {
  repo: 'acme/orbit', pr: 7, merge: sha, base: 'b'.repeat(40), truncated: false,
  changes: [
    { path: 'a.py', status: 'modified' },
    { path: 'b.py', status: 'deleted' },
    { path: 'c.py', status: 'added' },
    { path: 'new.py', status: 'renamed', old: 'old.py' },
    { path: 'far.py', status: 'modified' },
  ],
}; // prettier-ignore

describe('validatePr', () => {
  it('accepts a well-formed result', () => {
    expect(validatePr(good).changes).toHaveLength(5);
  });
  it('rejects extra keys, bad statuses, unsafe text and hostile hrefs', () => {
    expect(() => validatePr({ ...good, extra: 1 })).toThrow();
    expect(() => validatePr({ ...good, changes: [{ path: 'x', status: 'copied' }] })).toThrow();
    expect(() => validatePr({ ...good, changes: [{ path: 'x‮y', status: 'added' }] })).toThrow();
    expect(() => validatePr({ ...good, changes: [{ path: 'x', status: 'added', href: 'javascript:alert(1)' }] })).toThrow();
    expect(() => validatePr({ ...good, pr: 0 })).toThrow();
    expect(() => validatePr({ ...good, merge: 'HEAD' })).toThrow();
  });
});

it('overlay marks changed and gone buildings and counts what is not in the city', () => {
  const r = { files: ['a.py', 'b.py', 'old.py', 'keep.py'].map((path) => ({ path })) } as Result;
  const o = overlay(r, validatePr(good));
  expect([...o.marks]).toEqual([[0, 1], [1, 2], [2, 2]]);
  expect(o).toMatchObject({ changed: 1, gone: 2, fresh: 2, unseen: 1 }); // fresh: c.py, new.py; unseen: far.py
});
