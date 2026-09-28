import { expect, it } from 'vitest';
import type { Result } from './result';
import { since } from './since';

const res = (head: number, files: [string, number, number][], truncated = false): Result =>
  ({
    meta: { span: [0, head], truncated: { files: truncated, commits: false, sizes: false } },
    files: files.map(([path, changes, birth]) => ({ path, changes, birth })),
  }) as unknown as Result;

it('marks new files and files changed again, counts removals and new changes', () => {
  const prev = res(100, [['a.py', 3, 10], ['b.py', 5, 10], ['gone.py', 1, 10]]);
  const cur = res(200, [['a.py', 3, 10], ['b.py', 9, 10], ['c.py', 1, 150], ['moved-in.py', 2, 50]]);
  const s = since(cur, prev);
  expect([...s.marks]).toEqual([[1, 1], [2, 3]]); // b changed again; c is new. moved-in.py predates prev: not "new"
  expect(s).toMatchObject({ fresh: 1, again: 1, changes: 4, removed: 1, partial: false });
});

it('says when the comparison is partial', () => {
  expect(since(res(2, [], true), res(1, [])).partial).toBe(true);
});
