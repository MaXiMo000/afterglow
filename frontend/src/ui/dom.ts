/** DOM helpers. Text only ever goes in through textContent (CLAUDE.md rule 2); Trusted Types enforce it. */

export function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | null, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
export const fmtDate = (epoch: number): string =>
  new Date(epoch * 1000).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
export function ago(epoch: number, now: number): string {
  const d = Math.max(0, now - epoch) / 86400;
  if (d < 1) return 'today';
  if (d < 45) return `${Math.round(d)} days ago`;
  if (d < 540) return `${Math.round(d / 30.4)} months ago`;
  return `${(d / 365.25).toFixed(1)} years ago`;
}

export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
