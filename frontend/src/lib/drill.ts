/**
 * District drill-down (docs/ROADMAP.md #9): one district of a result as a city of its own, its next folder level
 * becoming the districts. Built only from the parent result's fields; what the parent cannot say per sub-folder
 * (bus factor, owners, people's areas) is left out rather than guessed, and the UI says so.
 */
import type { Dir, Result } from './result';

export const HERE = '(files here)';
const QUIET_AFTER = 2 * 365.25 * 86400; // worker/analyse.py QUIET_AFTER

export type Drill = { result: Result; prefixes: string[] };

/** Path prefix of a top-level district of a worker result (`(root)` has none). */
export const topPrefix = (name: string): string => (name === '(root)' ? '' : name);

/** The files of district `d` (whose paths start with `prefix/`) as a result whose districts are their next folder. */
export function drill(r: Result, d: number, prefix: string): Drill {
  const keep = r.files.map((f, i) => ({ f, i })).filter(({ f }) => f.dir === d);
  const sub = (path: string): string => {
    const rest = prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
    const k = rest.indexOf('/');
    return k > 0 ? rest.slice(0, k) : HERE;
  };
  const names = [...new Set(keep.map(({ f }) => sub(f.path)))].sort((a, b) => Number(a === HERE) - Number(b === HERE) || (a < b ? -1 : 1));
  const dirIndex = new Map(names.map((n, i) => [n, i]));
  const fileIndex = new Map(keep.map(({ i }, k) => [i, k]));
  const files = keep.map(({ f }) => ({ ...f, dir: dirIndex.get(sub(f.path))! }));
  const head = r.meta.span[1];
  const dirs: Dir[] = names.map((name, i) => {
    const members = files.filter((f) => f.dir === i);
    const last = Math.max(...members.map((f) => f.last));
    return { name, files: members.length, loc: members.reduce((n, f) => n + f.loc, 0), last, bus_factor: 0, quiet: last < head - QUIET_AFTER };
  });
  const remap = (list: number[]): number[] => list.flatMap((i) => (fileIndex.has(i) ? [fileIndex.get(i)!] : []));
  const kept = r.coupling.flatMap((c, i) => (fileIndex.has(c.a) && fileIndex.has(c.b) ? [i] : []));
  const couplingIndex = new Map(kept.map((i, k) => [i, k]));
  const coupling = kept.map((i) => {
    const c = r.coupling[i]!;
    return { ...c, a: fileIndex.get(c.a)!, b: fileIndex.get(c.b)! };
  });
  const quiet = dirs.map((x, i) => ({ x, i })).filter(({ x }) => x.quiet).sort((a, b) => a.x.last - b.x.last).map(({ i }) => i);
  const result: Result = {
    meta: { ...r.meta, files: files.length, truncated: { ...r.meta.truncated } },
    dirs,
    files,
    coupling,
    people: r.people.map((p) => ({ ...p, areas: [] })), // who works in which sub-folder is not in the result
    insights: {
      hotspots: remap(r.insights.hotspots),
      bus_factor: [], // not known per sub-folder
      quiet: quiet.slice(0, 10),
      coupling: r.insights.coupling.flatMap((i) => (couplingIndex.has(i) ? [couplingIndex.get(i)!] : [])),
    },
    timeline: r.timeline,
  };
  return { result, prefixes: names.map((n) => (n === HERE ? prefix : prefix ? `${prefix}/${n}` : n)) };
}
