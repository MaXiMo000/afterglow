import { describe, expect, it } from 'vitest';
import { parseRepo, repoFromPath } from './repo';

describe('parseRepo', () => {
  it('accepts owner/name', () => {
    expect(parseRepo('tiangolo/fastapi')).toEqual({ owner: 'tiangolo', name: 'fastapi' });
    expect(parseRepo('  a-b/c.d_e-f  ')).toEqual({ owner: 'a-b', name: 'c.d_e-f' });
  });

  it.each([
    '',
    'fastapi',
    'a/b/c',
    'a/.',
    'a/..',
    'https://github.com/a/b',
    'git@github.com:a/b',
    'a:b/c',
    'a/b%2e',
    'a /b',
    `${String.fromCodePoint(0xff41)}/b`, // fullwidth 'a'
    `a/b${String.fromCodePoint(0x202e)}`, // right-to-left override
    `${'a'.repeat(40)}/b`,
    `a/${'b'.repeat(101)}`,
    'x'.repeat(10_000),
  ])('rejects %j', (input) => {
    expect(parseRepo(input)).toBeNull();
  });
});

describe('repoFromPath', () => {
  it('reads /owner/name', () => {
    expect(repoFromPath('/pallets/flask')).toEqual({ owner: 'pallets', name: 'flask' });
    expect(repoFromPath('/pallets/flask/')).toEqual({ owner: 'pallets', name: 'flask' });
  });
  it.each(['/', '/pallets', '/a/b/c', '/assets/index.js', '/demo/x.json', '/api/v1', '/a/..', '/a/b%2Fc', '/a/%3Cscript%3E', '//b', '/privacy.html'])(
    'ignores %s',
    (p) => expect(repoFromPath(p)).toBeNull(),
  );
});
