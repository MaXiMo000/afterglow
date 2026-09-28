/**
 * File types for "colour by file type" (docs/ROADMAP.md #1): the repository's most common extensions, plus
 * "other" and "no extension". Derived from the path only: this is the extension, not language detection, and the
 * legend says so.
 */
import type { Result } from '../lib/result';

/** Extensions given their own colour; the rest share "other". */
export const TOP_TYPES = 8;
/** Night-friendly, well-separated hues (Okabe-Ito based, lifted for a dark scene), then "other" and "no extension". */
export const TYPE_COLOURS = ['#e6a23c', '#56b4e9', '#2fbf8f', '#f0e442', '#5a8ff0', '#e0663a', '#d58ac0', '#9fe3d0', '#8a93a0', '#5a6270'];

export type FileTypes = { labels: string[]; counts: number[]; index: Uint8Array };

/** `.py` for `src/app.py`; null for `Makefile`, `.gitignore` (a dotfile has no extension) or a very long suffix. */
export function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot).toLowerCase();
  return ext.length <= 12 ? ext : null;
}

export function fileTypes(r: Result): FileTypes {
  const exts = r.files.map((f) => extensionOf(f.path));
  const tally = new Map<string, number>();
  for (const e of exts) if (e) tally.set(e, (tally.get(e) ?? 0) + 1);
  // Most files first; ties by name so the colours are stable for a given result.
  const top = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_TYPES).map(([e]) => e);
  const slot = new Map(top.map((e, i) => [e, i]));
  const other = TOP_TYPES;
  const none = TOP_TYPES + 1;
  const index = new Uint8Array(exts.length);
  const counts = new Array<number>(TOP_TYPES + 2).fill(0);
  exts.forEach((e, i) => {
    const s = e === null ? none : (slot.get(e) ?? other);
    index[i] = s;
    counts[s]!++;
  });
  const labels = [...top, ...new Array<string>(TOP_TYPES - top.length).fill(''), 'other', 'no extension'];
  return { labels, counts, index };
}
