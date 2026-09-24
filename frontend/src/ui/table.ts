/**
 * 2D fallback (no WebGL2, context loss, shader failure, or "View as table") and the screen-reader summary
 * (EXPERIENCE section 8). Same data as the city, no 3D required.
 */
import type { Result } from '../lib/result';
import { ago, el, fmt, fmtDate } from './dom';

const MAX_ROWS = 500;

export function renderTable(r: Result, tbody: HTMLElement, caption: HTMLElement, note: HTMLElement): void {
  const now = r.meta.span[1];
  const rows = r.files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => b.f.changes_12m - a.f.changes_12m || b.f.changes - a.f.changes)
    .slice(0, MAX_ROWS);
  tbody.replaceChildren(
    ...rows.map(({ f }) => {
      const tr = el('tr');
      const status = f.hot ? 'hotspot' : f.dead ? 'quiet' : '';
      tr.append(
        el('td', f.path),
        el('td', fmt(f.changes_12m), 'num'),
        el('td', fmt(f.authors), 'num'),
        el('td', r.meta.truncated.sizes && f.loc === 0 ? 'n/a' : fmt(f.loc), 'num'),
        el('td', ago(f.last, now)),
        el('td', status, status ? `status-${f.hot ? 'hot' : 'quiet'}` : undefined),
      );
      return tr;
    }),
  );
  caption.textContent = `${fmt(rows.length)} of ${fmt(r.files.length)} files at HEAD, most changed in the last 12 months first.`;
  note.textContent = honestyLines(r).join(' ');
}

/** Squarified-ish treemap of districts sized by file count, drawn on a 2D canvas (no DOM per cell). */
export function drawTreemap(r: Result, canvas: HTMLCanvasElement): void {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 280;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#060a11';
  ctx.fillRect(0, 0, w, h);
  const items = r.dirs.map((d, i) => ({ d, i, v: Math.max(1, d.files) })).sort((a, b) => b.v - a.v);
  const hotDirs = new Set(r.insights.hotspots.map((fi) => r.files[fi]?.dir));
  // Slice-and-dice along the longer side: simple, stable, readable at this size.
  let x = 0;
  let y = 0;
  let rw = w;
  let rh = h;
  let rest = items.reduce((s, it) => s + it.v, 0);
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textBaseline = 'top';
  for (const it of items) {
    const share = it.v / rest;
    let cw: number;
    let ch: number;
    if (rw >= rh) {
      cw = rw * share;
      ch = rh;
    } else {
      cw = rw;
      ch = rh * share;
    }
    ctx.fillStyle = it.d.quiet ? '#1a2a33' : hotDirs.has(it.i) ? '#4a1f22' : '#173a3f';
    ctx.fillRect(x + 1, y + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
    if (cw > 60 && ch > 18) {
      ctx.fillStyle = '#ece6db';
      ctx.fillText(`${it.d.name} (${it.d.files})`, x + 6, y + 5, cw - 12);
    }
    if (rw >= rh) {
      x += cw;
      rw -= cw;
    } else {
      y += ch;
      rh -= ch;
    }
    rest -= it.v;
  }
}

/** Plain-language caveats that must accompany the data wherever it is shown (CLAUDE.md rule 6). */
export function honestyLines(r: Result): string[] {
  const t = r.meta.truncated;
  const out: string[] = [];
  if (t.commits) out.push(`Only the latest ${fmt(r.meta.commits)} commits were analysed.`);
  if (t.files) out.push(`Showing the ${fmt(r.files.length)} most-changed of ${fmt(r.meta.files)} files.`);
  if (t.sizes) out.push('Some line counts were unavailable (size caps); building heights are approximate.');
  out.push('Bus factor is commit-weighted, not line-weighted.');
  return out;
}

export function renderSummary(r: Result, root: HTMLElement): void {
  const m = r.meta;
  const now = m.span[1];
  const parts: HTMLElement[] = [];
  parts.push(
    el('p', `${m.repo} at commit ${m.sha.slice(0, 7)}: ${fmt(m.files)} files, ${fmt(m.commits)} commits, ${fmt(m.people)} contributors, history from ${fmtDate(m.span[0])} to ${fmtDate(m.span[1])}.`),
  );
  for (const line of honestyLines(r)) parts.push(el('p', line));

  parts.push(el('h3', 'Hotspots: changed often, by few people, in the last 12 months'));
  const hot = el('ol');
  for (const i of r.insights.hotspots.slice(0, 10)) {
    const f = r.files[i];
    if (f) hot.append(el('li', `${f.path}: ${fmt(f.changes_12m)} changes by ${fmt(f.authors)} author${f.authors === 1 ? '' : 's'}`));
  }
  parts.push(hot.childElementCount ? hot : el('p', 'None found.'));

  parts.push(el('h3', 'Quiet districts: untouched for over two years'));
  const quiet = el('ul');
  for (const i of r.insights.quiet.slice(0, 10)) {
    const d = r.dirs[i];
    if (d) quiet.append(el('li', `${d.name}: ${fmt(d.files)} files, last change ${ago(d.last, now)}`));
  }
  parts.push(quiet.childElementCount ? quiet : el('p', 'None found.'));

  parts.push(el('h3', 'Bus factor by district (lowest first)'));
  const table = el('table');
  const head = el('tr');
  head.append(el('th', 'District'), el('th', 'Files'), el('th', 'Bus factor'));
  table.append(head);
  for (const i of r.insights.bus_factor.slice(0, 10)) {
    const d = r.dirs[i];
    if (!d) continue;
    const tr = el('tr');
    tr.append(el('td', d.name), el('td', fmt(d.files)), el('td', fmt(d.bus_factor)));
    table.append(tr);
  }
  parts.push(table);
  root.replaceChildren(...parts);
}
