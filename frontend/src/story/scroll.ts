/**
 * ScrollEngine (EXPERIENCE section 1): Lenis behind a small interface so it stays replaceable.
 * Driven from our own animation frame (autoRaf off), so the camera reads the smoothed value in the same frame
 * it is produced: camera latency to the smoothed scroll is 0 frames (docs/PLAN.md section 6).
 * Reduced motion gets native scrolling: no smoothing, no hijack.
 */
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

export interface ScrollEngine {
  /** 0..1 over the scrollable height. */
  progress(): number;
  /** Signed scroll speed in CSS px per frame (smoothed value's derivative). */
  velocity(): number;
  scrollToProgress(p: number, opts?: { immediate?: boolean; duration?: number }): void;
  raf(now: number): void;
  destroy(): void;
}

const limit = (): number => Math.max(1, document.documentElement.scrollHeight - innerHeight);

export const SCROLL_CONFIG = { lerp: 0.14, wheelMultiplier: 1.15, touchMultiplier: 1 } as const;

export class LenisEngine implements ScrollEngine {
  private readonly lenis = new Lenis({
    autoRaf: false,
    lerp: SCROLL_CONFIG.lerp,
    wheelMultiplier: SCROLL_CONFIG.wheelMultiplier,
    touchMultiplier: SCROLL_CONFIG.touchMultiplier,
    syncTouch: false, // touch keeps native momentum (EXPERIENCE: "touch handled natively")
    smoothWheel: true,
  });
  progress(): number {
    return Math.min(1, Math.max(0, this.lenis.scroll / limit()));
  }
  velocity(): number {
    return this.lenis.velocity;
  }
  scrollToProgress(p: number, opts: { immediate?: boolean; duration?: number } = {}): void {
    this.lenis.scrollTo(p * limit(), {
      immediate: opts.immediate ?? false,
      duration: opts.duration ?? 0.8,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      lock: false, // any wheel or touch cancels the flight
    });
  }
  raf(now: number): void {
    this.lenis.raf(now);
  }
  destroy(): void {
    this.lenis.destroy();
  }
}

export class NativeEngine implements ScrollEngine {
  private last = scrollY;
  private v = 0;
  progress(): number {
    return Math.min(1, Math.max(0, scrollY / limit()));
  }
  velocity(): number {
    return this.v;
  }
  scrollToProgress(p: number): void {
    scrollTo({ top: p * limit(), behavior: 'auto' });
  }
  raf(): void {
    this.v = scrollY - this.last;
    this.last = scrollY;
  }
  destroy(): void {}
}
