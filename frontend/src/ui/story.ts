/**
 * Scroll story UI (A4): chapter cards, rail, callout, progress, skip, keys, deep links, scroll restore, soft snap.
 * Everything visual is computed from scroll progress p, never from elapsed time, so reverse scroll is symmetric.
 */
import type { Result } from '../lib/result';
import { clamp, project, smoothstep, type M4, type V3 } from '../render/math';
import { buildChapters, type Chapter } from '../story/chapters';
import { centers, chapterOpacity, pose, type Pose } from '../story/rig';
import { LenisEngine, NativeEngine, type ScrollEngine } from '../story/scroll';
import type { World } from '../world/build';
import { $, el, fmt, reducedMotion, setText } from './dom';

const VH_PER_CHAPTER = 90;
const SNAP_IDLE_MS = 220;

export type StoryFrame = { pose: Pose; velocity: number; fade: number };

export class Story {
  private engine: ScrollEngine | null = null;
  private ch: Chapter[] = [];
  private cards: HTMLElement[] = [];
  private railBtns: HTMLButtonElement[] = [];
  private statEls: { el: HTMLElement; value: number; chapter: number }[] = [];
  private key = '';
  private current = -1;
  private lastInput = 0;
  private scrollbarDrag = false;
  private snapping = false;
  private vel = 0;
  private readonly onExplore: () => void;
  private readonly offs: (() => void)[] = [];

  constructor(onExplore: () => void) {
    this.onExplore = onExplore;
  }

  get active(): boolean {
    return this.engine !== null;
  }

  get chapters(): readonly Chapter[] {
    return this.ch;
  }

  /** Build chapters for a result and start scrolling. `resume` restores a saved position for this repo. */
  enter(r: Result, w: World): void {
    this.exit();
    this.ch = buildChapters(r, w);
    this.key = `afterglow:story:${r.meta.repo}@${r.meta.sha.slice(0, 12)}`;
    this.renderDom();
    const spacer = $('#scroller');
    spacer.style.height = `${this.ch.length * VH_PER_CHAPTER + 100}vh`;
    spacer.hidden = false;
    document.documentElement.classList.add('story-scroll');
    $('#story').hidden = false;
    this.engine = reducedMotion() ? new NativeEngine() : new LenisEngine();
    this.bind();
    const start = this.startProgress();
    requestAnimationFrame(() => this.engine?.scrollToProgress(start, { immediate: true }));
  }

  exit(): void {
    this.save();
    for (const off of this.offs.splice(0)) off();
    this.engine?.destroy();
    this.engine = null;
    $('#story').hidden = true;
    $('#scroller').hidden = true;
    document.documentElement.classList.remove('story-scroll');
    scrollTo(0, 0);
  }

  private startProgress(): number {
    const m = /^#chapter-([1-9])$/.exec(location.hash);
    if (m) {
      const i = Number(m[1]) - 1;
      if (i < this.ch.length) return centers(this.ch.length)[i]!;
    }
    try {
      const saved = Number(sessionStorage.getItem(this.key));
      if (Number.isFinite(saved) && saved > 0 && saved <= 1) return saved;
    } catch {
      /* storage blocked: start at the top */
    }
    return 0;
  }

  private save(): void {
    if (!this.engine || !this.key) return;
    try {
      sessionStorage.setItem(this.key, this.engine.progress().toFixed(4)); // UI position only, no data
    } catch {
      /* storage blocked */
    }
  }

  private renderDom(): void {
    const list = $('#chapters');
    const rail = $('#rail');
    this.statEls = [];
    this.cards = this.ch.map((c, i) => {
      const art = el('article', null, 'chap');
      art.id = `chapter-${i + 1}`;
      art.setAttribute('aria-labelledby', `chapter-${i + 1}-title`);
      const h2 = el('h2');
      h2.id = `chapter-${i + 1}-title`;
      h2.append(document.createTextNode(`${c.title} `), el('em', c.em));
      art.append(el('p', `${String(i + 1).padStart(2, '0')} \u00b7 ${c.eyebrow}`, 'eyebrow'), h2, el('p', c.body, 'body'));
      if (c.stats) {
        const stats = el('div', null, 'stats');
        for (const s of c.stats) {
          const b = el('b', '0');
          const stat = el('div', null, 'stat');
          stat.append(b, el('span', s.label));
          stats.append(stat);
          this.statEls.push({ el: b, value: s.value, chapter: i });
        }
        art.append(stats);
      }
      if (c.id === 'explore') {
        const go = el('button', 'Open the city', 'go cta');
        go.type = 'button';
        go.addEventListener('click', () => this.onExplore());
        art.append(go);
      }
      return art;
    });
    list.replaceChildren(...this.cards);
    this.railBtns = this.ch.map((c, i) => {
      const b = el('button');
      b.type = 'button';
      b.append(el('span', c.eyebrow), el('i'));
      b.setAttribute('aria-label', `Chapter ${i + 1}: ${c.eyebrow}`);
      b.addEventListener('click', () => this.goTo(i));
      return b;
    });
    rail.replaceChildren(...this.railBtns);
  }

  goTo(i: number, immediate = false): void {
    const c = centers(this.ch.length);
    const idx = clamp(i, 0, this.ch.length - 1);
    this.engine?.scrollToProgress(c[idx]!, { immediate: immediate || reducedMotion(), duration: 0.75 });
  }

  private bind(): void {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      addEventListener(type, fn, opts);
      this.offs.push(() => removeEventListener(type, fn, opts));
    };
    const input = (): void => {
      this.lastInput = performance.now();
      this.snapping = false;
    };
    on('wheel', input, { passive: true });
    on('touchmove', input, { passive: true });
    on('pointerdown', (e) => {
      // A press right of the document is on the native scrollbar: never snap under the user's thumb.
      this.scrollbarDrag = e.clientX >= document.documentElement.clientWidth;
      input();
    });
    on('pointerup', () => (this.scrollbarDrag = false));
    on('pagehide', () => this.save());
    on('keydown', (e) => {
      if (/^(INPUT|TEXTAREA|BUTTON)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? '') && e.key === ' ') return;
      if (/^(INPUT|TEXTAREA)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? '')) return;
      const n = this.ch.length;
      const cur = Math.max(0, this.current);
      let target: number | null = null;
      if (e.key === ' ' || e.key === 'PageDown' || e.key === 'j' || e.key === 'J') target = e.shiftKey && e.key === ' ' ? cur - 1 : cur + 1;
      else if (e.key === 'PageUp' || e.key === 'k' || e.key === 'K') target = cur - 1;
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = n - 1;
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) target = Number(e.key) - 1;
      if (target === null) return;
      e.preventDefault();
      input();
      this.goTo(target);
    });
  }

  /** Per-frame update. Returns the story pose (pure in p) plus velocity for effects. */
  frame(now: number, vp: M4 | null, width: number, height: number): StoryFrame | null {
    const eng = this.engine;
    if (!eng) return null;
    eng.raf(now);
    const p = eng.progress();
    const reduced = reducedMotion();
    let ps = pose(this.ch, p);
    let fade = 1;
    if (reduced) {
      // Static cards with camera crossfades: hold each chapter's key, dip to dark between them.
      const c = centers(this.ch.length);
      ps = pose(this.ch, c[ps.chapter]!);
      const rawNear = pose(this.ch, p).local;
      fade = 1 - 0.85 * (1 - smoothstep(0.08, 0.3, Math.abs(rawNear - 0.5)));
    }
    this.vel += (clamp(Math.abs(eng.velocity()) / 60, 0, 1) - this.vel) * 0.2;

    // Chapter cards, stats and rail: all functions of p.
    this.cards.forEach((card, i) => {
      const o = chapterOpacity(this.ch.length, i, p);
      card.style.opacity = o.toFixed(3);
      card.style.transform = reduced ? 'none' : `translateY(${((1 - o) * 14).toFixed(1)}px)`;
      card.classList.toggle('live', o > 0.5);
      card.inert = o < 0.5;
    });
    for (const s of this.statEls) {
      const k = smoothstep(0.1, 0.9, chapterOpacity(this.ch.length, s.chapter, p));
      setText(s.el, fmt(s.value * k));
    }
    if (ps.chapter !== this.current) {
      this.current = ps.chapter;
      this.railBtns.forEach((b, i) => (i === ps.chapter ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
      history.replaceState(null, '', `#chapter-${ps.chapter + 1}`);
    }
    ($('#progress i') as HTMLElement).style.transform = `scaleX(${p.toFixed(4)})`;
    this.callout(ps, p, vp, width, height);

    // Soft snap to the nearest chapter centre once the user stops (never while dragging the scrollbar).
    if (!reduced && !this.scrollbarDrag && !this.snapping && now - this.lastInput > SNAP_IDLE_MS && Math.abs(eng.velocity()) < 0.2) {
      const c = centers(this.ch.length);
      const target = c[ps.chapter]!;
      const half = this.ch.length > 1 ? (c[1]! - c[0]!) / 2 : 0.5;
      if (Math.abs(p - target) > 0.004 && Math.abs(p - target) < half * 0.7) {
        this.snapping = true;
        eng.scrollToProgress(target, { duration: 0.6 });
      }
    }
    return { pose: ps, velocity: reduced ? 0 : this.vel, fade };
  }

  private callout(ps: Pose, p: number, vp: M4 | null, w: number, h: number): void {
    const box = $('#callout');
    const c = this.ch[ps.chapter]?.callout;
    const o = chapterOpacity(this.ch.length, ps.chapter, p);
    if (!c || !vp || o < 0.05) {
      box.style.opacity = '0';
      return;
    }
    const at = project(vp, c.at as V3, w, h);
    if (!at) {
      box.style.opacity = '0';
      return;
    }
    // A zero-width space after each slash lets long paths wrap at directory boundaries first (still plain text).
    setText(box.querySelector('.name') as HTMLElement, c.name.replaceAll('/', '/\u200b'));
    setText(box.querySelector('.meta') as HTMLElement, c.meta);
    box.classList.toggle('hot', c.hot);
    // Line-trace draws in as the chapter settles (a function of p, so it undraws symmetrically).
    const draw = smoothstep(0.25, 0.95, o);
    const dx = at.x > w * 0.62 ? -150 : 70;
    const dy = -70;
    const len = Math.hypot(dx, dy);
    const line = box.querySelector('.line') as HTMLElement;
    line.style.width = `${len}px`;
    line.style.transform = `rotate(${Math.atan2(dy, dx)}rad) scaleX(${draw.toFixed(3)})`;
    const body = box.querySelector('.body') as HTMLElement;
    body.style.transform = `translate(${dx > 0 ? dx : dx - 60}px, ${dy - 44}px)`;
    body.style.opacity = smoothstep(0.6, 1, draw).toFixed(3);
    box.style.opacity = o.toFixed(3);
    box.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
  }
}
