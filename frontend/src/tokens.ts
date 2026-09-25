/**
 * Design tokens: the single source of truth (docs/EXPERIENCE.md section 7). `vite.config.ts` turns this into
 * `virtual:tokens.css` (CSS custom properties) at build time, so no style is ever injected at runtime.
 * Dark theme only, by design: the product is a night scene and every contrast pair is tuned against `ink`.
 */
export const tokens = {
  color: {
    ink: '#060a11',
    deep: '#0a1620',
    mist: '#173a3f',
    violet: '#2b2148',
    dusk: '#e58da5',
    amber: '#ffb45e',
    coral: '#ff5a4a',
    moss: '#5fd6b4',
    sky: '#8ab4ff',
    text: '#ece6db',
    dim: '#a9bbbd', // 8.9:1 on ink
    faint: '#7d9296', // 5.3:1 on ink: still passes 4.5:1 for small text
    line: 'rgba(236, 230, 219, 0.16)',
    glass: 'rgba(6, 10, 17, 0.62)',
    'glass-hi': 'rgba(10, 18, 28, 0.82)',
    scrim: 'rgba(6, 10, 17, 0.72)',
  },
  font: {
    serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
    mono: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
    sans: "'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  size: {
    xs: '0.6875rem', // 11px
    sm: '0.8125rem',
    md: '0.9375rem',
    lg: '1.25rem',
    xl: 'clamp(1.9rem, 3vw, 2.6rem)',
    hero: 'clamp(3rem, 8vw, 7rem)',
  },
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px', 7: '48px', 8: '64px' },
  radius: { sm: '3px', md: '6px', pill: '999px' },
  shadow: { panel: '0 30px 80px rgba(0, 0, 0, 0.55)', glow: '0 0 14px rgba(255, 150, 80, 0.55)' },
  motion: {
    fast: '120ms',
    base: '180ms',
    slow: '420ms',
    'ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
    'ease-in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
  },
  z: { canvas: '1', hud: '4', panel: '5', overlay: '8', dialog: '10', toast: '12' },
  gutter: 'clamp(16px, 4.4vw, 64px)',
} as const;

/** Flatten to `--group-name: value` declarations. */
export function tokensToCss(): string {
  const lines: string[] = [];
  for (const [group, value] of Object.entries(tokens)) {
    if (typeof value === 'string') {
      lines.push(`  --${group}: ${value};`);
      continue;
    }
    for (const [name, v] of Object.entries(value)) lines.push(`  --${group}-${name}: ${v};`);
  }
  return `:root {\n  color-scheme: dark;\n${lines.join('\n')}\n}\n`;
}
