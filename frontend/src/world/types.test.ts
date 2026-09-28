import { describe, expect, it } from 'vitest';
import type { Result } from '../lib/result';
import { extensionOf, fileTypes, TOP_TYPES, TYPE_COLOURS } from './types';

describe('extensionOf', () => {
  it('takes the last suffix of the file name, lower-cased', () => {
    expect(extensionOf('src/app.PY')).toBe('.py');
    expect(extensionOf('a.b/c.tar.gz')).toBe('.gz');
    expect(extensionOf('docs/café.md')).toBe('.md');
  });
  it('has none for dotfiles, bare names, trailing dots and very long suffixes', () => {
    for (const p of ['.gitignore', 'dir/.env', 'Makefile', 'v1.2/LICENSE', 'x.', 'a.verylongsuffixx']) expect(extensionOf(p)).toBeNull();
  });
});

describe('fileTypes', () => {
  const r = (paths: string[]): Result => ({ files: paths.map((path) => ({ path })) }) as Result;
  it('ranks extensions by count, then groups the rest as other', () => {
    const paths = ['a.py', 'b.py', 'c.ts', 'README', ...Array.from({ length: 9 }, (_, i) => `x.e${i}`)];
    const t = fileTypes(r(paths));
    expect(t.labels[0]).toBe('.py');
    expect(t.counts[0]).toBe(2);
    expect(t.labels.slice(-2)).toEqual(['other', 'no extension']);
    expect(t.counts[TOP_TYPES]).toBe(3); // ties sort by name: .e7, .e8 and .ts miss the top 8
    expect(t.counts[TOP_TYPES + 1]).toBe(1); // README
    expect(t.counts.reduce((a, b) => a + b, 0)).toBe(paths.length);
    expect(t.index[3]).toBe(TOP_TYPES + 1);
  });
  it('has one colour per slot', () => {
    expect(TYPE_COLOURS).toHaveLength(TOP_TYPES + 2);
  });
});
