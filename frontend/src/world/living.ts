/**
 * Living City: every building gets a style that says what kind of file it is, read from the path, size and dates
 * only (never file contents). The legend states each rule, so nothing here is decoration pretending to be data.
 */
import type { FileRec, Result } from '../lib/result';

export const STYLE = { office: 0, tower: 1, brick: 2, warehouse: 3, tree: 4, house: 5 } as const;
export type Style = (typeof STYLE)[keyof typeof STYLE];

/** Days before the analysed commit that count as "under construction". */
export const CRANE_DAYS = 14;
/** At most this many cranes, the most-changed recent files first, so a bulk edit does not turn into a crane forest. */
export const MAX_CRANES = 24;
/** Share of the largest files that become glass towers. */
const TOWER_SHARE = 0.08;

const TEST_DIR = /(^|\/)(tests?|specs?|__tests__|__mocks__|e2e|testdata|test_data|fixtures)\//i;
const TEST_NAME = /(^test_|_test\.|\.test\.|\.spec\.|_spec\.|tests?\.(java|kt|cs|swift|scala)$|^conftest\.py$)/i;
const DOC_DIR = /(^|\/)(docs?|documentation|docs_src)\//i;
const DOC_NAME = /(\.(md|mdx|rst|adoc|txt)$|^(readme|license|licence|changelog|contributing|authors|notice|copying)(\.|$))/i;
const GEN_DIR = /(^|\/)(vendor|vendored|third_party|third-party|external|dist|generated|gen|__snapshots__)\//i;
const GEN_NAME =
  /(\.lock$|^(package-lock\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json|go\.sum)$|\.min\.(js|css)$|\.snap$|\.pb\.(go|cc|h)$|_pb2(_grpc)?\.py$|\.generated\.|\.g\.dart$)/i;

/** One file's style from its path; size and age decide only between office, tower and brick. */
export function styleOf(path: string): Style | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (TEST_DIR.test(path) || TEST_NAME.test(name)) return STYLE.tree;
  if (GEN_DIR.test(path) || GEN_NAME.test(name)) return STYLE.warehouse;
  if (DOC_NAME.test(name) || DOC_DIR.test(path)) return STYLE.house;
  return null;
}

export type Living = { style: Uint8Array; crane: Uint8Array; counts: number[]; cranes: number };

export function livingCity(r: Result): Living {
  const { files } = r;
  const [t0, t1] = r.meta.span;
  const style = new Uint8Array(files.length);
  const crane = new Uint8Array(files.length);
  const size = (f: FileRec): number => f.loc || f.changes;
  // The largest TOWER_SHARE of the source files (by lines; changes when line counts are missing) are glass towers.
  const kind = files.map((f) => styleOf(f.path));
  const sizes = files.filter((_, i) => kind[i] === null).map(size).sort((a, b) => b - a);
  const towerMin = Math.max(1, sizes[Math.floor(sizes.length * TOWER_SHARE)] ?? 1);
  const oldBefore = t0 + (t1 - t0) / 3;
  files.forEach((f, i) => {
    const s = kind[i] ?? null;
    if (s !== null) style[i] = s;
    else if (size(f) > towerMin) style[i] = STYLE.tower;
    else if (f.birth < oldBefore && f.changes_12m === 0 && !f.dead) style[i] = STYLE.brick;
    else style[i] = STYLE.office;
  });
  const since = t1 - CRANE_DAYS * 86400;
  const recent = files
    .map((_, i) => i)
    .filter((i) => !files[i]!.dead && files[i]!.last >= since && style[i] !== STYLE.tree)
    .sort((a, b) => files[b]!.changes_12m - files[a]!.changes_12m || a - b)
    .slice(0, MAX_CRANES);
  for (const i of recent) crane[i] = 1;
  const counts = [0, 0, 0, 0, 0, 0];
  for (const s of style) counts[s]!++;
  return { style, crane, counts, cranes: recent.length };
}
