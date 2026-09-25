import { lerp } from './math';

/**
 * Dynamic resolution (EXPERIENCE section 9): nudge the render scale to hold ~16.6 ms; step tiers only on sustained
 * misses. Input is the rAF interval, which is capped by vsync, so a frame that keeps up reads ~16.7 ms at 60 Hz (never
 * below it): "healthy" therefore means "at or under the refresh interval", not "with headroom" (A7 fix: the old 14.5 ms
 * threshold could never be met at 60 Hz, so one hitch lowered quality for the rest of the session).
 */
export class DynRes {
  scale = 1; // 0.6..1
  private ms = 16.7;
  private slow = 0;
  private fast = 0;

  constructor(public tier: number) {}

  /** Feed one frame interval; returns true when scale or tier changed (the caller reallocates render targets). */
  frame(rawMs: number): boolean {
    if (rawMs > 250) return false; // tab switch or debugger pause, not a real frame
    this.ms = lerp(this.ms, rawMs, 0.08);
    if (this.ms > 18.5) (this.slow++, (this.fast = 0));
    else if (this.ms < 17.4) (this.fast++, (this.slow = 0));
    else this.slow = this.fast = 0;
    if (this.slow > 20) {
      if (this.scale > 0.62) this.scale = Math.max(0.6, this.scale - 0.08);
      else if (this.tier > 0) (this.tier--, (this.scale = 0.85));
      else return this.reset(false);
      return this.reset(true);
    }
    if (this.fast > 600 && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.05); // hysteresis: ~10 s of steady frames per step up
      return this.reset(true);
    }
    return false;
  }

  /** Start measuring afresh, so the reallocation hitch itself does not trigger the next step down. */
  private reset(changed: boolean): boolean {
    this.ms = 16.7;
    this.slow = this.fast = 0;
    return changed;
  }
}
