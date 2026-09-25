/**
 * Explore panels (EXPERIENCE section 5): inspector drawer, insights, help overlay, mini-map, timeline + compare.
 * Every value shown is a field of the result or a count derived from it; nothing is estimated.
 */
import type { Result } from '../lib/result';
import type { World } from '../world/build';
import { ago, el, fmt, fmtDate, setText } from './dom';
import { KEYMAP, MOVE_KEYS } from './keymap';

/** Validated GitHub URL for a file at the analysed commit (the only dynamic href in the app, SECURITY T5). */
export function githubUrl(r: Result, path: string): string | null {
  const m = /^([a-z0-9-]{1,39})\/([a-z0-9._-]{1,100})$/.exec(r.meta.repo);
  if (!m || !/^[0-9a-f]{40,64}$/.test(r.meta.sha)) return null;
  const segs = path.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return `https://github.com/${m[1]}/${m[2]}/blob/${r.meta.sha}/${segs.map(encodeURIComponent).join('/')}`;
}

export class Inspector {
  private readonly root = document.getElementById('inspector')!;
  constructor(private readonly onSelect: (i: number) => void) {
    this.root.querySelector('.close')!.addEventListener('click', () => this.onSelect(-1));
  }

  show(r: Result, i: number): void {
    const f = r.files[i];
    if (!f) return this.hide();
    const d = r.dirs[f.dir];
    const body = this.root.querySelector('.content')!;
    const kids: HTMLElement[] = [];
    const badges = el('p', null, 'badges');
    if (f.hot) badges.append(el('span', 'hotspot', 'pill hot'));
    if (f.dead) badges.append(el('span', 'quiet 2y+', 'pill quiet'));
    kids.push(badges, el('h2', f.path, 'path'));
    const dl = el('dl');
    const row = (k: string, v: string): void => void dl.append(el('dt', k), el('dd', v));
    row('district', d ? d.name : '');
    row('lines', r.meta.truncated.sizes && f.loc === 0 ? 'n/a (size caps)' : fmt(f.loc));
    row('created', fmtDate(f.birth));
    row('last change', `${fmtDate(f.last)} (${ago(f.last, r.meta.span[1])})`);
    row('changes, last 12 months', fmt(f.changes_12m));
    row('changes, all time', fmt(f.changes));
    row('authors, all time', fmt(f.authors));
    kids.push(dl);
    const coupled = r.coupling
      .filter((c) => c.a === i || c.b === i)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
    kids.push(el('h3', 'Changes together with'));
    if (coupled.length) {
      const ul = el('ul', null, 'coupled');
      for (const c of coupled) {
        const other = c.a === i ? c.b : c.a;
        const b = el('button', r.files[other]?.path ?? '');
        b.type = 'button';
        b.addEventListener('click', () => this.onSelect(other));
        const li = el('li');
        li.append(b, el('span', `${fmt(c.count)} commits together`, 'k'));
        ul.append(li);
      }
      kids.push(ul);
    } else kids.push(el('p', 'No strong co-change partners in the latest 10,000 commits.', 'sub'));
    const url = githubUrl(r, f.path);
    if (url) {
      const a = el('a', 'Open on GitHub', 'chip');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      kids.push(a);
    }
    kids.push(el('p', 'Per-quarter history and per-author breakdowns are not in this analysis yet.', 'sub note'));
    body.replaceChildren(...kids);
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }
}

export class Insights {
  private readonly root = document.getElementById('insights')!;
  private tab: 'hot' | 'bus' | 'quiet' | 'coupling' = 'hot';
  private r: Result | null = null;
  constructor(
    private readonly onFile: (i: number) => void,
    private readonly onDistrict: (d: number) => void,
  ) {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      b.addEventListener('click', () => this.select(b.dataset['tab'] as typeof this.tab));
    }
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  toggle(r: Result, force?: boolean): void {
    this.r = r;
    this.root.hidden = force === undefined ? !this.root.hidden : !force;
    if (!this.root.hidden) this.render();
  }

  private select(tab: typeof this.tab): void {
    this.tab = tab;
    this.render();
  }

  private render(): void {
    const r = this.r;
    if (!r) return;
    const kpis = this.root.querySelector('.kpis')!;
    const years = (r.meta.span[1] - r.meta.span[0]) / (365.25 * 86400);
    kpis.replaceChildren(
      ...([['files', r.meta.files], ['commits', r.meta.commits], ['people', r.meta.people], ['years', Math.max(0, Math.round(years))]] as const).map(
        ([k, v]) => {
          const d = el('div');
          d.append(el('b', fmt(v)), el('span', k));
          return d;
        },
      ),
    );
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      const on = b.dataset['tab'] === this.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const rows: HTMLElement[] = [];
    const add = (name: string, value: string, desc: string, run: () => void, cls = ''): void => {
      const b = el('button', null, 'row');
      b.type = 'button';
      b.append(el('span', name, 'n'), el('span', value, `v ${cls}`), el('span', desc, 'd'));
      b.addEventListener('click', run);
      const li = el('li');
      li.append(b);
      rows.push(li);
    };
    const now = r.meta.span[1];
    if (this.tab === 'hot')
      for (const i of r.insights.hotspots) {
        const f = r.files[i]!;
        add(f.path, `${fmt(f.changes_12m)} / 12 mo`, `${fmt(f.authors)} authors all time \u00b7 last ${ago(f.last, now)}`, () => this.onFile(i), 'bad');
      }
    if (this.tab === 'bus')
      for (const d of r.insights.bus_factor) {
        const x = r.dirs[d]!;
        add(x.name, `bus factor ${fmt(x.bus_factor)}`, `${fmt(x.files)} files \u00b7 commit-weighted`, () => this.onDistrict(d), x.bus_factor <= 1 ? 'bad' : x.bus_factor <= 2 ? 'warn' : 'ok');
      }
    if (this.tab === 'quiet')
      for (const d of r.insights.quiet) {
        const x = r.dirs[d]!;
        add(x.name, ago(x.last, now), `${fmt(x.files)} files, no change for 2+ years`, () => this.onDistrict(d));
      }
    if (this.tab === 'coupling')
      for (const ci of r.insights.coupling) {
        const c = r.coupling[ci]!;
        const a = r.files[c.a]!;
        const b = r.files[c.b]!;
        add(`${a.path} \u2194 ${b.path}`, `${fmt(c.count)} together`, `${Math.round(c.strength * 100)}% of the rarer file's changes`, () => this.onFile(c.a));
      }
    if (!rows.length) rows.push(el('li', 'Nothing to show for this repository.', 'empty'));
    this.root.querySelector('ol')!.replaceChildren(...rows);
  }
}

export function renderHelp(root: HTMLElement): void {
  const groups = new Map<string, HTMLElement>();
  const move = el('dl');
  for (const m of MOVE_KEYS) move.append(el('dt', m.keys), el('dd', m.label));
  const sections: HTMLElement[] = [el('h3', 'Move'), move];
  for (const def of KEYMAP) {
    let dl = groups.get(def.group);
    if (!dl) {
      dl = el('dl');
      groups.set(def.group, dl);
      sections.push(el('h3', def.group), dl);
    }
    dl.append(el('dt', def.keys.join(' / ')), el('dd', def.label));
  }
  root.replaceChildren(...sections);
}

/** Mini-map: district discs, the camera's ground frustum, click to fly (EXPERIENCE section 5). */
export class MiniMap {
  readonly canvas = document.getElementById('minimap') as HTMLCanvasElement;
  private scale = 1;
  constructor(private readonly onFly: (x: number, z: number) => void) {
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - rect.width / 2) / this.scale;
      const z = (e.clientY - rect.top - rect.height / 2) / this.scale;
      this.onFly(x, z);
    });
  }

  get open(): boolean {
    return !this.canvas.hidden;
  }

  draw(w: World, eye: [number, number, number], tgt: [number, number, number], hot: ReadonlySet<number>): void {
    if (this.canvas.hidden) return;
    const size = this.canvas.clientWidth || 180;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (this.canvas.width !== size * dpr) {
      this.canvas.width = size * dpr;
      this.canvas.height = size * dpr;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(6,10,17,0.78)';
    ctx.fillRect(0, 0, size, size);
    this.scale = (size / 2 - 8) / Math.max(20, w.radius);
    const s = this.scale;
    const c = size / 2;
    ctx.font = '9px "IBM Plex Mono", monospace';
    const ranked = [...w.dists].sort((a, b) => b.r - a.r);
    for (const d of w.dists) {
      ctx.beginPath();
      ctx.arc(c + d.x * s, c + d.z * s, Math.max(2, d.r * s), 0, Math.PI * 2);
      ctx.fillStyle = d.pal === 4 ? 'rgba(90,110,120,0.35)' : hot.has(d.index) ? 'rgba(255,90,74,0.45)' : 'rgba(95,214,180,0.35)';
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(236,230,219,0.85)';
    for (const d of ranked.slice(0, 5)) ctx.fillText(d.name.slice(0, 14), c + d.x * s - 16, c + d.z * s + 3);
    // Camera: eye point and view direction to the target.
    ctx.strokeStyle = '#ffb45e';
    ctx.fillStyle = '#ffb45e';
    ctx.beginPath();
    ctx.moveTo(c + eye[0] * s, c + eye[2] * s);
    const ang = Math.atan2(tgt[2] - eye[2], tgt[0] - eye[0]);
    const len = 26;
    ctx.lineTo(c + eye[0] * s + Math.cos(ang - 0.45) * len, c + eye[2] * s + Math.sin(ang - 0.45) * len);
    ctx.lineTo(c + eye[0] * s + Math.cos(ang + 0.45) * len, c + eye[2] * s + Math.sin(ang + 0.45) * len);
    ctx.closePath();
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(c + eye[0] * s, c + eye[2] * s, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Compare categories for two dates, from fields the analysis has (EXPERIENCE section 5). */
export function compareCounts(r: Result, a: number, b: number): { added: number; lastIn: number; after: number; before: number } {
  const out = { added: 0, lastIn: 0, after: 0, before: 0 };
  for (const f of r.files) {
    if (f.birth > a && f.birth <= b) out.added++;
    else if (f.last > a && f.last <= b) out.lastIn++;
    else if (f.last > b) out.after++;
    else out.before++;
  }
  return out;
}

/** Timeline scrubber with sparkline (commits per month), play/speeds and compare markers. */
export class Timeline {
  readonly root = document.getElementById('timeline')!;
  private readonly track = this.root.querySelector('.track') as HTMLElement;
  private readonly spark = this.root.querySelector('canvas') as HTMLCanvasElement;
  private r: Result | null = null;
  private drawnFor: Result | null = null;
  constructor(private readonly onScrub: (t: number) => void) {
    const scrub = (e: PointerEvent): void => {
      const rect = this.track.getBoundingClientRect();
      this.onScrub(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
    };
    this.track.addEventListener('pointerdown', (e) => {
      this.track.setPointerCapture(e.pointerId);
      scrub(e);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (this.track.hasPointerCapture(e.pointerId)) scrub(e);
    });
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  set(r: Result): void {
    this.r = r;
  }

  update(t: number, playing: boolean, speed: number, cmp: { a: number; b: number } | null, dateAt: (t: number) => number): void {
    const r = this.r;
    if (!r || this.root.hidden) return;
    if (this.drawnFor !== r) this.drawSpark(r);
    const knob = this.root.querySelector('.knob') as HTMLElement;
    knob.style.left = `${(t * 100).toFixed(2)}%`;
    (this.root.querySelector('.fill') as HTMLElement).style.transform = `scaleX(${t.toFixed(4)})`;
    this.track.setAttribute('aria-valuenow', String(Math.round(t * 100)));
    const when = dateAt(t);
    this.track.setAttribute('aria-valuetext', fmtDate(when));
    setText(this.root.querySelector('.date b') as HTMLElement, new Date(when * 1000).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
    const born = r.files.filter((f) => f.birth <= when).length;
    setText(this.root.querySelector('.date span') as HTMLElement, `${fmt(born)} of ${fmt(r.files.length)} files exist`);
    const play = this.root.querySelector('.play') as HTMLButtonElement;
    play.setAttribute('aria-label', playing ? 'Pause history' : 'Play history');
    play.classList.toggle('on', playing);
    setText(this.root.querySelector('.speed') as HTMLElement, `${speed}\u00d7`);
    const ma = this.root.querySelector('.mark.a') as HTMLElement;
    const mb = this.root.querySelector('.mark.b') as HTMLElement;
    ma.hidden = mb.hidden = !cmp;
    if (cmp) {
      ma.style.left = `${(cmp.a * 100).toFixed(2)}%`;
      mb.style.left = `${(cmp.b * 100).toFixed(2)}%`;
    }
  }

  private drawSpark(r: Result): void {
    this.drawnFor = r;
    const c = this.spark;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = c.clientWidth || 400;
    const h = c.clientHeight || 34;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext('2d');
    if (!ctx || !r.timeline.length) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const max = Math.max(1, ...r.timeline.map((m) => m.commits));
    const bw = w / r.timeline.length;
    ctx.fillStyle = 'rgba(255,180,94,0.55)';
    r.timeline.forEach((m, i) => {
      const bh = Math.max(1, (m.commits / max) * (h - 4));
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh);
    });
  }
}

