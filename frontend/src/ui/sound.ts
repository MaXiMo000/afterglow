/**
 * Ambient sound (docs/ROADMAP.md #13): off by default and only ever started by the user's own click (the site's
 * `Permissions-Policy: autoplay=()` stays: nothing plays on its own). Synthesised with Web Audio, no audio files.
 *
 * A low pad whose brightness follows the repository's activity at the point in history on screen, and a soft
 * chime when the hotspot tour arrives somewhere. Decoration: nothing is conveyed by sound alone.
 */
export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private idleTimer = 0;
  on = false;

  /** Turn sound on or off (call from a user gesture the first time: the audio context needs one). */
  set(on: boolean): void {
    this.on = on;
    clearTimeout(this.idleTimer);
    if (on && !this.ctx && !this.build()) return;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(on ? 0.05 : 0, now, on ? 0.8 : 0.3); // fade, never a click
    if (on) void ctx.resume();
    else this.idleTimer = window.setTimeout(() => void (this.on || ctx.suspend()), 2000);
  }

  /** 0..1: how busy the history is at the time on screen. Brightens the pad slowly. */
  activity(a: number): void {
    if (!this.on || !this.ctx || !this.filter) return;
    this.filter.frequency.setTargetAtTime(260 + 900 * Math.max(0, Math.min(1, a)), this.ctx.currentTime, 1.5);
  }

  /** A soft two-note chime; `rank` 0 is the hottest hotspot (highest pitch). */
  chime(rank: number): void {
    const ctx = this.ctx;
    if (!this.on || !ctx || !this.master) return;
    const t = ctx.currentTime;
    const base = 880 * 2 ** (-Math.min(rank, 12) / 12);
    for (const [f, delay] of [[base, 0], [base * 1.5, 0.09]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(0.5, t + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.6);
      o.connect(g).connect(this.master);
      o.start(t + delay);
      o.stop(t + delay + 1.7);
    }
  }

  /** Pause with the tab; resume only if the user had it on. */
  visible(v: boolean): void {
    if (!this.ctx) return;
    if (!v) void this.ctx.suspend();
    else if (this.on) void this.ctx.resume();
  }

  private build(): boolean {
    if (typeof AudioContext === 'undefined') return false;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    filter.Q.value = 0.6;
    filter.connect(master);
    // A warm, slightly detuned low chord (A1, E2, A2) under the filter.
    for (const [f, detune] of [[55, -7], [82.41, 5], [110, 9]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = detune;
      g.gain.value = 0.22;
      o.connect(g).connect(filter);
      o.start();
    }
    // Slow breathing of the filter, one cycle every ~20 s.
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 0.05;
    depth.gain.value = 90;
    lfo.connect(depth).connect(filter.frequency);
    lfo.start();
    this.ctx = ctx;
    this.master = master;
    this.filter = filter;
    return true;
  }
}
