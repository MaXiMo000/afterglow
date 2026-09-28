/**
 * App controller: hero -> loading (real SSE progress) -> story (A4) -> city with the explore tools (A5), plus the
 * 2D table fallback. The effects pass (A6) builds on this.
 */
import { ApiError, fetchPr, fetchPrevious, fetchResult, followProgress, startAnalysis, startPr, type Progress } from '../lib/api';
import { overlay } from '../lib/pr';
import { since } from '../lib/since';
import { drill, topPrefix } from '../lib/drill';
import { beforeWindow } from '../lib/history';
import { parseRepo, repoFromPath, repoPath, type RepoRef } from '../lib/repo';
import { validateResult, type Result } from '../lib/result';
import { decodeView, encodeView, type View } from '../lib/share';
import { clamp, lerp, smoothstep } from '../render/math';
import { DynRes } from '../render/dynres';
import { Renderer, RendererError, TIERS, type Params } from '../render/renderer';
import { buildWorld, type World } from '../world/build';
import { TYPE_COLOURS } from '../world/types';
import { weather } from '../world/weather';
import { buildCamera, OrbitCamera, orbitFromPose, rayThrough, type Preset } from './camera';
import { $, ago, el, fmt, fmtDate, reducedMotion, setText } from './dom';
import { actionFor, KEYMAP, type ActionId } from './keymap';
import { Palette, type Item } from './palette';
import { compareCounts, Inspector, Insights, MiniMap, renderHelp, Timeline, whatIfSentence } from './panels';
import { orphaned } from '../world/whatif';
import { Story } from './story';
import { NEAR, Walker } from './walk';
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
  git_failed: 'Git could not read this repository. Trying again sometimes helps; if not, it may be damaged or unusual.',
  unparseable: 'This repository\u2019s history has a shape we cannot read, so it cannot be drawn.',
  internal: 'Something failed on our side. Please try again in a minute.',
  failed: 'The analysis failed. Please try again in a minute.',
  too_many_streams: 'Too many open analyses in this browser. Close other Afterglow tabs and try again.',
  not_ready: 'The analysis is not finished yet. Please try again in a moment.',
};
const NO_RETRY = ['invalid_repo', 'not_found', 'empty_repo', 'no_files', 'too_large', 'unparseable'];
const IDLE_FRAME_MS = 1000 / 30; // nothing moving: ambient animation only, at half rate (PLAN section 6, Idle)
const ACTIVE_FOR_MS = 2000; // input keeps the full frame rate this long after it stops

/** "2 ahead in the queue, estimated wait about 3 min": the wait is the server's estimate from recent jobs. */
function queueText(p: Progress): string {
  const parts = p.ahead ? [`${fmt(p.ahead)} ahead in the queue`] : [];
  if (p.wait !== undefined) parts.push(`estimated wait ${p.wait < 60 ? 'under a minute' : `about ${fmt(Math.round(p.wait / 60))} min`}`);
  return parts.join(', ');
}

const dist = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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
    arcs: 1, lanterns: 1, cmp: [0, 0, 0], lift: 0, sel: -1, focusDist: 0, dof: 0, motion: 1, flow: 0, types: 0, weather: 0, risk: 0, pr: 0,
  }; // prettier-ignore
  private time = 0;
  private last = 0;
  private tierIdx = 2;
  private scale = 1; // dynamic resolution factor, 0.6..1
  private dyn = new DynRes(2);
  private lanterns: Float32Array | null = null;
  private selected = -1;
  private focusGoal = 0;
  private walker: Walker | null = null; // walk mode (docs/ROADMAP.md #3)
  private hintsText = '';
  private tour = -1; // position in insights.hotspots during a J/K tour
  private prOn = false; // an overlay (PR, or changes since the previous analysis) is shown
  private overlayKind: 'pr' | 'since' | null = null;
  private resultId: string | null = null; // job id of the loaded analysis (null for the demo)
  private prAbort: AbortController | null = null;
  private weatherGoal = 0; // weather layer: 1 on; P.weather eases toward it
  private typesGoal = 0; // colour by file type: 1 on; P.types eases toward it
  private ptrs = new Map<number, { x: number; y: number; t: number }>();
  private dragMoved = 0;
  private pinch = 0;
  private hoverAt: { x: number; y: number } | null = null;
  private pickBusy = false;
  private pickChain: Promise<unknown> = Promise.resolve(); // one GPU readback in flight at a time
  private abort: AbortController | null = null;
  private readonly story = new Story(() => this.enterCity());
  private lastVP: Float32Array | null = null;
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
  /** Video export in progress (docs/ROADMAP.md #4). */
  private rec: { kind: 'orbit' | 'history'; rec: MediaRecorder; out: HTMLCanvasElement; ctx: CanvasRenderingContext2D; t0: number; dur: number; left: number; keep: boolean } | null = null;
  private pendingView: View | null = null;
  /** Screen to restore without a new history entry (reload, or Back/Forward onto another repository's entry). */
  private arrive: 'story' | 'city' | null = null;
  private prevT = 1;
  private loadFrac = 0; // real analysis progress 0..1, drives the city un-building during loading (A6)
  private lastRepo = '';
  private lastInput = -Infinity; // performance.now() of the latest pointer, wheel, key or scroll input
  private wasIdle = false;
  private hotDirs: ReadonlySet<number> = new Set();
  private readonly held = new Set<string>();
  private readonly palette = new Palette();
  private readonly inspector = new Inspector(
    (i) => this.select(i),
    (d) => this.drillInto(d),
  );
  /** Drill-down (docs/ROADMAP.md #9): the parent cities, outermost first, and the current city's district prefixes. */
  private drillStack: { result: Result; prefixes: string[] | null; from: number }[] = [];
  private prefixes: string[] | null = null;
  private readonly insights = new Insights(
    (i) => this.select(i, true),
    (d) => this.flyToDistrict(d),
    (p) => this.setWhatIf(p),
  );
  private readonly minimap = new MiniMap((x, z) => {
    if (!this.walker) return this.cam.flyTo({ ...this.cam.goal, x, z }, 0.8, reducedMotion());
    this.walker.x = x; // walking: the map is a teleport
    this.walker.z = z;
    this.walker.resolve(this.P.t);
  });
  private readonly timeline = new Timeline((t) => this.scrub(t));
  private readonly canvas = $('#gl') as HTMLCanvasElement;
  private readonly body = document.body;

  start(): void {
    this.tierIdx = this.autoTier();
    // ?quality=simple|balanced|cinematic pins a tier (testing); otherwise the Graphics setting in the help panel.
    const q = new URLSearchParams(location.search).get('quality') ?? this.savedQuality();
    const pinned = TIERS.findIndex((t) => t.name === q);
    if (pinned >= 0) this.tierIdx = pinned;
    this.dyn.tier = this.tierIdx;
    const sel = $('#quality') as HTMLSelectElement;
    sel.value = pinned >= 0 ? TIERS[pinned]!.name : 'auto';
    sel.addEventListener('change', () => this.setQuality(sel.value));
    try {
      this.renderer = new Renderer(this.canvas);
    } catch {
      this.renderer = null; // no WebGL2: the table is the whole UI
    }
    renderHelp($('#help .help-body'));
    $('#btnHelpClose').addEventListener('click', () => ($('#help') as HTMLDialogElement).close());
    this.palette.setSource(() => this.paletteItems());
    this.bindUi();
    this.bindCanvas();
    addEventListener('resize', () => (this.dyn.hold(), this.resize(true)));
    // Stack the city's bottom UI on the measured data line and timeline heights (they wrap differently per width).
    const root = document.documentElement.style;
    new ResizeObserver(() => {
      root.setProperty('--foot-h', `${$('#honesty').offsetHeight}px`);
      root.setProperty('--tl-h', `${this.timeline.root.offsetHeight}px`);
    }).observe($('#honesty'));
    new ResizeObserver(() => root.setProperty('--tl-h', `${this.timeline.root.offsetHeight}px`)).observe(this.timeline.root);
    const poke = (): void => void (this.lastInput = performance.now());
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'scroll', 'touchmove']) {
      addEventListener(type, poke, { capture: true, passive: true });
    }
    this.canvas.addEventListener('webglcontextlost', () => this.fallback('The 3D view stopped (graphics context lost).'));
    const shared = decodeView(location.hash);
    const linked = repoFromPath(location.pathname);
    const st = (history.state as { v?: string } | null)?.v;
    if (st === 'story' || st === 'city') this.arrive = st; // a reload: show that screen again, don't add an entry
    if (shared) {
      // A share link names a repo: analyse it (rate-limited like any request) and restore the view afterwards.
      this.pendingView = shared;
      history.replaceState(history.state, '', `${repoPath(shared.repo)}${location.search}${location.hash}`);
      void this.analyse(`${shared.repo.owner}/${shared.repo.name}`);
    } else if (linked) {
      void this.analyse(`${linked.owner}/${linked.name}`); // a clean link (/owner/name) opens the story directly
    } else {
      if (location.pathname !== '/') history.replaceState(history.state, '', `/${location.search}${location.hash}`);
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

  private show(r: Result, drilling = false): void {
    if (!drilling) {
      this.drillStack = [];
      this.prefixes = null;
    }
    this.dyn.hold(); // building the world and first frames are slow: not a reason to lower quality
    this.result = r;
    this.resultId = null;
    this.world = buildWorld(r);
    this.hotDirs = new Set(r.insights.hotspots.map((i) => r.files[i]!.dir));
    this.lanterns = new Float32Array(this.world.lanterns.length * 3);
    this.cam.frame(this.world.radius);
    this.cam.snap();
    this.selected = -1;
    this.tour = -1;
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
    if (this.typesGoal) this.setTypes(true, false);
    if (this.weatherGoal) this.setWeather(true, false);
    this.setWhatIf(-1, false); // a new world starts with every light on
    this.clearPr(false); // keep the mode across repositories; its legend is per result
    if (!this.demo) {
      setText($('#hudRepo'), r.meta.repo);
      $('#hudRepo').title = r.meta.repo; // full name on hover when the slot truncates it
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
    this.dyn.hold();
    this.mode = m;
    this.body.classList.remove('mode-hero', 'mode-loading', 'mode-story', 'mode-city');
    this.body.classList.add(`mode-${m}`);
    if (m !== 'city') this.setWalk(false, true);
    if (m !== 'city') this.stopRecording(false);
    $('#hero').hidden = m !== 'hero';
    $('#loading').hidden = m !== 'loading';
    $('#city').hidden = m !== 'city';
    $('#btnNew').hidden = m === 'hero';
    $('#btnCity').hidden = m !== 'story';
    const explore = m === 'city' && !this.demo;
    $('#btnStory').hidden = !explore || !this.renderer;
    for (const id of ['#btnSearch', '#btnInsights', '#btnShare', '#btnBadge', '#btnPhoto', '#btnHelp']) $(id).hidden = !explore;
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
  private enterStory(fromCity = false, push = true): void {
    if (!this.result || !this.world || this.demo) return;
    if (fromCity) this.startBlend();
    // Browser history mirrors the screens (start page -> story -> city), so Back steps out one level.
    const deep = /^#chapter-[1-9]$/.test(location.hash) ? location.hash : '#chapter-1'; // keep a deep link
    if (push && !fromCity) history.pushState({ v: 'story', back: true }, '', this.here(deep));
    else if (!push) history.replaceState(history.state, '', this.here(fromCity ? '' : deep)); // path follows the repo
    this.setMode('story');
    this.story.enter(this.result, this.world);
  }

  /** Hand over to the orbit camera exactly where the story camera is, so nothing pops. */
  private enterCity(push = true): void {
    const { pos, tgt } = this.currentPose();
    this.cam.goal = orbitFromPose(pos, tgt);
    this.cam.snap();
    this.fov = 50;
    this.tT = this.P.t = 1;
    // From the story's close-up, glide out to the whole city (arriving from chapter 1 used to stay on one island).
    if (this.world) this.cam.flyTo(this.cam.home(this.world.radius), 1.2, reducedMotion());
    this.setMode('city');
    if (push) history.pushState({ v: 'city', back: true }, '', this.here('#explore'));
    else history.replaceState({ ...history.state, v: 'city' }, '', this.here('#explore'));
  }

  /** Cinematic on desktops, balanced on phones and low-core machines; dynamic resolution and tier steps handle the rest. */
  private autoTier(): number {
    const low = matchMedia('(pointer: coarse)').matches || innerWidth < 760 || (navigator.hardwareConcurrency || 8) <= 4;
    return low ? 1 : 2;
  }

  private savedQuality(): string | null {
    try {
      return localStorage.getItem('afterglow:quality'); // UI preference only (SECURITY T20 allows UI prefs)
    } catch {
      return null;
    }
  }

  private setQuality(v: string): void {
    const i = TIERS.findIndex((t) => t.name === v);
    try {
      if (i >= 0) localStorage.setItem('afterglow:quality', v);
      else localStorage.removeItem('afterglow:quality');
    } catch {
      /* storage blocked: applies to this visit only */
    }
    this.tierIdx = this.dyn.tier = i >= 0 ? i : this.autoTier();
    this.scale = this.dyn.scale = 1;
    this.dyn.hold();
    this.resize(true);
    this.toast(`Graphics: ${i >= 0 ? (['Fast', 'Balanced', 'Cinematic'][i] ?? v) : 'Auto'}`);
  }

  /** URL for the loaded repository's screens: its clean path (N1), or the start page for the demo. */
  private here(hash = ''): string {
    const repo = this.result && !this.demo ? parseRepo(this.result.meta.repo) : null;
    return `${repo ? repoPath(repo) : '/'}${location.search}${hash}`;
  }

  /** One level back (city -> story -> start page): through browser history when we added the entry. */
  private back(): void {
    while (this.drillStack.length) this.drillOut(true); // the story and start page belong to the whole city
    if (history.state?.back) return history.back(); // popstate applies the screen
    if (this.mode === 'city' && this.result && !this.demo && this.renderer) {
      this.enterStory(true, false);
      history.replaceState({ v: 'story' }, '', this.here());
    } else if (this.mode !== 'hero') this.goHome(false);
  }

  private goHome(push = true): void {
    this.abort?.abort();
    this.arrive = null;
    this.openTable(false);
    this.setMode('hero');
    // Screen hashes (#chapter-N, #explore) would make the next repository skip to that screen: drop them here.
    // Others stay: the skip link's #summary also arrives here (as a popstate) and must keep its target.
    const keep = /^#(chapter-[1-9]|explore)$/.test(location.hash) ? '' : location.hash;
    if (push) history.pushState({ v: 'hero' }, '', `/${location.search}`);
    else if (location.pathname !== '/' || !keep) history.replaceState(history.state, '', `/${location.search}${keep}`);
    ($('#repoInput') as HTMLInputElement).focus();
  }

  /** Browser Back/Forward: show the screen the history entry names, without adding entries. */
  private onPop(state: { v?: string } | null): void {
    const v = state?.v ?? 'hero';
    if (v !== 'city') while (this.drillStack.length) this.drillOut(true); // story and start page show the whole city
    const loaded = !!this.result && !this.demo;
    const linked = repoFromPath(location.pathname);
    if ((v === 'story' || v === 'city') && linked && (!loaded || `${linked.owner}/${linked.name}`.toLowerCase() !== this.result!.meta.repo)) {
      // This entry belongs to another repository than the one on screen (New repo, then Back): load that one.
      this.arrive = v;
      void this.analyse(`${linked.owner}/${linked.name}`);
      return;
    }
    if (v === 'city' && loaded) this.enterCity(false);
    else if (v === 'story' && loaded) this.enterStory(this.mode === 'city', false);
    else this.goHome(false);
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
    $('#btnCancel').hidden = false;
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
            let text = STAGE_TEXT[p.stage] ?? p.stage;
            if (p.stage === 'parsing' && p.total) text = `${text}: ${fmt(p.n)} of ${fmt(p.total)} commits`;
            else if (p.stage === 'queued' && (p.ahead || p.wait !== undefined)) text = `${text} (${queueText(p)})`;
            if (p.stage !== lastStage) {
              lastStage = p.stage;
              line(text);
            } else {
              setText(log.lastElementChild as HTMLElement, text);
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
      this.resultId = id;
      this.announce(`Loaded ${r.meta.repo}: ${fmt(r.meta.files)} files.`);
      const view = this.pendingView;
      this.pendingView = null;
      if (!this.renderer) {
        this.setMode('city');
        this.openTable(true);
      } else if (view || location.hash === '#explore' || this.arrive === 'city') {
        this.cam.frame(this.world!.radius);
        if (view?.cam) this.cam.goal = { ...view.cam, y: 4 };
        this.cam.snap();
        if (view?.t !== null && view?.t !== undefined) this.tT = this.P.t = view.t;
        this.setMode('city');
        if (!view) history.replaceState({ ...history.state, v: 'city' }, '', this.here('#explore'));
      } else {
        this.enterStory(false, this.arrive !== 'story');
      }
      this.arrive = null;
    } catch (e) {
      if (abort.signal.aborted) return;
      const code = e instanceof ApiError ? e.code : 'unavailable';
      const offline = !navigator.onLine;
      const text = offline ? 'You appear to be offline. Check your connection and try again.' : (ERROR_TEXT[code] ?? 'Something went wrong. Please try again.');
      line(text, 'fail');
      this.announce(text);
      // Empty/error state (A6): always offer a way forward, never a dead end.
      const retry = !NO_RETRY.includes(code) || offline;
      $('#btnRetry').hidden = !retry;
      $('#loadActions').hidden = false;
      $('#btnCancel').hidden = true; // nothing left to cancel; Back covers it
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
    // Camera flights take over from walking.
    if (this.walker && /^(home|reset|frame|preset\d)$/.test(id)) this.setWalk(false);
    switch (id) {
      case 'record':
        this.startRecording(this.playing ? 'history' : 'orbit');
        break;
      case 'walk':
        this.setWalk(!this.walker);
        break;
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
      case 'tourNext':
      case 'tourPrev':
        this.tourStep(id === 'tourNext' ? 1 : -1);
        break;
      case 'pr': {
        const d = $('#prDialog') as HTMLDialogElement;
        ($('#prInput') as HTMLInputElement).value = '';
        d.showModal();
        break;
      }
      case 'drill': {
        const d = this.selected >= 0 ? r.files[this.selected]!.dir : this.P.focus;
        if (d >= 0) this.drillInto(d);
        else this.toast('Select a building or a district first, then Enter opens its district as a city.');
        break;
      }
      case 'since':
        void this.showSince();
        break;
      case 'weather':
        this.setWeather(!this.weatherGoal);
        break;
      case 'types':
        this.setTypes(!this.typesGoal);
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
        this.back();
        break;
    }
  }

  private scrub(t: number): void {
    this.tT = t;
    this.playing = false;
    if (reducedMotion()) this.P.t = t;
  }

  /**
   * Walk mode (docs/ROADMAP.md #3): drop to street level where the orbit camera is looking, facing the same way.
   * Leaving puts the orbit camera over the spot you walked to. `quiet` skips the camera hand-over (mode changes).
   */
  private setWalk(on: boolean, quiet = false): void {
    const w = this.world;
    const from = this.lastPose;
    if (on) {
      if (!w || this.mode !== 'city' || this.walker) return;
      const f = from ? [from.tgt[0] - from.pos[0], from.tgt[2] - from.pos[2]] : [0, -1];
      const len = Math.hypot(f[0]!, f[1]!) || 1;
      // Land on the first open ground back along the view line (districts are packed tight), facing what the
      // orbit camera was looking at: the first view is that skyline, not a wall.
      const g = this.cam.goal;
      const k = new Walker(w, g.x, g.z, Math.atan2(-f[0]!, -f[1]!));
      for (let back = 0; back <= w.radius * 1.3; back += 1) {
        k.x = g.x - (f[0]! / len) * back;
        k.z = g.z - (f[1]! / len) * back;
        if (k.clearance(k.x, k.z, this.P.t) >= 2.5) break;
      }
      this.walker = k;
      this.walker.resolve(this.P.t);
      this.cam.autoOrbit = false;
      this.body.classList.add('walking');
      this.hintsText ||= $('#hints').textContent ?? '';
      setText($('#hints'), 'W A S D walk \u00b7 Shift run \u00b7 mouse or arrows look \u00b7 click to capture the mouse \u00b7 X to leave');
      this.announce('Walk mode. W A S D to walk, Shift to run, arrow keys or the mouse to look, X or Escape to leave.');
    } else {
      const k = this.walker;
      if (!k) return;
      this.walker = null;
      if (document.pointerLockElement) document.exitPointerLock();
      this.body.classList.remove('walking');
      setText($('#hints'), this.hintsText);
      if (quiet) return;
      this.cam.flyTo({ yaw: k.yaw, pitch: 0.5, dist: 34, x: k.x, y: 4, z: k.z }, 0.01, true);
      this.announce('Left walk mode');
    }
    if (from && !quiet) this.blend = { pos: [...from.pos], tgt: [...from.tgt], fov: this.fov, k: 0 };
  }

  /** Hotspot tour (docs/ROADMAP.md #2): fly to the next/previous hotspot, in the insights list order, and say why. */
  private tourStep(dir: 1 | -1): void {
    const r = this.result;
    const list = r?.insights.hotspots ?? [];
    if (!r || !list.length) {
      this.toast('No hotspots in this repository: nothing changed often, by few people, in the last 12 months.');
      return;
    }
    const at = list.indexOf(this.selected); // continue from a hotspot picked by hand
    const from = at >= 0 ? at : this.tour;
    this.tour = from < 0 ? (dir > 0 ? 0 : list.length - 1) : (from + dir + list.length) % list.length;
    const i = list[this.tour]!;
    const f = r.files[i]!;
    this.select(i, true);
    const name = f.path.slice(f.path.lastIndexOf('/') + 1);
    const why = `${fmt(f.changes_12m)} changes in the last 12 months`;
    setText($('#placeEy'), `Hotspot ${this.tour + 1} of ${list.length}`);
    setText($('#placeName'), name);
    setText($('#placeSub'), `${r.dirs[f.dir]?.name ?? ''} · ${why} · J next, K previous`);
    this.announce(`Hotspot ${this.tour + 1} of ${list.length}: ${f.path}, ${why}.`);
  }

  /** PR overlay (docs/ROADMAP.md #7): queue it like an analysis, then light up the buildings it touches. */
  private async showPr(n: number): Promise<void> {
    const r = this.result;
    if (!r || this.demo || n > 10_000_000) return;
    this.clearPr(false);
    const abort = new AbortController();
    this.prAbort = abort;
    const say = (t: string): void => {
      this.toast(t);
      this.announce(t);
    };
    say(`Fetching the files PR #${n} changes from GitHub\u2026`);
    try {
      const { id, done } = await startPr(r.meta.repo, n);
      if (!done) await followProgress(id, (p) => p.status === 'queued' && p.ahead ? this.toast(`PR #${n}: ${fmt(p.ahead)} ahead in the queue`) : undefined, abort.signal);
      const p = await fetchPr(id);
      if (abort.signal.aborted || this.result !== r || p.repo !== r.meta.repo) return;
      const o = overlay(r, p);
      this.renderer?.setPr(o.marks);
      this.prOn = true;
      this.overlayKind = 'pr';
      const row = (cls: string, t: string): HTMLElement => {
        const d = el('div');
        const i = el('i', null, cls);
        i.setAttribute('aria-hidden', 'true');
        d.append(i, document.createTextNode(t));
        return d;
      };
      const extra = [
        o.fresh ? `${fmt(o.fresh)} new ${o.fresh === 1 ? 'file' : 'files'} (not in the city yet)` : '',
        o.unseen ? `${fmt(o.unseen)} changed ${o.unseen === 1 ? 'file is' : 'files are'} not drawn (beyond the file cap, or newer than this analysis)` : '',
        p.truncated ? `Only the first ${fmt(p.changes.length)} changed paths were read` : '',
      ].filter(Boolean);
      $('#prLegend').replaceChildren(
        el('strong', `PR #${n}`),
        row('pr-ch', `Changed: ${fmt(o.changed)} ${o.changed === 1 ? 'building' : 'buildings'}`),
        row('pr-go', `Deleted or moved away: ${fmt(o.gone)}`),
        ...extra.map((t) => el('p', t)),
        el('p', `GitHub's test merge ${p.merge.slice(0, 7)} against its base ${p.base.slice(0, 7)}; the city is at ${r.meta.sha.slice(0, 7)}. File names only. Esc to clear.`, 'sub'),
      );
      $('#prLegend').hidden = false;
      this.prAbort = null;
      say(`PR #${n}: ${fmt(o.changed)} changed, ${fmt(o.gone)} deleted or moved away${o.fresh ? `, ${fmt(o.fresh)} new` : ''}.`);
    } catch (e) {
      if (abort.signal.aborted) return;
      this.prAbort = null;
      const code = e instanceof ApiError ? e.code : 'unavailable';
      say(code === 'pr_not_found'
        ? `GitHub has no test merge for PR #${n}: it may be closed, merged, have conflicts, or not exist. Only open, mergeable PRs can be shown.`
        : (ERROR_TEXT[code] ?? 'The PR could not be loaded. Please try again.'));
    }
  }

  /** Start-page gallery (docs/ROADMAP.md #10): skyline tiles from the badge route, each opening that city. */
  private async loadFeatured(): Promise<void> {
    let repos: unknown;
    try {
      const res = await fetch('/api/v1/featured', { credentials: 'omit' });
      if (!res.ok) return;
      repos = ((await res.json()) as { repos?: unknown }).repos;
    } catch {
      return; // no gallery: the start page works the same without it
    }
    if (!Array.isArray(repos)) return;
    const tiles = repos.slice(0, 12).flatMap((raw) => {
      const ref = typeof raw === 'string' ? parseRepo(raw) : null; // same strict parser as the form
      if (!ref) return [];
      const slug = `${ref.owner}/${ref.name}`.toLowerCase();
      const a = el('a');
      a.href = `/${slug}`; // validated owner/name only (SECURITY T5)
      a.setAttribute('aria-label', `Open the city of ${slug}`);
      const img = el('img');
      img.src = `/api/v1/badges/${slug}.svg`;
      img.alt = '';
      img.width = 176;
      img.height = 53;
      img.loading = 'lazy';
      img.decoding = 'async';
      a.append(img);
      a.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab/window: the link works as is
        e.preventDefault();
        ($('#repoInput') as HTMLInputElement).value = slug;
        void this.analyse(slug);
      });
      return [a];
    });
    if (!tiles.length) return;
    $('#featured .strip').replaceChildren(...tiles);
    $('#featured').hidden = false;
  }

  /** "core / api" for the current drilled-in city. */
  private drillPath(): string {
    const top = this.drillStack[0];
    const names = this.drillStack.map((s, k) => (k === 0 ? topPrefix(s.result.dirs[s.from]!.name) || '(root)' : s.result.dirs[s.from]!.name));
    return top ? names.join(' / ') : '';
  }

  /** District caption: files, bus factor (only known for top-level districts), quiet. */
  private districtLine(x: { files: number; bus_factor: number; quiet: boolean }): string {
    const bus = this.drillStack.length ? 'bus factor: per top-level district only' : `bus factor ${fmt(x.bus_factor)}`;
    return `${fmt(x.files)} files \u00b7 ${bus}${x.quiet ? ' \u00b7 quiet' : ''}`;
  }

  /** Open district `d` of the current city as a city of its own (docs/ROADMAP.md #9). */
  private drillInto(d: number): void {
    const r = this.result;
    if (!r || this.demo || this.mode !== 'city' || !r.dirs[d]) return;
    const prefix = this.prefixes ? this.prefixes[d]! : topPrefix(r.dirs[d].name);
    const next = drill(r, d, prefix);
    if (next.result.dirs.length < 2 && next.result.files.length < 2) return this.toast('This district has a single file: nothing to open.');
    if (this.walker) this.setWalk(false, true);
    const from = this.lastPose;
    const id = this.resultId;
    this.drillStack.push({ result: r, prefixes: this.prefixes, from: d });
    this.prefixes = next.prefixes;
    this.show(next.result, true);
    this.resultId = id;
    if (from) this.blend = { pos: [...from.pos], tgt: [...from.tgt], fov: this.fov, k: 0 };
    this.select(-1);
    this.announce(`Inside ${this.drillPath()}: ${fmt(next.result.files.length)} files in ${fmt(next.result.dirs.length)} folders. Backspace climbs out.`);
  }

  /** Back to the parent city; `quiet` skips the transition and announcement (leaving the city altogether). */
  private drillOut(quiet = false): void {
    const top = this.drillStack.pop();
    if (!top) return;
    const from = this.lastPose;
    const id = this.resultId;
    this.prefixes = top.prefixes;
    this.show(top.result, true);
    this.resultId = id;
    if (quiet) return;
    if (from) this.blend = { pos: [...from.pos], tgt: [...from.tgt], fov: this.fov, k: 0 };
    this.flyToDistrict(top.from);
    this.announce(this.drillStack.length ? `Back in ${this.drillPath()}.` : 'Back in the whole city.');
  }

  /** What changed since the previous stored analysis (docs/ROADMAP.md #8). 6 again turns it off. */
  private async showSince(): Promise<void> {
    const r = this.result;
    const id = this.resultId;
    if (!r || this.demo) return;
    if (this.overlayKind === 'since') return this.clearPr(true);
    if (this.drillStack.length) return this.toast('Climb out to the whole city (Backspace) to compare with the previous analysis.');
    if (!id) return this.toast('Load a repository first.');
    this.clearPr(false);
    const abort = new AbortController();
    this.prAbort = abort;
    try {
      const prev = await fetchPrevious(id);
      if (abort.signal.aborted || this.result !== r) return;
      this.prAbort = null;
      if (!prev) {
        const t = 'No earlier analysis of this repository is stored here yet (analyses are kept about 30 days).';
        this.toast(t);
        this.announce(t);
        return;
      }
      const s = since(r, prev);
      this.renderer?.setPr(s.marks);
      this.prOn = true;
      this.overlayKind = 'since';
      const row = (cls: string, t: string): HTMLElement => {
        const d = el('div');
        const i = el('i', null, cls);
        i.setAttribute('aria-hidden', 'true');
        d.append(i, document.createTextNode(t));
        return d;
      };
      const when = fmtDate(prev.meta.generated_at);
      $('#prLegend').replaceChildren(
        el('strong', `Since ${when}`),
        row('pr-new', `New since then: ${fmt(s.fresh)} ${s.fresh === 1 ? 'file' : 'files'}`),
        row('pr-ch', `Changed again: ${fmt(s.again)} ${s.again === 1 ? 'file' : 'files'} (${fmt(s.changes)} changes)`),
        ...(s.removed ? [el('p', `${fmt(s.removed)} ${s.removed === 1 ? 'file' : 'files'} removed since then (not drawn: not in today's city)`)] : []),
        ...(s.partial ? [el('p', 'One of the analyses is truncated, so this covers only the files and history both contain.')] : []),
        el('p', `Compared with this site's analysis of ${when} (${prev.meta.sha.slice(0, 7)}); now at ${r.meta.sha.slice(0, 7)}. Esc or 6 to clear.`, 'sub'),
      );
      $('#prLegend').hidden = false;
      this.announce(`Since ${when}: ${fmt(s.fresh)} new, ${fmt(s.again)} changed again, ${fmt(s.removed)} removed.`);
    } catch (e) {
      if (abort.signal.aborted) return;
      this.prAbort = null;
      const code = e instanceof ApiError ? e.code : 'unavailable';
      this.toast(ERROR_TEXT[code] ?? 'The previous analysis could not be loaded. Please try again.');
    }
  }

  private clearPr(announce: boolean): void {
    this.prAbort?.abort();
    this.prAbort = null;
    if (!this.prOn && !announce) return;
    this.prOn = false;
    this.overlayKind = null;
    $('#prLegend').hidden = true;
    if (announce) this.announce('Overlay cleared.');
  }

  /** Bus-factor what-if (docs/ROADMAP.md #6): lights go out in the districts nobody else knows. -1 clears it. */
  private setWhatIf(person: number, announce = true): void {
    const r = this.result;
    const box = $('#riskLegend');
    this.insights.whatIf = r && person >= 0 && person < r.people.length ? person : -1;
    if (this.insights.open && r) this.insights.toggle(r, true); // re-render the bus tab
    if (this.insights.whatIf < 0 || !r) {
      box.hidden = true;
      if (announce) this.announce('What if cleared: all lights on.');
      return;
    }
    this.renderer?.setRisk(new Set(orphaned(r, this.insights.whatIf)));
    const text = whatIfSentence(r, this.insights.whatIf);
    const row = el('div');
    const i = el('i', null, 'risk');
    i.setAttribute('aria-hidden', 'true');
    row.append(i, document.createTextNode('Lights out: no one else has 10%+ of the commits'));
    box.replaceChildren(el('strong', `What if ${r.people[this.insights.whatIf]!.handle} left?`), el('p', text), row, el('p', 'Commit share in the analysed history, not ownership. Esc to clear.', 'sub'));
    box.hidden = false;
    if (announce) this.announce(text);
  }

  /** Weather (docs/ROADMAP.md #5): decorative, but only where the data says, and the legend says what it means. */
  private setWeather(on: boolean, announce = true): void {
    const box = $('#weatherLegend');
    const r = this.result;
    if (on && this.renderer?.tierName === 'simple') {
      this.toast('Weather needs the Balanced or Cinematic graphics setting (? to change it).');
      on = false;
    }
    this.weatherGoal = on && r ? 1 : 0;
    if (!this.weatherGoal || !r) {
      box.hidden = true;
      if (announce) this.announce('Weather off');
      return;
    }
    const w = weather(r);
    const row = (cls: string, text: string): HTMLElement => {
      const p = el('div');
      const i = el('i', null, cls);
      i.setAttribute('aria-hidden', 'true');
      p.append(i, document.createTextNode(text));
      return p;
    };
    const rain = w.rain.length ? `Rain: the ${fmt(w.rain.length)} busiest ${w.rain.length === 1 ? 'district' : 'districts'} by changes in the last 12 months` : 'No rain: no district changed in the last 12 months';
    const fog = w.fog.length ? `Fog: ${fmt(w.fog.length)} quiet ${w.fog.length === 1 ? 'district' : 'districts'} (no change in 2 years)` : 'No fog: no quiet districts';
    box.replaceChildren(el('strong', 'Weather'), row('rain', rain), row('fog', fog), el('p', 'Decoration tied to those numbers, nothing more. Z to turn off.', 'sub'));
    box.hidden = false;
    if (announce) this.announce(`Weather on. ${rain}. ${fog}.`);
  }

  /** Colour by file type (docs/ROADMAP.md #1). Compare mode also recolours buildings, so the two never overlap. */
  private setTypes(on: boolean, announce = true): void {
    const box = $('#typeLegend');
    const w = this.world;
    this.typesGoal = on && w ? 1 : 0;
    if (!this.typesGoal || !w) {
      box.hidden = true;
      if (announce) this.announce('Colour by file type off');
      return;
    }
    if (this.compare) this.setCompare(null);
    const t = w.types;
    const rows = t.labels
      .map((label, i) => ({ label, i, n: t.counts[i]! }))
      .filter((x) => x.n > 0)
      .map(({ label, i, n }) => {
        const p = el('div');
        const sw = el('i');
        sw.setAttribute('aria-hidden', 'true');
        sw.style.background = sw.style.color = TYPE_COLOURS[i]!; // CSSOM, allowed by the CSP (color feeds the glow)
        p.append(sw, el('span', label, 'ext'), el('span', fmt(n), 'num'));
        return p;
      });
    box.replaceChildren(el('strong', 'Colour by file type'), ...rows, el('p', 'By file extension, not language detection. Y to turn off.', 'sub'));
    box.hidden = false;
    if (announce) {
      const top = t.labels.slice(0, 3).filter((l, i) => l && t.counts[i]).map((l, i) => `${l} ${fmt(t.counts[i]!)}`);
      this.announce(`Colour by file type on. Most common: ${top.join(', ')}.`);
    }
  }

  private setCompare(c: { a: number; b: number } | null): void {
    this.compare = c;
    if (c && this.typesGoal) this.setTypes(false, false);
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
      ...(n.removed === null ? [] : [row('c-removed', 'Removed in this window', n.removed.n)]),
      el(
        'p',
        `${n.removed === null ? 'Deleted files are not in this analysis, so removals are not shown.' : `Removed files are counted${n.removed.exact ? '' : ' by whole month (this far back only monthly totals are kept)'}, not drawn: they have no place in the city at HEAD.`} Use , and . to move the window end, [ ] for speed.`,
        'sub',
      ),
    );
    box.hidden = false;
  }

  private async share(): Promise<void> {
    const r = this.result;
    const repo = r ? parseRepo(r.meta.repo) : null;
    if (!repo) return;
    if (this.drillStack.length) {
      // A drilled-in camera means nothing in the whole city a link opens: share the repository itself.
      const plain = `${location.origin}${repoPath(repo)}`;
      try {
        await navigator.clipboard.writeText(plain);
        this.toast('Link copied (it opens the whole city)');
      } catch {
        this.toast(plain);
      }
      return;
    }
    const g = this.cam.goal;
    const hash = encodeView({ repo: repo as RepoRef, cam: { yaw: g.yaw, pitch: g.pitch, dist: g.dist, x: g.x, z: g.z }, t: this.tT });
    const url = `${location.origin}${repoPath(repo)}${hash}`;
    history.replaceState(history.state, '', `${repoPath(repo)}${location.search}${hash}`);
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Link to this view copied');
    } catch {
      this.toast('Link is in the address bar (clipboard unavailable)');
    }
  }

  /** README Markdown for the badge image (drawn by the server from the stored analysis), linking to this city. */
  private async copyBadge(): Promise<void> {
    const repo = this.result?.meta.repo; // validated `owner/name`, lower-case
    if (!repo || !/^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/.test(repo)) return;
    const md = `[![Afterglow city of ${repo}](${location.origin}/api/v1/badges/${repo}.svg)](${location.origin}/${repo})`;
    try {
      await navigator.clipboard.writeText(md);
      this.toast('Badge Markdown copied: paste it into a README');
    } catch {
      this.toast('Clipboard unavailable');
    }
  }

  /** Iframe snippet for the embeddable city (docs/ROADMAP.md #12): read-only, newest stored analysis. */
  private async copyEmbed(): Promise<void> {
    const repo = this.result?.meta.repo; // validated `owner/name`, lower-case
    if (!repo || this.demo || !/^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/.test(repo)) return this.toast('Load a repository first.');
    const html = `<iframe src="${location.origin}/embed/${repo}" title="Afterglow city of ${repo}" width="720" height="405" loading="lazy" style="border:0;border-radius:8px"></iframe>`;
    try {
      await navigator.clipboard.writeText(html);
      this.toast('Embed code copied: paste it into your site or blog (HTML)');
    } catch {
      this.toast('Clipboard unavailable');
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
    this.caption(ctx, w, h);
    out.toBlob((blob) => {
      if (!blob) return;
      this.download(blob, 'png');
      this.toast('PNG saved');
    }, 'image/png');
  }

  private download(blob: Blob, ext: string): void {
    const r = this.result;
    if (!r) return;
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `afterglow-${r.meta.repo.replace('/', '-')}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** Caption band for posters and videos: repo, commit, the date shown, and the data caveats (CLAUDE.md rule 6). */
  private caption(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const r = this.result;
    if (!r) return;
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
  }

  /**
   * Record a WebM (docs/ROADMAP.md #4): a quarter orbit in 12 s, or the whole history in 20 s. Each rendered frame is
   * copied with the caption onto a 2D canvas (<= 1280 px wide) that MediaRecorder captures; nothing leaves the browser.
   */
  private startRecording(kind: 'orbit' | 'history'): void {
    if (!this.result || this.rec || this.mode !== 'city' || !this.renderer) return;
    const out = document.createElement('canvas');
    const mime = typeof MediaRecorder === 'undefined' || typeof out.captureStream !== 'function'
      ? undefined
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      this.toast('This browser cannot record video. Save PNG in photo mode still works.');
      return;
    }
    const s = Math.min(1, 1280 / this.canvas.width);
    out.width = Math.round((this.canvas.width * s) / 2) * 2; // even sizes: some encoders require them
    out.height = Math.round((this.canvas.height * s) / 2) * 2;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    const rec = new MediaRecorder(out.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => void (e.data.size && chunks.push(e.data));
    const state = { kind, rec, out, ctx, t0: performance.now(), dur: kind === 'orbit' ? 12 : 20, left: -1, keep: false };
    rec.onstop = () => {
      if (state.keep && chunks.length) {
        this.download(new Blob(chunks, { type: 'video/webm' }), 'webm');
        this.toast('Video saved');
        this.announce('Video saved.');
      }
    };
    if (this.walker && kind === 'orbit') this.setWalk(false);
    this.cam.autoOrbit = false;
    if (kind === 'history') {
      this.tT = this.P.t = 0;
      this.playing = false;
    }
    rec.start(1000);
    this.rec = state;
    this.body.classList.add('recording');
    this.announce(`Recording a ${state.dur} second ${kind === 'orbit' ? 'orbit' : 'history'} video. Escape to cancel.`);
  }

  /** Finish (`keep`: download) or cancel the recording. */
  private stopRecording(keep: boolean): void {
    const s = this.rec;
    if (!s) return;
    this.rec = null;
    s.keep = keep;
    if (s.rec.state !== 'inactive') s.rec.stop();
    this.body.classList.remove('recording');
    this.cam.autoOrbit = this.photo; // photo mode's slow orbit resumes
    if (!keep) {
      this.toast('Recording cancelled');
      this.announce('Recording cancelled.');
    }
  }

  private paletteItems(): Item[] {
    const r = this.result;
    if (!r || this.demo) return [];
    const items: Item[] = KEYMAP.map((k) => ({ kind: 'action', label: k.label, hint: k.keys.join(' or '), key: `a:${k.id}`, run: () => this.run(k.id) }));
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
    setText($('#placeSub'), this.districtLine(x));
    this.announce(`District ${x.name}: ${fmt(x.files)} files.`);
  }

  // ---------- input ----------
  private bindUi(): void {
    $('#form').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.analyse(($('#repoInput') as HTMLInputElement).value);
    });
    void this.loadFeatured();
    for (const b of document.querySelectorAll<HTMLButtonElement>('.samples button')) {
      b.addEventListener('click', () => {
        ($('#repoInput') as HTMLInputElement).value = b.dataset['repo'] ?? '';
        void this.analyse(b.dataset['repo'] ?? '');
      });
    }
    $('#btnCity').addEventListener('click', () => this.enterCity());
    $('#btnStory').addEventListener('click', () => this.back());
    $('#btnSearch').addEventListener('click', () => this.run('palette'));
    $('#btnInsights').addEventListener('click', () => this.run('insights'));
    $('#btnPhoto').addEventListener('click', () => this.run('photo'));
    $('#btnHelp').addEventListener('click', () => this.run('help'));
    $('#btnSave').addEventListener('click', () => (this.exportNext = true));
    $('#btnRecOrbit').addEventListener('click', () => this.startRecording('orbit'));
    $('#btnRecHistory').addEventListener('click', () => this.startRecording('history'));
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
    $('#btnRetry').addEventListener('click', () => void this.analyse(this.lastRepo));
    $('#btnBack').addEventListener('click', () => {
      this.arrive = null;
      this.setMode(this.result && !this.demo ? 'city' : 'hero');
      history.replaceState({ ...history.state, v: this.mode }, '', this.here(this.mode === 'city' ? '#explore' : ''));
      if (this.mode === 'hero') ($('#repoInput') as HTMLInputElement).focus();
    });
    $('#btnCancel').addEventListener('click', () => {
      this.abort?.abort();
      this.setMode(this.result && !this.demo ? 'city' : 'hero');
      history.replaceState({ ...history.state, v: this.mode }, '', this.here(this.mode === 'city' ? '#explore' : ''));
    });
    $('#btnNew').addEventListener('click', () => this.goHome());
    $('#btnShare').addEventListener('click', () => this.run('share'));
    $('#btnBadge').addEventListener('click', () => void this.copyBadge());
    $('#btnEmbed').addEventListener('click', () => void this.copyEmbed());
    // `submit` fires synchronously with the button press (a dialog's `close` event is queued behind rendering).
    $('#prDialog form').addEventListener('submit', (e) => {
      const v = ($('#prInput') as HTMLInputElement).value.trim();
      if ((e as SubmitEvent).submitter?.getAttribute('value') === 'show' && /^[1-9][0-9]{0,7}$/.test(v)) void this.showPr(Number(v));
    });
    $('#brandHome').addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
      e.preventDefault();
      if (this.mode !== 'hero') this.goHome();
    });
    addEventListener('popstate', (e) => this.onPop(e.state as { v?: string } | null));
    $('#btnTable').addEventListener('click', () => this.openTable($('#tableView').hasAttribute('hidden')));
    addEventListener('keyup', (e) => this.held.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.held.clear());
    addEventListener('keydown', (e) => {
      const active = document.activeElement as HTMLElement | null;
      // An input inside a just-closed dialog can stay activeElement until the browser's focus fixup runs.
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? '') && !active?.closest('dialog:not([open])');
      if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys (Esc closes)
      // A key that started in a dialog (Enter picking a palette result, say) has closed it by now: not ours either.
      if (e.target instanceof Element && e.target.closest('dialog')) return;
      if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) {
        // Back out one level: photo -> table -> panels/selection/compare -> story -> start page.
        if (this.rec) return this.stopRecording(false);
        if (this.photo) return this.togglePhoto();
        if (!$('#tableView').hidden) return this.openTable(false);
        if (this.walker) return this.setWalk(false);
        if (this.compare) return this.setCompare(null);
        if (this.typesGoal) return this.setTypes(false);
        if (this.prOn || this.prAbort) return this.clearPr(true);
        if (this.insights.whatIf >= 0) return this.setWhatIf(-1);
        if (this.weatherGoal) return this.setWeather(false);
        if (this.selected >= 0 || this.P.focus >= 0) return this.select(-1);
        if (this.insights.open) return this.run('insights');
        if (this.drillStack.length) return this.drillOut();
        if ((this.mode === 'city' && !this.demo) || this.mode === 'story') {
          e.preventDefault();
          return this.back();
        }
        return;
      }
      if (this.mode !== 'city' || typing || this.demo) return;
      if ((e.key === ' ' || e.key === 'Enter') && /^(BUTTON|A|SUMMARY)$/.test(active?.tagName ?? '')) return; // keys activate the focused control
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
    const h = this.held;
    if (this.walker) {
      const on = (...k: string[]): number => (k.some((x) => h.has(x)) ? 1 : 0);
      const input = { forward: on('w') - on('s'), strafe: on('d') - on('a'), turn: on('arrowright', 'e') - on('arrowleft', 'q'), look: on('arrowup') - on('arrowdown'), run: shift };
      this.walker.step(dt, input, this.P.t);
      return;
    }
    const s = (shift ? 2 : 1) * dt * 60;
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
      if (this.walker) {
        const mid = c.getBoundingClientRect();
        if (document.pointerLockElement === c) {
          // Mouse captured: clicking selects the building under the centre dot.
          void this.pickAt(mid.left + mid.width / 2, mid.top + mid.height / 2).then((i) => this.select(i));
          return;
        }
        if (e.pointerType === 'mouse') void c.requestPointerLock()?.catch(() => undefined); // drag-to-look still works
      }
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
      if (this.walker && document.pointerLockElement === c) {
        this.walker.look(e.movementX, e.movementY);
        const mid = c.getBoundingClientRect();
        this.hoverAt = { x: mid.left + mid.width / 2, y: mid.top + mid.height / 2 }; // aim to see what it is
        return;
      }
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
        if (this.walker) this.walker.look(-dx, -dy); // drag the view, like grabbing the scene
        else if (e.shiftKey || e.buttons === 2) this.cam.pan(dx, dy);
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
      if (this.mode !== 'city' || this.walker) return;
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
        if (this.walker) return; // no zoom on foot
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
    this.body.classList.toggle('has-sel', i >= 0);
    if (!r || !w || i < 0) {
      this.P.focus = -1;
      this.focusGoal = 0;
      this.inspector.hide();
      setText($('#placeEy'), this.drillStack.length ? 'Inside' : 'Exploring');
      setText($('#placeName'), this.drillStack.length ? this.drillPath() : 'the whole city');
      setText($('#placeSub'), this.drillStack.length ? 'Backspace climbs out' : '');
      return;
    }
    const f = r.files[i]!;
    const d = r.dirs[f.dir]!;
    if (fly && this.walker) this.setWalk(false);
    this.P.focus = f.dir;
    this.focusGoal = 1;
    if (fly) this.flyToFile(i);
    this.inspector.show(r, i);
    setText($('#placeEy'), 'District');
    setText($('#placeName'), d.name);
    setText($('#placeSub'), this.districtLine(d));
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
      ['last change', beforeWindow(f) ? `before ${fmtDate(f.last)}` : ago(f.last, r.meta.span[1])],
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
    // Portrait screens see less width at the same vertical field of view: frame the city from further back.
    this.cam.fit = clamp(1.25 / (this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight)), 1, 2.2);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    const resized = this.canvas.width !== w || this.canvas.height !== h;
    // Assigning the canvas size clears it (even to the same value), which showed as a black blink when a city loaded.
    if (resized) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (force || resized) this.renderer.alloc(w, h, tier);
  }

  private adapt(rawMs: number): void {
    if (!this.dyn.frame(rawMs)) return;
    this.tierIdx = this.dyn.tier;
    this.scale = this.dyn.scale;
    this.resize(true);
  }

  private cameraNow(pos?: Vec, tgt?: Vec, fov = this.fov) {
    const pose = pos && tgt ? { pos, tgt } : (this.lastPose ?? this.cam.pose());
    const far = Math.max(1200, (this.world?.radius ?? 100) * 6);
    // Walking (and the blend out of it) puts the eye next to walls: a closer near plane stops them being cut open.
    return buildCamera(pose.pos, pose.tgt, this.canvas.clientWidth, this.canvas.clientHeight, far, fov, this.walker || this.blend ? NEAR : 0.4);
  }

  /** Nothing is moving but ambient animation: render at a low rate to save battery (PLAN section 6, Idle). */
  private isIdle(now: number): boolean {
    return !(
      now - this.lastInput < ACTIVE_FOR_MS ||
      this.playing ||
      this.blend ||
      this.cam.flying ||
      this.exportNext ||
      this.rec ||
      this.ptrs.size ||
      this.held.size
    );
  }

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    // Hidden tab, or the opaque full-screen table on top: nothing to draw.
    if (document.hidden || !$('#tableView').hidden) return void (this.last = now);
    const idle = this.isIdle(now);
    if (idle && now - this.last < IDLE_FRAME_MS - 2) return; // skipped: time keeps accumulating into the next dt
    if (this.wasIdle && !idle) this.dyn.hold(30); // the long idle intervals say nothing about steady-state cost
    this.wasIdle = idle;
    const rawMs = now - this.last;
    const dt = Math.min(0.05, rawMs / 1000);
    this.last = now;
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
      if (this.rec) {
        // Drive the shot: a quarter turn, or history from start to HEAD. Full rate and a fixed resolution throughout.
        const k = Math.min(1, (now - this.rec.t0) / 1000 / this.rec.dur);
        if (this.rec.kind === 'orbit') this.cam.goal.yaw += (dt * Math.PI) / 2 / this.rec.dur;
        else this.tT = k;
        this.dyn.hold(10);
        const left = Math.ceil(this.rec.dur * (1 - k));
        if (left !== this.rec.left) {
          this.rec.left = left;
          this.toast(`Recording\u2026 ${left} s left (Esc to cancel)`);
        }
      }
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
    } else {
      if (this.walker) this.walker.resolve(P.t); // a building born under the walker (history playing) pushes them out
      ({ pos, tgt } = this.walker ? this.walker.pose() : this.cam.pose());
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
    let focus = dist(pos, tgt);
    if (sf && w0) {
      const at = this.story.chapters[sf.pose.chapter]?.callout?.at;
      if (at) focus = dist(pos, at as Vec);
    } else if (this.mode === 'city' && w0 && this.selected >= 0) {
      focus = dist(pos, [w0.pos[this.selected * 3]!, w0.pos[this.selected * 3 + 1]!, w0.pos[this.selected * 3 + 2]!]);
    }
    if (this.walker && this.selected < 0) focus = 14; // on foot: focus down the street, not on the look target
    P.focusDist += (focus - (P.focusDist || focus)) * (1 - Math.exp(-dt * 4)); // focus pulls glide, never snap
    P.dof = this.mode === 'story' ? 1 : this.mode === 'city' ? (this.photo ? 1 : 0.55) : 0.4;
    P.motion = reduced ? 0 : 1;
    // History flow: 1x playback (1/40 of history per second) or scrolling between chapters reads as 1.
    const flowGoal = reduced ? 0 : clamp(Math.abs(P.t - this.prevT) / Math.max(dt, 1e-3) / 0.02, 0, 1);
    this.prevT = P.t;
    P.flow += (flowGoal - P.flow) * (1 - Math.exp(-dt * 6));
    P.sel = this.mode === 'city' ? this.selected : -1;
    const liftGoal = this.mode === 'city' && P.hover >= 0 && !reduced ? 1 : 0;
    P.lift += (liftGoal - P.lift) * (1 - Math.exp(-dt * 10));
    this.fov = fov;
    this.lastPose = { pos, tgt };
    P.focusAmt += (this.focusGoal - P.focusAmt) * (1 - Math.exp(-dt * 5));
    P.weather = reduced ? this.weatherGoal : P.weather + (this.weatherGoal - P.weather) * (1 - Math.exp(-dt * 2)); // slow fade in
    const prGoal = this.prOn ? 1 : 0;
    P.pr = reduced ? prGoal : P.pr + (prGoal - P.pr) * (1 - Math.exp(-dt * 4));
    const riskGoal = this.insights.whatIf >= 0 ? 1 : 0;
    P.risk = reduced ? riskGoal : P.risk + (riskGoal - P.risk) * (1 - Math.exp(-dt * 3)); // lights fade out, not snap
    P.types = reduced ? this.typesGoal : P.types + (this.typesGoal - P.types) * (1 - Math.exp(-dt * 5)); // cross-fade
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
        const o = i * 3; // written in place: no per-frame arrays in the hot path (EXPERIENCE section 9)
        this.lanterns[o] = lerp(a[0], b[0], u);
        this.lanterns[o + 1] = lerp(a[1], b[1], u) + Math.sin(u * Math.PI) * 3.5;
        this.lanterns[o + 2] = lerp(a[2], b[2], u);
      }
    }
    if (w && this.mode === 'city' && !this.demo) {
      this.timeline.update(this.tT, this.playing, SPEEDS[this.speedIdx]!, this.compare, (t) => w.t0 + t * (w.t1 - w.t0));
      this.minimap.draw(w, pos, tgt, this.hotDirs);
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
    // Resize before drawing: resizing the canvas clears it, so doing it after the draw showed one black frame.
    if (!idle) this.adapt(rawMs); // throttled intervals would read as missed frames and lower quality
    R.render(C, P, this.time, this.lanterns);
    if (this.exportNext) {
      this.exportNext = false;
      this.exportPng(); // same task as the render: the drawing buffer is still intact
    }
    const rec = this.rec;
    if (rec) {
      rec.ctx.drawImage(this.canvas, 0, 0, rec.out.width, rec.out.height); // same task: buffer still intact
      this.caption(rec.ctx, rec.out.width, rec.out.height);
      if (now - rec.t0 >= rec.dur * 1000) this.stopRecording(true);
    }
  };
}
