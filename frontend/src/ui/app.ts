/**
 * App controller: hero -> loading (real SSE progress) -> story (A4) -> city with the explore tools (A5), plus the
 * 2D table fallback. The effects pass (A6) builds on this.
 */
import { ApiError, fetchResult, followProgress, startAnalysis, type Progress } from '../lib/api';
import { parseRepo, type RepoRef } from '../lib/repo';
import { validateResult, type Result } from '../lib/result';
import { decodeView, encodeView, type View } from '../lib/share';
import { clamp, lerp, smoothstep } from '../render/math';
import { Renderer, RendererError, TIERS, type Params } from '../render/renderer';
import { buildWorld, type World } from '../world/build';
import { buildCamera, OrbitCamera, orbitFromPose, rayThrough, type Preset } from './camera';
import { $, ago, el, fmt, fmtDate, reducedMotion, setText } from './dom';
import { actionFor, KEYMAP, type ActionId } from './keymap';
import { Palette, type Item } from './palette';
import { compareCounts, Inspector, Insights, MiniMap, renderHelp, Timeline } from './panels';
import { Story } from './story';
import { drawTreemap, honestyLines, renderSummary, renderTable } from './table';

type Mode = 'hero' | 'loading' | 'story' | 'city';
type Vec = [number, number, number];
const DEMO_URL = '/demo/fastapi-fastapi.json';
const FOG = 0.0072;
const SPEEDS = [1, 4, 16, 64];
const PLAY_SECONDS = 40; // whole history at 1x
const PRESETS: Preset[] = ['overview', 'street', 'top', 'skyline', 'cinematic'];

const STAGE_TEXT: Record<string, string> = {
  queued: 'Waiting for a free worker',
  cloning: 'Fetching commit history from GitHub (no file contents)',
  counting: 'Counting commits',
  parsing: 'Reading history',
  sizing: 'Measuring files at HEAD',
  scoring: 'Scoring hotspots, quiet districts, bus factor and coupling',
  done: 'Done',
};
const ERROR_TEXT: Record<string, string> = {
  invalid_repo: 'That does not look like owner/name.',
  not_found: 'Repository not found, or it is private. Only public repositories can be analysed.',
  clone_failed: 'GitHub refused the clone (renamed, private, or unavailable).',
  too_large: 'This repository is over our size limits.',
  timeout: 'The analysis took too long and was stopped.',
  empty_repo: 'This repository has no commits yet.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  too_many_jobs: 'You already have analyses running. Please wait for them to finish.',
  busy: 'The service is busy. Please try again in a minute.',
  worker_lost: 'The analysis was interrupted. Please try again.',
  unavailable: 'The service is unavailable right now.',
  no_files: 'This repository has no files at its latest commit, so there is no city to draw.',
};

export class App {
  private mode: Mode = 'hero';
  private renderer: Renderer | null = null;
  private rendererReady = false;
  private world: World | null = null;
  private result: Result | null = null;
  private demo = true;
  private readonly cam = new OrbitCamera();
  private readonly P: Params = {
    t: 1, fog: FOG, hot: 0.5, focus: -1, focusAmt: 0, hover: -1, fade: 0, exposure: 1, grain: 0.035, ca: 1,
    arcs: 1, lanterns: 1, cmp: [0, 0, 0], lift: 0, sel: -1, focusDist: 0, dof: 0, motion: 1,
  }; // prettier-ignore
  private time = 0;
  private last = 0;
  private tierIdx = 2;
  private scale = 1; // dynamic resolution factor, 0.6..1
  private frameMs = 16;
  private slowFor = 0;
  private fastFor = 0;
  private lanterns: Float32Array | null = null;
  private selected = -1;
  private focusGoal = 0;
  private ptrs = new Map<number, { x: number; y: number; t: number }>();
  private dragMoved = 0;
  private pinch = 0;
  private hoverAt: { x: number; y: number } | null = null;
  private pickBusy = false;
  private pickChain: Promise<unknown> = Promise.resolve(); // one GPU readback in flight at a time
  private abort: AbortController | null = null;
  private readonly story = new Story(() => this.enterCity());
  private lastVP: Float32Array | null = null;
  private pointer = { x: 0, y: 0 };
  /** Time-based blend used only for mode changes (outside the scrubbed story range). */
  private blend: { pos: Vec; tgt: Vec; fov: number; k: number } | null = null;
  private fov = 50;
  private lastPose: { pos: Vec; tgt: Vec } | null = null;
  // Explore state (A5)
  private tT = 1; // target history position; P.t eases toward it
  private playing = false;
  private speedIdx = 0;
  private compare: { a: number; b: number } | null = null;
  private photo = false;
  private exportNext = false;
  private pendingView: View | null = null;
  private loadFrac = 0; // real analysis progress 0..1, drives the city un-building during loading (A6)
  private lastRepo = '';
  private readonly held = new Set<string>();
  private readonly palette = new Palette();
  private readonly inspector = new Inspector((i) => this.select(i));
  private readonly insights = new Insights(
    (i) => this.select(i, true),
    (d) => this.flyToDistrict(d),
  );
  private readonly minimap = new MiniMap((x, z) => this.cam.flyTo({ ...this.cam.goal, x, z }, 0.8, reducedMotion()));
  private readonly timeline = new Timeline((t) => this.scrub(t));
  private readonly canvas = $('#gl') as HTMLCanvasElement;
  private readonly body = document.body;

  start(): void {
    const coarse = matchMedia('(pointer: coarse)').matches || innerWidth < 760 || (navigator.hardwareConcurrency || 8) <= 4;
    this.tierIdx = coarse ? 1 : 2;
    // ?quality=simple|balanced|cinematic pins a tier (testing, and users who prefer battery over looks). Enum only.
    const q = new URLSearchParams(location.search).get('quality');
    const pinned = TIERS.findIndex((t) => t.name === q);
    if (pinned >= 0) this.tierIdx = pinned;
    try {
      this.renderer = new Renderer(this.canvas);
    } catch {
      this.renderer = null; // no WebGL2: the table is the whole UI
    }
    renderHelp($('#help .help-body'));
    this.palette.setSource(() => this.paletteItems());
    this.bindUi();
    this.bindCanvas();
    addEventListener('resize', () => this.resize(true));
    this.canvas.addEventListener('webglcontextlost', () => this.fallback('The 3D view stopped (graphics context lost).'));
    const shared = decodeView(location.hash);
    if (shared) {
      // A share link names a repo: analyse it (rate-limited like any request) and restore the view afterwards.
      this.pendingView = shared;
      void this.analyse(`${shared.repo.owner}/${shared.repo.name}`);
    } else {
      void this.loadDemo();
    }
    requestAnimationFrame((t) => {
      this.last = t;
      requestAnimationFrame(this.frame);
    });
  }

  // ---------- data ----------
  private async loadDemo(): Promise<void> {
    try {
      const res = await fetch(DEMO_URL, { credentials: 'omit' });
      if (!res.ok) return;
      const r = validateResult(await res.json());
      if (this.result) return; // the user already loaded a repo
      this.demo = true;
      this.show(r);
    } catch {
      /* the hero works without a background city */
    }
  }

  private show(r: Result): void {
    this.result = r;
    this.world = buildWorld(r);
    this.lanterns = new Float32Array(this.world.lanterns.length * 3);
    this.cam.frame(this.world.radius);
    this.cam.snap();
    this.selected = -1;
    this.P.focus = -1;
    this.focusGoal = 0;
    this.tT = this.P.t = 1;
    this.playing = false;
    this.compare = null;
    this.inspector.hide();
    this.timeline.set(r);
    if (this.renderer) {
      try {
        this.renderer.setWorld(this.world);
        this.resize(true);
      } catch {
        this.fallback('The 3D view could not start.');
      }
    }
    renderSummary(r, $('#summaryBody'));
    this.renderHonesty();
    if (!this.demo) {
      setText($('#hudRepo'), r.meta.repo);
      renderTable(r, $('#files tbody'), $('#filesCaption'), $('#tableNote'));
      if (!$('#tableView').hidden) drawTreemap(r, $('#treemap') as HTMLCanvasElement);
    }
  }

  private renderHonesty(): void {
    const r = this.result;
    const box = $('#honesty');
    if (!r) return box.replaceChildren();
    const m = r.meta;
    const items: HTMLElement[] = [];
    if (this.demo) items.push(el('span', `Background: ${m.repo}, a real analysis from ${fmtDate(m.generated_at)} (not live).`));
    else items.push(el('span', `${m.repo} @ ${m.sha.slice(0, 7)}`), el('span', `analysed ${fmtDate(m.generated_at)}`));
    items.push(el('span', `${fmt(m.files)} files \u00b7 ${fmt(m.commits)} commits \u00b7 ${fmt(m.people)} people`));
    for (const line of honestyLines(r)) items.push(el('span', line, line.startsWith('Bus') ? undefined : 'warn'));
    if (this.world?.heightFromChanges) items.push(el('span', 'Heights show change counts (line counts unavailable).', 'warn'));
    box.replaceChildren(...items);
  }

  // ---------- flow ----------
  private setMode(m: Mode): void {
    this.mode = m;
    this.body.classList.remove('mode-hero', 'mode-loading', 'mode-story', 'mode-city');
    this.body.classList.add(`mode-${m}`);
    $('#hero').hidden = m !== 'hero';
    $('#loading').hidden = m !== 'loading';
    $('#city').hidden = m !== 'city';
    $('#btnNew').hidden = m === 'hero';
    $('#btnCity').hidden = m !== 'story';
    const explore = m === 'city' && !this.demo;
    $('#btnStory').hidden = !explore || !this.renderer;
    for (const id of ['#btnSearch', '#btnInsights', '#btnPhoto', '#btnHelp']) $(id).hidden = !explore;
    this.timeline.root.hidden = !explore;
    if (!explore) {
      this.insights.toggle(this.result!, false);
      this.inspector.hide();
      this.minimap.canvas.hidden = true;
      this.setCompare(null);
      this.playing = false;
      if (this.photo) this.togglePhoto();
    }
    if (m !== 'story' && this.story.active) this.story.exit();
    this.hideTip();
  }

  /** Scroll story for the loaded result (A4). Reduced motion gets the static-card path inside Story. */
  private enterStory(fromCity = false): void {
    if (!this.result || !this.world || this.demo) return;
    if (fromCity) this.startBlend();
    this.setMode('story');
    this.story.enter(this.result, this.world);
  }

  /** Hand over to the orbit camera exactly where the story camera is, so nothing pops. */
  private enterCity(): void {
    const { pos, tgt } = this.currentPose();
    this.cam.goal = orbitFromPose(pos, tgt);
    this.cam.snap();
    this.fov = 50;
    this.tT = this.P.t = 1;
    this.setMode('city');
    history.replaceState(null, '', '#explore');
  }

  private startBlend(): void {
    const { pos, tgt } = this.currentPose();
    this.blend = { pos: [...pos], tgt: [...tgt], fov: this.fov, k: 0 };
  }

  private currentPose(): { pos: Vec; tgt: Vec } {
    return this.lastPose ?? this.cam.pose();
  }

  private async analyse(raw: string): Promise<void> {
    const cleaned = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    const repo = parseRepo(cleaned);
    if (!repo) {
      setText($('#formErr'), 'Use the form owner/name, for example fastapi/typer.');
      return;
    }
    setText($('#formErr'), '');
    this.lastRepo = `${repo.owner}/${repo.name}`;
    this.loadFrac = 0;
    $('#loadActions').hidden = true;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.setMode('loading');
    const log = $('#log');
    log.replaceChildren();
    const bar = $('#barfill');
    bar.style.width = '4%';
    let lastStage = '';
    const line = (text: string, cls = 'now'): HTMLElement => {
      for (const li of log.querySelectorAll('li.now')) li.className = 'done';
      const li = el('li', text, cls);
      log.append(li);
      return li;
    };
    line(`Asking for ${repo.owner}/${repo.name}`);
    try {
      const { id, done } = await startAnalysis(repo);
      if (!done) {
        await followProgress(
          id,
          (p: Progress) => {
            const text = STAGE_TEXT[p.stage] ?? p.stage;
            if (p.stage !== lastStage) {
              lastStage = p.stage;
              line(p.stage === 'parsing' && p.total ? `${text}: ${fmt(p.n)} of ${fmt(p.total)} commits` : text);
            } else if (p.stage === 'parsing' && p.total) {
              setText(log.lastElementChild as HTMLElement, `${text}: ${fmt(p.n)} of ${fmt(p.total)} commits`);
            }
            const order = ['queued', 'cloning', 'counting', 'parsing', 'sizing', 'scoring', 'done'];
            const base = Math.max(0, order.indexOf(p.stage)) / (order.length - 1);
            const within = p.stage === 'parsing' && p.total ? (p.n / p.total) / (order.length - 1) : 0;
            this.loadFrac = Math.min(1, base + within);
            bar.style.width = `${Math.round(this.loadFrac * 100)}%`;
          },
          abort.signal,
        );
      } else {
        line('Found a fresh analysis of this repository');
      }
      line('Drawing the city');
      const r = await fetchResult(id);
      if (abort.signal.aborted) return;
      if (!r.files.length) throw new ApiError('no_files');
      bar.style.width = '100%';
      this.demo = false;
      this.show(r);
      this.announce(`Loaded ${r.meta.repo}: ${fmt(r.meta.files)} files.`);
      const view = this.pendingView;
      this.pendingView = null;
      if (!this.renderer) {
        this.setMode('city');
        this.openTable(true);
      } else if (view || location.hash === '#explore') {
        this.cam.frame(this.world!.radius);
        if (view?.cam) this.cam.goal = { ...view.cam, y: 4 };
        this.cam.snap();
        if (view?.t !== null && view?.t !== undefined) this.tT = this.P.t = view.t;
        this.setMode('city');
      } else {
        this.enterStory();
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      const code = e instanceof ApiError ? e.code : 'unavailable';
      const offline = !navigator.onLine;
      const text = offline ? 'You appear to be offline. Check your connection and try again.' : (ERROR_TEXT[code] ?? 'Something went wrong. Please try again.');
      line(text, 'fail');
      this.announce(text);
      // Empty/error state (A6): always offer a way forward, never a dead end.
      const retry = !['invalid_repo', 'not_found', 'empty_repo', 'no_files', 'too_large'].includes(code) || offline;
      $('#btnRetry').hidden = !retry;
      $('#loadActions').hidden = false;
      ($(retry ? '#btnRetry' : '#btnBack') as HTMLButtonElement).focus();
    }
  }

  private announce(text: string): void {
    setText($('#announce'), text);
  }

  private toast(text: string): void {
    const t = $('#toast');
    setText(t, text);
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), 2400);
  }
  private toastTimer = 0;

  private fallback(reason: string): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.announce(reason);
    if (this.result && !this.demo) this.openTable(true);
  }

  private openTable(open: boolean): void {
    const view = $('#tableView');
    view.hidden = !open;
    $('#btnTable').setAttribute('aria-pressed', String(open));
    if (open && this.result && !this.demo) {
      renderTable(this.result, $('#files tbody'), $('#filesCaption'), $('#tableNote'));
      drawTreemap(this.result, $('#treemap') as HTMLCanvasElement);
    } else if (open) {
      $('#filesCaption').textContent = 'Load a repository to see its files.';
    }
  }

  // ---------- explore actions (A5): one entry point for keys, palette and buttons ----------
  private run(id: ActionId): void {
    const w = this.world;
    const r = this.result;
    if (!w || !r) return;
    const reduced = reducedMotion();
    switch (id) {
      case 'home':
        this.cam.autoOrbit = false;
        this.cam.flyTo(this.cam.home(w.radius), 0.9, reduced);
        break;
      case 'reset':
        this.select(-1);
        this.setCompare(null);
        this.tT = 1;
        this.playing = false;
        this.cam.autoOrbit = false;
        this.cam.flyTo(this.cam.home(w.radius), 0.9, reduced);
        break;
      case 'frame':
        if (this.selected >= 0) this.flyToFile(this.selected);
        else this.toast('Select a building first (click, or search with /).');
        break;
      case 'preset1':
      case 'preset2':
      case 'preset3':
      case 'preset4':
      case 'preset5': {
        const p = PRESETS[Number(id.slice(-1)) - 1]!;
        this.cam.autoOrbit = p === 'cinematic';
        this.cam.flyTo(this.cam.preset(p, w.radius), 1, reduced);
        this.announce(`View: ${KEYMAP.find((k) => k.id === id)?.label ?? p}`);
        break;
      }
      case 'play':
        if (!this.playing && this.tT >= 0.999) this.tT = this.P.t = 0;
        this.playing = !this.playing;
        this.announce(this.playing ? 'Playing history' : 'Paused');
        break;
      case 'slower':
      case 'faster':
        this.speedIdx = clamp(this.speedIdx + (id === 'faster' ? 1 : -1), 0, SPEEDS.length - 1);
        this.announce(`Playback ${SPEEDS[this.speedIdx]}x`);
        break;
      case 'stepBack':
      case 'stepFwd': {
        this.playing = false;
        const month = (31 * 86400) / (w.t1 - w.t0);
        this.scrub(clamp(this.tT + (id === 'stepFwd' ? month : -month), 0, 1));
        break;
      }
      case 'timeline':
        this.timeline.root.hidden = !this.timeline.root.hidden;
        break;
      case 'compare':
        this.setCompare(this.compare ? null : { a: clamp(this.tT - 0.25, 0, 0.75), b: this.tT >= 0.999 ? 1 : this.tT });
        break;
      case 'palette':
        this.palette.show();
        break;
      case 'insights':
        this.insights.toggle(r);
        $('#btnInsights').setAttribute('aria-pressed', String(this.insights.open));
        break;
      case 'minimap':
        this.minimap.canvas.hidden = !this.minimap.canvas.hidden;
        break;
      case 'table':
        this.openTable($('#tableView').hasAttribute('hidden'));
        break;
      case 'help':
        ($('#help') as HTMLDialogElement).showModal();
        break;
      case 'photo':
        this.togglePhoto();
        break;
      case 'arcs':
        this.P.arcs = this.P.arcs ? 0 : 1;
        this.toast(this.P.arcs ? 'Coupling arcs on' : 'Coupling arcs off');
        break;
      case 'lanterns':
        this.P.lanterns = this.P.lanterns ? 0 : 1;
        this.toast(this.P.lanterns ? 'Lanterns on' : 'Lanterns off');
        break;
      case 'share':
        void this.share();
        break;
      case 'story':
        this.enterStory(true);
        break;
    }
  }

  private scrub(t: number): void {
    this.tT = t;
    this.playing = false;
    if (reducedMotion()) this.P.t = t;
  }

  private setCompare(c: { a: number; b: number } | null): void {
    this.compare = c;
    const box = $('#compareLegend');
    const r = this.result;
    const w = this.world;
    if (!c || !r || !w) {
      box.hidden = true;
      this.P.cmp = [0, 0, 0];
      return;
    }
    this.P.cmp = [1, c.a, c.b];
    const at = (t: number): number => w.t0 + t * (w.t1 - w.t0);
    const n = compareCounts(r, at(c.a), at(c.b));
    const row = (cls: string, label: string, count: number): HTMLElement => {
      const p = el('div');
      const i = el('i', null, cls);
      i.setAttribute('aria-hidden', 'true');
      p.append(i, document.createTextNode(`${label}: ${fmt(count)}`));
      return p;
    };
    box.replaceChildren(
      el('strong', `Compare ${fmtDate(at(c.a))} \u2192 ${fmtDate(at(c.b))}`),
      row('c-added', 'Added in this window', n.added),
      row('c-last', 'Last changed in this window', n.lastIn),
      row('c-after', 'Still changing after it', n.after),
      row('c-before', 'Untouched since before it', n.before),
      el('p', 'Deleted files are not in this analysis, so removals are not shown. Use , and . to move the window end, [ ] for speed.', 'sub'),
    );
    box.hidden = false;
  }

  private async share(): Promise<void> {
    const r = this.result;
    const repo = r ? parseRepo(r.meta.repo) : null;
    if (!repo) return;
    const g = this.cam.goal;
    const hash = encodeView({ repo: repo as RepoRef, cam: { yaw: g.yaw, pitch: g.pitch, dist: g.dist, x: g.x, z: g.z }, t: this.tT });
    const url = `${location.origin}${location.pathname}${hash}`;
    history.replaceState(null, '', hash);
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Link to this view copied');
    } catch {
      this.toast('Link is in the address bar (clipboard unavailable)');
    }
  }

  private togglePhoto(): void {
    this.photo = !this.photo;
    this.body.classList.toggle('photo', this.photo);
    $('#photoBar').hidden = !this.photo;
    this.cam.autoOrbit = this.photo;
    if (this.photo) ($('#btnSave') as HTMLButtonElement).focus();
    this.announce(this.photo ? 'Photo mode. Save PNG, or Esc to leave.' : 'Left photo mode');
  }

  /** Called right after a render, while the drawing buffer is still valid: compose a poster and download it. */
  private exportPng(): void {
    const r = this.result;
    if (!r) return;
    const src = this.canvas;
    const out = document.createElement('canvas');
    const w = src.width;
    const h = src.height;
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(src, 0, 0);
    const pad = Math.round(w * 0.03);
    const g = ctx.createLinearGradient(0, h * 0.72, 0, h);
    g.addColorStop(0, 'rgba(6,10,17,0)');
    g.addColorStop(1, 'rgba(6,10,17,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.7, w, h * 0.3);
    ctx.fillStyle = '#ece6db';
    ctx.font = `italic ${Math.round(h * 0.06)}px "Cormorant Garamond", Georgia, serif`;
    ctx.fillText(r.meta.repo, pad, h - pad * 2.2);
    ctx.font = `${Math.round(h * 0.018)}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = '#a9bbbd';
    const t = this.world ? this.world.t0 + this.P.t * (this.world.t1 - this.world.t0) : r.meta.span[1];
    const caveats = honestyLines(r).filter((l) => !l.startsWith('Bus')).join(' ');
    ctx.fillText(
      `Afterglow \u00b7 ${r.meta.sha.slice(0, 7)} \u00b7 as of ${fmtDate(t)} \u00b7 ${fmt(r.meta.files)} files, ${fmt(r.meta.commits)} commits${caveats ? ' \u00b7 ' + caveats : ''}`,
      pad,
      h - pad,
      w - pad * 2,
    );
    out.toBlob((blob) => {
      if (!blob) return;
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `afterglow-${r.meta.repo.replace('/', '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      this.toast('PNG saved');
    }, 'image/png');
  }

  private paletteItems(): Item[] {
    const r = this.result;
    if (!r || this.demo) return [];
    const items: Item[] = KEYMAP.map((k) => ({ kind: 'action', label: k.label, hint: k.keys.join(' / '), key: `a:${k.id}`, run: () => this.run(k.id) }));
    r.dirs.forEach((d, i) =>
      items.push({ kind: 'district', label: `${d.name}/`, hint: `district \u00b7 ${fmt(d.files)} files`, key: `d:${i}`, run: () => this.flyToDistrict(i) }),
    );
    r.people.forEach((p) =>
      items.push({
        kind: 'person',
        label: p.handle,
        hint: `${fmt(p.commits)} commits \u00b7 ${p.areas.map((a) => r.dirs[a]?.name).join(', ')}`,
        key: `p:${p.handle}`,
        run: () => {
          if (p.areas[0] !== undefined) this.flyToDistrict(p.areas[0]);
        },
      }),
    );
    r.files.forEach((f, i) => items.push({ kind: 'file', label: f.path, hint: `${fmt(f.changes_12m)} / 12 mo`, key: `f:${i}`, run: () => this.select(i, true) }));
    return items;
  }

  private flyToFile(i: number): void {
    const w = this.world;
    if (!w) return;
    this.cam.autoOrbit = false;
    const h = w.pos[i * 3 + 1]!;
    this.cam.flyTo({ yaw: this.cam.goal.yaw, pitch: 0.42, dist: clamp(h * 3 + 18, 16, 60), x: w.pos[i * 3]!, y: Math.min(8, h * 0.5), z: w.pos[i * 3 + 2]! }, 0.85, reducedMotion());
  }

  private flyToDistrict(d: number): void {
    const w = this.world;
    const dist = w?.dists[d];
    if (!w || !dist) return;
    this.select(-1);
    this.P.focus = d;
    this.focusGoal = 1;
    this.cam.autoOrbit = false;
    this.cam.flyTo({ yaw: this.cam.goal.yaw, pitch: 0.55, dist: clamp(dist.r * 2.6, 20, this.cam.maxDist), x: dist.x, y: 2, z: dist.z }, 0.9, reducedMotion());
    const r = this.result!;
    const x = r.dirs[d]!;
    setText($('#placeEy'), 'District');
    setText($('#placeName'), x.name);
    setText($('#placeSub'), `${fmt(x.files)} files \u00b7 bus factor ${fmt(x.bus_factor)}${x.quiet ? ' \u00b7 quiet' : ''}`);
    this.announce(`District ${x.name}: ${fmt(x.files)} files.`);
  }

  // ---------- input ----------
  private bindUi(): void {
    $('#form').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.analyse(($('#repoInput') as HTMLInputElement).value);
    });
    for (const b of document.querySelectorAll<HTMLButtonElement>('.samples button')) {
      b.addEventListener('click', () => {
        ($('#repoInput') as HTMLInputElement).value = b.dataset['repo'] ?? '';
        void this.analyse(b.dataset['repo'] ?? '');
      });
    }
    $('#btnCity').addEventListener('click', () => this.enterCity());
    $('#btnStory').addEventListener('click', () => this.enterStory(true));
    $('#btnSearch').addEventListener('click', () => this.run('palette'));
    $('#btnInsights').addEventListener('click', () => this.run('insights'));
    $('#btnPhoto').addEventListener('click', () => this.run('photo'));
    $('#btnHelp').addEventListener('click', () => this.run('help'));
    $('#btnSave').addEventListener('click', () => (this.exportNext = true));
    $('#btnPhotoExit').addEventListener('click', () => this.togglePhoto());
    ($('#timeline .play') as HTMLButtonElement).addEventListener('click', () => this.run('play'));
    $('#timeline .track').addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        this.scrub(clamp(this.tT + (k === 'ArrowRight' ? 0.02 : -0.02), 0, 1));
      }
    });
    addEventListener(
      'pointermove',
      (e) => {
        this.pointer.x = (e.clientX / innerWidth) * 2 - 1;
        this.pointer.y = (e.clientY / innerHeight) * 2 - 1;
      },
      { passive: true },
    );
    $('#btnRetry').addEventListener('click', () => void this.analyse(this.lastRepo));
    $('#btnBack').addEventListener('click', () => {
      this.setMode(this.result && !this.demo ? 'city' : 'hero');
      if (this.mode === 'hero') ($('#repoInput') as HTMLInputElement).focus();
    });
    $('#btnCancel').addEventListener('click', () => {
      this.abort?.abort();
      this.setMode(this.result && !this.demo ? 'city' : 'hero');
    });
    $('#btnNew').addEventListener('click', () => {
      this.abort?.abort();
      this.openTable(false);
      this.setMode('hero');
      history.replaceState(null, '', location.pathname + location.search);
      ($('#repoInput') as HTMLInputElement).focus();
    });
    $('#btnTable').addEventListener('click', () => this.openTable($('#tableView').hasAttribute('hidden')));
    addEventListener('keyup', (e) => this.held.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.held.clear());
    addEventListener('keydown', (e) => {
      const active = document.activeElement as HTMLElement | null;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? '');
      if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys (Esc closes)
      if (e.key === 'Escape') {
        // Back out one level: photo -> table -> panels/selection/compare -> story.
        if (this.photo) return this.togglePhoto();
        if (!$('#tableView').hidden) return this.openTable(false);
        if (this.compare) return this.setCompare(null);
        if (this.selected >= 0 || this.P.focus >= 0) return this.select(-1);
        if (this.insights.open) return this.run('insights');
        if (this.mode === 'city' && !this.demo && this.renderer) return this.enterStory(true);
        return;
      }
      if (this.mode !== 'city' || typing || this.demo) return;
      if (e.key === ' ' && active?.tagName === 'BUTTON') return; // Space activates the focused button
      const action = actionFor(e);
      if (action) {
        e.preventDefault();
        this.run(action);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'shift') this.held.add(k);
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', '+', '=', '-'].includes(k)) {
        e.preventDefault();
        this.held.add(k);
        this.cam.autoOrbit = false;
      }
    });
  }

  /** Continuous keyboard movement while keys are held (frame-rate independent). */
  private keyMove(dt: number, shift: boolean): void {
    if (!this.held.size) return;
    const s = (shift ? 2 : 1) * dt * 60;
    const h = this.held;
    if (h.has('w')) this.cam.walk(s * 0.5, 0);
    if (h.has('s')) this.cam.walk(-s * 0.5, 0);
    if (h.has('a')) this.cam.walk(0, -s * 0.5);
    if (h.has('d')) this.cam.walk(0, s * 0.5);
    if (h.has('arrowleft') || h.has('q')) this.cam.orbit(-6 * s, 0);
    if (h.has('arrowright') || h.has('e')) this.cam.orbit(6 * s, 0);
    if (h.has('arrowup')) this.cam.orbit(0, 5 * s);
    if (h.has('arrowdown')) this.cam.orbit(0, -5 * s);
    if (h.has('+') || h.has('=')) this.cam.zoom(1 - 0.02 * s);
    if (h.has('-')) this.cam.zoom(1 + 0.02 * s);
  }

  private bindCanvas(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'city') return;
      c.setPointerCapture(e.pointerId);
      this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      this.dragMoved = 0;
      this.cam.autoOrbit = false;
      this.cam.still();
      if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()];
        this.pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
      c.classList.add('drag');
    });
    c.addEventListener('pointermove', (e) => {
      if (this.mode !== 'city') return;
      const p = this.ptrs.get(e.pointerId);
      if (!p) {
        if (e.pointerType !== 'touch') this.hoverAt = { x: e.clientX, y: e.clientY };
        return;
      }
      const now = performance.now();
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      const dt = Math.max(1, now - p.t) / 1000;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      p.x = e.clientX;
      p.y = e.clientY;
      p.t = now;
      if (this.ptrs.size === 1) {
        if (e.shiftKey || e.buttons === 2) this.cam.pan(dx, dy);
        else this.cam.orbit(dx, dy, dt);
      } else if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (this.pinch) this.zoomAt(this.pinch / d, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
        this.pinch = d;
      }
      this.hideTip();
    });
    const up = (e: PointerEvent): void => {
      const p = this.ptrs.get(e.pointerId);
      if (!p) return;
      const click = this.dragMoved < 6 && this.ptrs.size === 1;
      if (performance.now() - p.t > 90) this.cam.still(); // held still before release: no fling
      this.ptrs.delete(e.pointerId);
      if (this.ptrs.size < 2) this.pinch = 0;
      if (!this.ptrs.size) c.classList.remove('drag');
      if (click) void this.pickAt(e.clientX, e.clientY).then((i) => this.select(i));
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', (e) => {
      if (this.mode !== 'city') return;
      void this.pickAt(e.clientX, e.clientY).then((i) => {
        if (i >= 0) this.select(i, true);
      });
    });
    c.addEventListener('pointerleave', () => {
      this.hoverAt = null;
      this.P.hover = this.selected;
      this.hideTip();
    });
    c.addEventListener('contextmenu', (e) => {
      if (this.mode === 'city') e.preventDefault();
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'city') return;
        e.preventDefault();
        // Trackpad pinch arrives as ctrl+wheel with small deltas; both zoom toward the cursor.
        this.zoomAt(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0011)), e.clientX, e.clientY);
      },
      { passive: false },
    );
  }

  private zoomAt(factor: number, x: number, y: number): void {
    this.cam.autoOrbit = false;
    const rect = this.canvas.getBoundingClientRect();
    const C = this.cameraNow();
    this.cam.zoomAt(factor, C.pos, rayThrough(C, x - rect.left, y - rect.top, rect.width, rect.height));
  }

  private async pickAt(x: number, y: number): Promise<number> {
    if (!this.renderer || !this.rendererReady) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    const R = this.renderer;
    const run = (): Promise<number> => R.pick(this.cameraNow(), this.P, (x - rect.left) * sx, (y - rect.top) * sy);
    const next = this.pickChain.then(run, run);
    this.pickChain = next;
    return next;
  }

  private select(i: number, fly = false): void {
    const r = this.result;
    const w = this.world;
    this.selected = i;
    this.P.hover = i;
    if (!r || !w || i < 0) {
      this.P.focus = -1;
      this.focusGoal = 0;
      this.inspector.hide();
      setText($('#placeEy'), 'Exploring');
      setText($('#placeName'), 'the whole city');
      setText($('#placeSub'), '');
      return;
    }
    const f = r.files[i]!;
    const d = r.dirs[f.dir]!;
    this.P.focus = f.dir;
    this.focusGoal = 1;
    if (fly) this.flyToFile(i);
    this.inspector.show(r, i);
    setText($('#placeEy'), 'District');
    setText($('#placeName'), d.name);
    setText($('#placeSub'), `${fmt(d.files)} files \u00b7 bus factor ${fmt(d.bus_factor)}${d.quiet ? ' \u00b7 quiet' : ''}`);
    this.announce(`Selected ${f.path} in ${d.name}.`);
  }

  private showTip(i: number, x: number, y: number): void {
    const r = this.result;
    if (!r) return;
    const f = r.files[i];
    if (!f) return;
    const tip = $('#tip');
    const rows: [string, string][] = [
      ['changes, last 12 months', fmt(f.changes_12m)],
      ['changes, all time', fmt(f.changes)],
      ['authors, all time', fmt(f.authors)],
      ['lines', r.meta.truncated.sizes && f.loc === 0 ? 'n/a' : fmt(f.loc)],
      ['last change', ago(f.last, r.meta.span[1])],
    ];
    const kids: HTMLElement[] = [];
    if (f.hot) kids.push(el('span', 'hotspot', 'pill hot'));
    else if (f.dead) kids.push(el('span', 'quiet', 'pill quiet'));
    kids.push(el('div', f.path, 'n'));
    for (const [k, v] of rows) {
      const row = el('div', null, 'row');
      row.append(el('span', k), el('b', v));
      kids.push(row);
    }
    tip.replaceChildren(...kids);
    tip.hidden = false;
    const tx = Math.min(x + 16, innerWidth - 266);
    const ty = Math.min(y + 16, innerHeight - tip.offsetHeight - 12);
    tip.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
  }

  private hideTip(): void {
    $('#tip').hidden = true;
  }

  // ---------- loop ----------
  private resize(force: boolean): void {
    if (!this.renderer) return;
    const tier = TIERS[this.tierIdx]!;
    const dpr = Math.min(devicePixelRatio || 1, tier.dpr) * this.scale;
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (force || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.renderer.alloc(w, h, tier);
    }
  }

  /** Dynamic resolution (EXPERIENCE section 9): nudge the render scale to hold ~16.6 ms; step tiers only on sustained misses. */
  private adapt(rawMs: number): void {
    if (rawMs > 250) return; // tab switch or debugger pause, not a real frame
    this.frameMs = lerp(this.frameMs, rawMs, 0.08);
    if (this.frameMs > 18.5) {
      this.slowFor++;
      this.fastFor = 0;
    } else if (this.frameMs < 14.5) {
      this.fastFor++;
      this.slowFor = 0;
    } else {
      this.slowFor = this.fastFor = 0;
    }
    if (this.slowFor > 20) {
      this.slowFor = 0;
      if (this.scale > 0.62) this.scale = Math.max(0.6, this.scale - 0.08);
      else if (this.tierIdx > 0) (this.tierIdx--, (this.scale = 0.85));
      this.resize(true);
    } else if (this.fastFor > 180 && this.scale < 1) {
      this.fastFor = 0; // hysteresis: recover slowly
      this.scale = Math.min(1, this.scale + 0.05);
      this.resize(true);
    }
  }

  private cameraNow(pos?: Vec, tgt?: Vec, fov = this.fov) {
    const pose = pos && tgt ? { pos, tgt } : (this.lastPose ?? this.cam.pose());
    const far = Math.max(1200, (this.world?.radius ?? 100) * 6);
    return buildCamera(pose.pos, pose.tgt, this.canvas.clientWidth, this.canvas.clientHeight, far, fov);
  }

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const rawMs = now - this.last;
    const dt = Math.min(0.05, rawMs / 1000);
    this.last = now;
    if (document.hidden) return; // nothing to draw for a hidden tab
    this.time += dt;
    const reduced = reducedMotion();
    const P = this.P;
    P.grain = reduced ? 0 : 0.035;
    P.fade = smoothstep(0, 1.4, this.time);
    if (this.mode === 'city') {
      P.hot = 1;
      P.fog = FOG;
      P.exposure = 1;
      this.keyMove(dt, this.held.has('shift'));
      // History playback and scrubbing: P.t eases toward the target so scrubs glide, never jump.
      if (this.playing) {
        this.tT = Math.min(1, this.tT + (dt * SPEEDS[this.speedIdx]!) / PLAY_SECONDS);
        if (this.tT >= 1) this.playing = false;
      }
      P.t = reduced || this.playing ? this.tT : P.t + (this.tT - P.t) * (1 - Math.exp(-dt * 8));
      if (this.compare) {
        this.compare.b = Math.max(this.compare.a + 0.01, this.tT);
        P.cmp = [1, this.compare.a, this.compare.b];
      }
    } else if (this.mode !== 'story') {
      P.hot = 0.5;
      P.fog = FOG * 1.15;
      // Loading is a scene (A6): the background city un-builds in step with real analysis progress.
      const goal = this.mode === 'loading' ? 1 - 0.92 * this.loadFrac : 1;
      P.t = reduced ? goal : P.t + (goal - P.t) * (1 - Math.exp(-dt * 2.5));
      P.exposure = 1;
      if (!reduced) this.cam.goal.yaw += dt * 0.03; // slow drift behind the hero and loading log
    } else {
      P.fog = FOG;
    }
    this.cam.update(dt, reduced);
    let pos: Vec;
    let tgt: Vec;
    let fov = 50;
    P.ca = 1;
    const sf = this.mode === 'story' ? this.story.frame(now, this.lastVP, this.canvas.clientWidth, this.canvas.clientHeight) : null;
    if (sf) {
      const ps = sf.pose;
      pos = [...ps.pos];
      tgt = [...ps.tgt];
      fov = ps.fov + 3.5 * sf.velocity; // FOV kick with scroll speed, clamped by velocity in [0,1]
      P.t = ps.t;
      P.hot = ps.hot;
      P.exposure = ps.exposure;
      P.focus = ps.focus;
      this.focusGoal = ps.focus >= 0 ? 0.55 : 0;
      P.ca = 1 + 5 * sf.velocity;
      P.fade *= sf.fade;
      if (!reduced) {
        // Handheld micro-motion and a small, damped pointer parallax; additive, so the rig stays a pure function of p.
        const r = this.cameraNow(pos, tgt, fov).right;
        pos[0] += Math.sin(this.time * 0.13) * 0.4 + r[0] * this.pointer.x * 1.1;
        pos[1] += Math.sin(this.time * 0.17) * 0.25 - this.pointer.y * 0.5;
        pos[2] += Math.cos(this.time * 0.11) * 0.4 + r[2] * this.pointer.x * 1.1;
      }
    } else {
      ({ pos, tgt } = this.cam.pose());
    }
    if (this.blend) {
      const b = this.blend;
      b.k = Math.min(1, b.k + dt / 0.9);
      const e = reduced ? 1 : b.k < 0.5 ? 4 * b.k ** 3 : 1 - (-2 * b.k + 2) ** 3 / 2;
      pos = [lerp(b.pos[0], pos[0], e), lerp(b.pos[1], pos[1], e), lerp(b.pos[2], pos[2], e)];
      tgt = [lerp(b.tgt[0], tgt[0], e), lerp(b.tgt[1], tgt[1], e), lerp(b.tgt[2], tgt[2], e)];
      fov = lerp(b.fov, fov, e);
      if (b.k >= 1) this.blend = null;
    }
    // A6 effects. Depth of field: story pulls focus onto each chapter's subject; the city focuses the selection or
    // the orbit target; the hero stays soft behind the text.
    const w0 = this.world;
    const dist = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    let focus = dist(pos, tgt);
    if (sf && w0) {
      const at = this.story.chapters[sf.pose.chapter]?.callout?.at;
      if (at) focus = dist(pos, at as Vec);
    } else if (this.mode === 'city' && w0 && this.selected >= 0) {
      focus = dist(pos, [w0.pos[this.selected * 3]!, w0.pos[this.selected * 3 + 1]!, w0.pos[this.selected * 3 + 2]!]);
    }
    P.focusDist += (focus - (P.focusDist || focus)) * (1 - Math.exp(-dt * 4)); // focus pulls glide, never snap
    P.dof = this.mode === 'story' ? 1 : this.mode === 'city' ? (this.photo ? 1 : 0.55) : 0.4;
    P.motion = reduced ? 0 : 1;
    P.sel = this.mode === 'city' ? this.selected : -1;
    const liftGoal = this.mode === 'city' && P.hover >= 0 && !reduced ? 1 : 0;
    P.lift += (liftGoal - P.lift) * (1 - Math.exp(-dt * 10));
    // Camera shake: very small, only close to hotspot beams, never with reduced motion.
    if (!reduced && w0 && w0.hot.length && (this.mode === 'city' || this.mode === 'story')) {
      let near = Infinity;
      for (const fi of w0.hot) near = Math.min(near, Math.hypot(pos[0] - w0.pos[fi * 3]!, pos[2] - w0.pos[fi * 3 + 2]!));
      const amp = 0.09 * smoothstep(42, 12, near) * P.hot;
      if (amp > 1e-3) {
        const t = this.time;
        const sx = Math.sin(t * 23.1) * 0.6 + Math.sin(t * 37.7) * 0.4;
        const sy = Math.sin(t * 29.3) * 0.6 + Math.sin(t * 17.9) * 0.4;
        pos = [pos[0] + sx * amp, pos[1] + sy * amp, pos[2]];
        tgt = [tgt[0] + sx * amp * 0.5, tgt[1] + sy * amp * 0.5, tgt[2]];
      }
    }
    this.fov = fov;
    this.lastPose = { pos, tgt };
    P.focusAmt += (this.focusGoal - P.focusAmt) * (1 - Math.exp(-dt * 5));
    const C = this.cameraNow(pos, tgt, fov);
    this.lastVP = C.vp;

    const w = this.world;
    if (w && this.lanterns) {
      for (let i = 0; i < w.lanterns.length; i++) {
        const L = w.lanterns[i]!;
        const s = this.time * 0.06 * L.speed + L.off;
        const k = Math.floor(s);
        const u = reduced ? 0 : smoothstep(0, 1, s - k);
        const a = L.wp[k % L.wp.length]!;
        const b = L.wp[(k + 1) % L.wp.length]!;
        this.lanterns.set([lerp(a[0], b[0], u), lerp(a[1], b[1], u) + Math.sin(u * Math.PI) * 3.5, lerp(a[2], b[2], u)], i * 3);
      }
    }
    if (w && this.mode === 'city' && !this.demo) {
      this.timeline.update(this.tT, this.playing, SPEEDS[this.speedIdx]!, this.compare, (t) => w.t0 + t * (w.t1 - w.t0));
      const hotDirs = new Set(this.result!.insights.hotspots.map((i) => this.result!.files[i]!.dir));
      this.minimap.draw(w, pos, tgt, hotDirs);
    }

    const R = this.renderer;
    if (!R || !w) return;
    if (!this.rendererReady) {
      try {
        this.rendererReady = R.ready();
      } catch (e) {
        this.fallback(e instanceof RendererError ? 'The 3D view could not start on this device.' : 'The 3D view failed.');
        return;
      }
      if (!this.rendererReady) return;
    }
    if (this.hoverAt && !this.pickBusy && this.mode === 'city' && !this.photo) {
      const at = this.hoverAt;
      this.hoverAt = null;
      this.pickBusy = true;
      void this.pickAt(at.x, at.y).then((i) => {
        this.pickBusy = false;
        P.hover = i >= 0 ? i : this.selected;
        if (i >= 0) this.showTip(i, at.x, at.y);
        else this.hideTip();
        this.canvas.style.cursor = i >= 0 ? 'pointer' : '';
      });
    }
    R.render(C, P, this.time, this.lanterns);
    if (this.exportNext) {
      this.exportNext = false;
      this.exportPng(); // same task as the render: the drawing buffer is still intact
    }
    this.adapt(rawMs);
  };
}
