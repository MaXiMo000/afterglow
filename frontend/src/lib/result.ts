/**
 * The analysis result (docs/PLAN.md section 4) and a strict client-side check (SECURITY T21).
 * The server already validated it; this second check runs before any GPU buffer is sized from server data, so a
 * compromised or buggy server cannot make the renderer allocate unbounded memory or read NaN.
 */

export type Truncated = { files: boolean; commits: boolean; sizes: boolean };
export type Meta = {
  repo: string;
  sha: string;
  analyser: number;
  generated_at: number;
  commits: number;
  files: number;
  people: number;
  span: [number, number];
  truncated: Truncated;
};
export type Dir = { name: string; files: number; loc: number; last: number; bus_factor: number; quiet: boolean };
export type FileRec = {
  path: string;
  dir: number;
  loc: number;
  birth: number;
  last: number;
  changes: number;
  changes_12m: number;
  authors: number;
  hot: boolean;
  dead: boolean;
};
export type Coupling = { a: number; b: number; count: number; strength: number };
export type Person = { handle: string; commits: number; areas: number[] };
export type Month = { t: number; commits: number; added: number };
export type Insights = { hotspots: number[]; bus_factor: number[]; quiet: number[]; coupling: number[] };
export type Result = {
  meta: Meta;
  dirs: Dir[];
  files: FileRec[];
  coupling: Coupling[];
  people: Person[];
  insights: Insights;
  timeline: Month[];
};

export const LIMITS = { files: 50_000, dirs: 2_000, coupling: 300, people: 1_000, months: 1_200, text: 512 };

export class InvalidResult extends Error {}

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

function fail(where: string): never {
  throw new InvalidResult(where);
}
function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(where);
  return v as Record<string, unknown>;
}
function keys(o: Record<string, unknown>, want: readonly string[], where: string): void {
  const got = Object.keys(o);
  if (got.length !== want.length || !want.every((k) => k in o)) fail(where);
}
function int(v: unknown, where: string, max = 1e12): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) fail(where);
  return v;
}
function num01(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail(where);
  return v;
}
function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') fail(where);
  return v;
}
function text(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > LIMITS.text || UNSAFE.test(v)) fail(where);
  return v;
}
function arr(v: unknown, max: number, where: string): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(where);
  return v;
}
function idx(v: unknown, n: number, where: string): number {
  const i = int(v, where);
  if (i >= n) fail(where);
  return i;
}

export function validateResult(raw: unknown): Result {
  const r = obj(raw, 'result');
  keys(r, ['meta', 'dirs', 'files', 'coupling', 'people', 'insights', 'timeline'], 'result');

  const m = obj(r['meta'], 'meta');
  keys(m, ['repo', 'sha', 'analyser', 'generated_at', 'commits', 'files', 'people', 'span', 'truncated'], 'meta');
  const repo = text(m['repo'], 'meta.repo');
  if (!/^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/.test(repo)) fail('meta.repo');
  const sha = text(m['sha'], 'meta.sha');
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) fail('meta.sha');
  const span = arr(m['span'], 2, 'meta.span');
  if (span.length !== 2) fail('meta.span');
  const t0 = int(span[0], 'meta.span');
  const t1 = int(span[1], 'meta.span');
  if (t1 < t0) fail('meta.span');
  const tr = obj(m['truncated'], 'meta.truncated');
  keys(tr, ['files', 'commits', 'sizes'], 'meta.truncated');
  const meta: Meta = {
    repo,
    sha,
    analyser: int(m['analyser'], 'meta.analyser'),
    generated_at: int(m['generated_at'], 'meta.generated_at'),
    commits: int(m['commits'], 'meta.commits'),
    files: int(m['files'], 'meta.files'),
    people: int(m['people'], 'meta.people'),
    span: [t0, t1],
    truncated: { files: bool(tr['files'], 't.files'), commits: bool(tr['commits'], 't.commits'), sizes: bool(tr['sizes'], 't.sizes') },
  };

  const dirs = arr(r['dirs'], LIMITS.dirs, 'dirs').map((d, i): Dir => {
    const o = obj(d, `dirs.${i}`);
    keys(o, ['name', 'files', 'loc', 'last', 'bus_factor', 'quiet'], `dirs.${i}`);
    return {
      name: text(o['name'], `dirs.${i}.name`),
      files: int(o['files'], `dirs.${i}.files`),
      loc: int(o['loc'], `dirs.${i}.loc`),
      last: int(o['last'], `dirs.${i}.last`),
      bus_factor: int(o['bus_factor'], `dirs.${i}.bus_factor`),
      quiet: bool(o['quiet'], `dirs.${i}.quiet`),
    };
  });
  const nd = dirs.length;
  const files = arr(r['files'], LIMITS.files, 'files').map((f, i): FileRec => {
    const o = obj(f, `files.${i}`);
    keys(o, ['path', 'dir', 'loc', 'birth', 'last', 'changes', 'changes_12m', 'authors', 'hot', 'dead'], `files.${i}`);
    return {
      path: text(o['path'], `files.${i}.path`),
      dir: idx(o['dir'], nd, `files.${i}.dir`),
      loc: int(o['loc'], `files.${i}.loc`),
      birth: int(o['birth'], `files.${i}.birth`),
      last: int(o['last'], `files.${i}.last`),
      changes: int(o['changes'], `files.${i}.changes`),
      changes_12m: int(o['changes_12m'], `files.${i}.changes_12m`),
      authors: int(o['authors'], `files.${i}.authors`),
      hot: bool(o['hot'], `files.${i}.hot`),
      dead: bool(o['dead'], `files.${i}.dead`),
    };
  });
  const nf = files.length;
  const coupling = arr(r['coupling'], LIMITS.coupling, 'coupling').map((c, i): Coupling => {
    const o = obj(c, `coupling.${i}`);
    keys(o, ['a', 'b', 'count', 'strength'], `coupling.${i}`);
    return { a: idx(o['a'], nf, 'c.a'), b: idx(o['b'], nf, 'c.b'), count: int(o['count'], 'c.count'), strength: num01(o['strength'], 'c.s') };
  });
  const people = arr(r['people'], LIMITS.people, 'people').map((p, i): Person => {
    const o = obj(p, `people.${i}`);
    keys(o, ['handle', 'commits', 'areas'], `people.${i}`);
    const handle = text(o['handle'], 'p.handle');
    if (!/^Contributor [0-9]{1,7}$/.test(handle)) fail('p.handle');
    return { handle, commits: int(o['commits'], 'p.commits'), areas: arr(o['areas'], 3, 'p.areas').map((a) => idx(a, nd, 'p.area')) };
  });
  const ins = obj(r['insights'], 'insights');
  keys(ins, ['hotspots', 'bus_factor', 'quiet', 'coupling'], 'insights');
  const insights: Insights = {
    hotspots: arr(ins['hotspots'], 50, 'i.h').map((v) => idx(v, nf, 'i.h')),
    bus_factor: arr(ins['bus_factor'], 50, 'i.b').map((v) => idx(v, nd, 'i.b')),
    quiet: arr(ins['quiet'], 50, 'i.q').map((v) => idx(v, nd, 'i.q')),
    coupling: arr(ins['coupling'], 50, 'i.c').map((v) => idx(v, coupling.length, 'i.c')),
  };
  const timeline = arr(r['timeline'], LIMITS.months, 'timeline').map((t, i): Month => {
    const o = obj(t, `timeline.${i}`);
    keys(o, ['t', 'commits', 'added'], `timeline.${i}`);
    return { t: int(o['t'], 'tl.t'), commits: int(o['commits'], 'tl.c'), added: int(o['added'], 'tl.a') };
  });
  return { meta, dirs, files, coupling, people, insights, timeline };
}
