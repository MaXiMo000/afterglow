import { describe, expect, it } from 'vitest';
import type { Result } from '../lib/result';
import { githubUrl } from './panels';

const r = { meta: { repo: 'acme/orbit', sha: 'a'.repeat(40) } } as Result;
const base = `https://github.com/acme/orbit/blob/${'a'.repeat(40)}/`;

describe('githubUrl', () => {
  it('encodes ordinary paths', () => {
    expect(githubUrl(r, { path: 'docs/café notes.md' })).toBe(`${base}docs/caf%C3%A9%20notes.md`);
  });
  it('uses the real path when the shown one was normalised or cleaned', () => {
    expect(githubUrl(r, { path: 'café.md', href: 'cafe%CC%81.md' })).toBe(`${base}cafe%CC%81.md`);
    expect(githubUrl(r, { path: 'a�b.md', href: 'a%1Bb.md' })).toBe(`${base}a%1Bb.md`);
  });
  it('gives no link when the real path is unknown or unsafe', () => {
    expect(githubUrl(r, { path: 'a�b.md' })).toBeNull();
    expect(githubUrl(r, { path: 'x', href: '../x' })).toBeNull();
  });
});
