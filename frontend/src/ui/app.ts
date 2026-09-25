/**
 * App controller for A3: hero -> loading (real SSE progress) -> city, plus the 2D table fallback.
 * The scroll story (A4), full explore tools (A5) and the effects pass (A6) build on this.
 */
import { ApiError, fetchResult, followProgress, startAnalysis, type Progress } from '../lib/api';
import { parseRepo } from '../lib/repo';
import { validateResult, type Result } from '../lib/result';
import { lerp, smoothstep } from '../render/math';
import { Renderer, RendererError, TIERS, type Params } from '../render/renderer';
import { buildWorld, type World } from '../world/build';
import { buildCamera, OrbitCamera, orbitFromPose } from './camera';
import { $, ago, el, fmt, fmtDate, reducedMotion, setText } from './dom';
import { Story } from './story';
import { drawTreemap, honestyLines, renderSummary, renderTable } from './table';

type Mode = 'hero' | 'loading' | 'story' | 'city';
const DEMO_URL = '/demo/fastapi-fastapi.json';
const FOG = 0.0072;

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
};

export class App {
  private mode: Mode = 'hero';
  private renderer: Renderer | null = null;
  private rendererReady = false;
  private world: World | null = null;
  private result: Result | null = null;
  private demo = true;
  private readonly cam = new OrbitCamera();
  private readonly P: Params = { t: 1, fog: FOG, hot: 0.5, focus: -1, focusAmt: 0, hover: -1, fade: 0, exposure: 1, grain: 0.035, ca: 1 };
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
  private ptrs = new Map<number, { x: number; y: number }>();
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
  private blend: { pos: [number, number, number]; tgt: [number, number, number]; fov: number; k: number } | null = null;
  private fov = 50;
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
    this.bindUi();
    this.bindCanvas();
    addEventListener('resize', () => this.resize(true));
    this.canvas.addEventListener('webglcontextlost', () => this.fallback('The 3D view stopped (graphics context lost).'));
    void this.loadDemo();
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
    $('#btnStory').hidden = m !== 'city' || this.demo || !this.renderer;
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
    this.setMode('city');
    history.replaceState(null, '', '#explore');
  }

  private startBlend(): void {
    const { pos, tgt } = this.currentPose();
    this.blend = { pos: [...pos], tgt: [...tgt], fov: this.fov, k: 0 };
  }

  private currentPose(): { pos: [number, number, number]; tgt: [number, number, number] } {
    return this.lastPose ?? this.cam.pose();
  }
  private lastPose: { pos: [number, number, number]; tgt: [number, number, number] } | null = null;

  private async analyse(raw: string): Promise<void> {
    const cleaned = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    const repo = parseRepo(cleaned);
    if (!repo) {
      setText($('#formErr'), 'Use the form owner/name, for example fastapi/typer.');
      return;
    }
    setText($('#formErr'), '');
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
            bar.style.width = `${Math.round(Math.min(1, base + within) * 100)}%`;
          },
          abort.signal,
        );
      } else {
        line('Found a fresh analysis of this repository');
      }
      line('Drawing the city');
      const r = await fetchResult(id);
      if (abort.signal.aborted) return;
      bar.style.width = '100%';
      this.demo = false;
      this.show(r);
      this.announce(`Loaded ${r.meta.repo}: ${fmt(r.meta.files)} files.`);
      if (!this.renderer) {
        this.setMode('city');
        this.openTable(true);
      } else if (location.hash === '#explore') {
        this.cam.frame(this.world!.radius);
        this.cam.snap();
        this.setMode('city');
      } else {
        this.enterStory();
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      const code = e instanceof ApiError ? e.code : 'unavailable';
      line(ERROR_TEXT[code] ?? 'Something went wrong. Please try again.', 'fail');
      this.announce(ERROR_TEXT[code] ?? 'Analysis failed.');
    }
  }

  private announce(text: string): void {
    setText($('#announce'), text);
  }

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
      $('#tableTitle').focus?.();
    } else if (open) {
      $('#filesCaption').textContent = 'Load a repository to see its files.';
    }
  }

  // ---------- input ----------
  private bindUi(): void {
    $('#form').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.analyse(($('#repoInput') as HTMLInputElement).value);
    });
    for (const b of document.querySelectorAll<HTMLButtonElement>('.samples button')) {
      b.addEventListener('click', () => {
        (($('#repoInput') as HTMLInputElement).value = b.dataset['repo'] ?? '');
        void this.analyse(b.dataset['repo'] ?? '');
      });
    }
    $('#btnCity').addEventListener('click', () => this.enterCity());
    $('#btnStory').addEventListener('click', () => this.enterStory(true));
    addEventListener('pointermove', (e) => {
      this.pointer.x = (e.clientX / innerWidth) * 2 - 1;
      this.pointer.y = (e.clientY / innerHeight) * 2 - 1;
    }, { passive: true });
    $('#btnCancel').addEventListener('click', () => {
      this.abort?.abort();
      this.setMode(this.result && !this.demo ? 'city' : 'hero');
    });
    $('#btnNew').addEventListener('click', () => {
      this.abort?.abort();
      this.openTable(false);
      this.setMode('hero');
      ($('#repoInput') as HTMLInputElement).focus();
    });
    $('#btnTable').addEventListener('click', () => this.openTable($('#tableView').hasAttribute('hidden')));
    addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? '');
      if (e.key === 'Escape') {
        if (!$('#tableView').hidden) return this.openTable(false);
        if (this.selected >= 0) return this.select(-1);
      }
      if (this.mode !== 'city' || typing) return;
      const s = e.shiftKey ? 2 : 1;
      const k = e.key.toLowerCase();
      let hit = true;
      if (k === 'arrowleft' || k === 'a') this.cam.orbit(-18 * s, 0);
      else if (k === 'arrowright' || k === 'd') this.cam.orbit(18 * s, 0);
      else if (k === 'arrowup' || k === 'w') this.cam.orbit(0, 15 * s);
      else if (k === 'arrowdown' || k === 's') this.cam.orbit(0, -15 * s);
      else if (k === '+' || k === '=') this.cam.zoom(0.88);
      else if (k === '-') this.cam.zoom(1.14);
      else if (k === 'h' && this.world) this.cam.frame(this.world.radius);
      else hit = false;
      if (hit) e.preventDefault();
    });
  }

  private bindCanvas(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'city') return;
      c.setPointerCapture(e.pointerId);
      this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragMoved = 0;
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
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.ptrs.size === 1) {
        if (e.shiftKey || e.buttons === 2) this.cam.pan(dx, dy);
        else this.cam.orbit(dx, dy);
      } else if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (this.pinch) this.cam.zoom(this.pinch / d);
        this.pinch = d;
      }
      this.hideTip();
    });
    const up = (e: PointerEvent): void => {
      if (!this.ptrs.has(e.pointerId)) return;
      const click = this.dragMoved < 6 && this.ptrs.size === 1;
      this.ptrs.delete(e.pointerId);
      if (this.ptrs.size < 2) this.pinch = 0;
      if (!this.ptrs.size) c.classList.remove('drag');
      if (click) void this.pickAt(e.clientX, e.clientY).then((i) => this.select(i));
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
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
        this.cam.zoom(Math.exp(e.deltaY * 0.0011));
      },
      { passive: false },
    );
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

  private select(i: number): void {
    const r = this.result;
    const w = this.world;
    this.selected = i;
    if (!r || !w || i < 0) {
      this.P.focus = -1;
      this.focusGoal = 0;
      setText($('#placeEy'), 'Exploring');
      setText($('#placeName'), 'the whole city');
      setText($('#placeSub'), '');
      return;
    }
    const f = r.files[i]!;
    const d = r.dirs[f.dir]!;
    this.P.focus = f.dir;
    this.focusGoal = 1;
    this.cam.goal.x = w.pos[i * 3]!;
    this.cam.goal.z = w.pos[i * 3 + 2]!;
    this.cam.goal.y = Math.min(8, w.pos[i * 3 + 1]! * 0.5);
    this.cam.goal.dist = Math.min(this.cam.goal.dist, 60);
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

  private cameraNow(pos?: [number, number, number], tgt?: [number, number, number], fov = this.fov) {
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
    } else if (this.mode !== 'story') {
      P.hot = 0.5;
      P.fog = FOG * 1.15;
      P.t = 1;
      P.exposure = 1;
      if (!reduced) this.cam.goal.yaw += dt * 0.03; // slow drift behind the hero and loading log
    } else {
      P.fog = FOG;
    }
    this.cam.update(dt, reduced);
    let pos: [number, number, number];
    let tgt: [number, number, number];
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
      if (this.mode === 'city') {
        P.t = 1;
        P.exposure = 1;
      }
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
    if (this.hoverAt && !this.pickBusy && this.mode === 'city') {
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
    this.adapt(rawMs);
  };
}
