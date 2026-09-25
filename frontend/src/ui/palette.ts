/**
 * Command palette v2 (EXPERIENCE section 5): fuzzy search over files, districts, people (pseudonyms) and actions,
 * with recent items. ARIA combobox pattern inside a modal <dialog> (focus trapped, Esc closes, focus returns).
 */
import { el } from './dom';

export type Item = { kind: 'action' | 'file' | 'district' | 'person' | 'recent'; label: string; hint: string; run: () => void; key: string };

const MAX_RESULTS = 40;

/** Subsequence fuzzy score: higher is better, -1 if not all query chars appear in order. */
export function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (found === 0 || '/._-'.includes(t[found - 1] ?? '') ? 3 : 0);
    ti = found + 1;
  }
  return score - t.length * 0.01; // prefer shorter matches on ties
}

export class Palette {
  private readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private items: Item[] = [];
  private shown: Item[] = [];
  private sel = 0;
  private recent: Item[] = [];
  private source: () => Item[] = () => [];

  constructor() {
    this.dialog = document.getElementById('palette') as HTMLDialogElement;
    this.input = this.dialog.querySelector('input')!;
    this.list = this.dialog.querySelector('[role="listbox"]')!;
    this.input.addEventListener('input', () => this.filter());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.run(this.sel);
      }
    });
    this.dialog.addEventListener('close', () => this.input.setAttribute('aria-expanded', 'false'));
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close(); // click on the backdrop
    });
  }

  setSource(fn: () => Item[]): void {
    this.source = fn;
  }

  get open(): boolean {
    return this.dialog.open;
  }

  show(): void {
    this.items = this.source();
    this.input.value = '';
    this.dialog.showModal();
    this.input.setAttribute('aria-expanded', 'true');
    this.filter();
    this.input.focus();
  }

  close(): void {
    this.dialog.close();
  }

  private filter(): void {
    const q = this.input.value.trim();
    if (!q) {
      const actions = this.items.filter((i) => i.kind === 'action');
      this.shown = [...this.recent.map((r) => ({ ...r, kind: 'recent' as const })), ...actions].slice(0, MAX_RESULTS);
    } else {
      this.shown = this.items
        .map((it) => ({ it, s: fuzzy(q, it.label) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, MAX_RESULTS)
        .map((x) => x.it);
    }
    this.sel = 0;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.shown.map((it, i) => {
        const li = el('li', null, i === this.sel ? 'sel' : undefined);
        li.id = `pal-opt-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === this.sel));
        li.append(el('span', it.label, 'l'), el('span', it.kind === 'recent' ? `recent \u00b7 ${it.hint}` : it.hint, 'k'));
        li.addEventListener('click', () => this.run(i));
        return li;
      }),
    );
    if (!this.shown.length) this.list.append(el('li', 'No matches', 'empty'));
    this.input.setAttribute('aria-activedescendant', this.shown.length ? `pal-opt-${this.sel}` : '');
    this.list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  private move(d: number): void {
    if (!this.shown.length) return;
    this.sel = (this.sel + d + this.shown.length) % this.shown.length;
    this.render();
  }

  private run(i: number): void {
    const it = this.shown[i];
    if (!it) return;
    this.dialog.close();
    if (it.kind !== 'action') this.recent = [it, ...this.recent.filter((r) => r.key !== it.key)].slice(0, 5);
    it.run();
  }
}
