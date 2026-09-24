/**
 * Story camera rig: a pure function of scroll progress (EXPERIENCE sections 1-2). Same p in, same pose out,
 * whichever direction you scrolled from, so reverse scroll is exactly symmetric.
 *
 * Chapter i owns the window centred on centers[i]; the camera rests near each centre (eased remap) and travels
 * between them along a centripetal Catmull-Rom spline through the chapter keys.
 */
import { clamp, lerp, smoothstep, type V3 } from '../render/math';
import type { Chapter } from './chapters';

export type Pose = { pos: V3; tgt: V3; fov: number; t: number; hot: number; exposure: number; focus: number; chapter: number; local: number };

/** Evenly spaced chapter centres in [0,1], with a lead-in before the first and room after the last. */
export function centers(n: number): number[] {
  if (n <= 1) return [0.5];
  return Array.from({ length: n }, (_, i) => 0.06 + (0.88 * i) / (n - 1));
}

/** Centripetal Catmull-Rom (alpha 0.5) between p1 and p2; no cusps or self-intersections on uneven keys. */
function crc(p0: V3, p1: V3, p2: V3, p3: V3, u: number): V3 {
  const d = (a: V3, b: V3): number => Math.max(1e-4, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) ** 0.5);
  const t0 = 0;
  const t1 = t0 + d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const t = lerp(t1, t2, u);
  const mix = (a: V3, b: V3, ta: number, tb: number): V3 => {
    const k = (t - ta) / (tb - ta);
    return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

export function pose(ch: readonly Chapter[], p: number): Pose {
  const c = centers(ch.length);
  const x = clamp(p, 0, 1);
  // Segment and local position between chapter centres.
  let i = 0;
  while (i < c.length - 1 && x > c[i + 1]!) i++;
  const a = c[i]!;
  const b = c[Math.min(i + 1, c.length - 1)]!;
  const raw = b > a ? clamp((x - a) / (b - a), 0, 1) : 0;
  // Hold near each chapter centre (reading time), travel in between.
  const u = smoothstep(0.18, 0.82, raw);
  const K = (k: number): Chapter => ch[clamp(k, 0, ch.length - 1)]!;
  const A = K(i);
  const B = K(i + 1);
  const pos = crc(K(i - 1).key.pos, A.key.pos, B.key.pos, K(i + 2).key.pos, u);
  const tgt = crc(K(i - 1).key.tgt, A.key.tgt, B.key.tgt, K(i + 2).key.tgt, u);
  pos[1] = Math.max(1.5, pos[1]); // never under the water
  const nearest = raw < 0.5 ? i : Math.min(i + 1, ch.length - 1);
  return {
    pos,
    tgt,
    fov: lerp(A.key.fov, B.key.fov, u),
    t: lerp(A.t, B.t, u),
    hot: lerp(A.hot, B.hot, u),
    exposure: lerp(A.exposure, B.exposure, u),
    focus: u < 0.5 ? A.focus : B.focus,
    chapter: x < a ? 0 : nearest,
    local: raw,
  };
}

/** Opacity of chapter i's text at progress p: fully visible around its centre, fading at the window edges. */
export function chapterOpacity(n: number, i: number, p: number): number {
  const c = centers(n);
  const half = n > 1 ? (c[1]! - c[0]!) / 2 : 0.5;
  const d = Math.abs(p - c[i]!) / half;
  return 1 - smoothstep(0.45, 0.85, d);
}
