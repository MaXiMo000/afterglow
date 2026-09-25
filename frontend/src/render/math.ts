/** Minimal column-major 4x4 matrix and vec3 helpers (ported from prototype/src/util.js). */
export type V3 = [number, number, number];
export type M4 = Float32Array;

export function perspective(fovy: number, aspect: number, near: number, far: number): M4 {
  const t = 1 / Math.tan(fovy / 2);
  const o = new Float32Array(16);
  o[0] = t / aspect;
  o[5] = t;
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}

export function lookAt(e: V3, c: V3, u: V3): M4 {
  let zx = e[0] - c[0];
  let zy = e[1] - c[1];
  let zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l;
  zy /= l;
  zz /= l;
  let xx = u[1] * zz - u[2] * zy;
  let xy = u[2] * zx - u[0] * zz;
  let xz = u[0] * zy - u[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l;
  xy /= l;
  xz /= l;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1,
  ]); // prettier-ignore
}

export function mul(a: M4, b: M4): M4 {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + j] ?? 0) * (b[i * 4 + k] ?? 0);
      o[i * 4 + j] = s;
    }
  return o;
}

/** View-projection mirrored in the water plane (y -> -y) for planar reflections. */
export function mirrorY(vp: M4): M4 {
  const o = new Float32Array(vp);
  for (const i of [4, 5, 6, 7]) o[i] = -(o[i] ?? 0);
  return o;
}

/** Project a world point to CSS pixels; null if behind the camera. */
export function project(vp: M4, p: V3, w: number, h: number): { x: number; y: number } | null {
  const m = (i: number): number => vp[i] ?? 0;
  const cw = m(3) * p[0] + m(7) * p[1] + m(11) * p[2] + m(15);
  if (cw <= 0.05) return null;
  const x = (m(0) * p[0] + m(4) * p[1] + m(8) * p[2] + m(12)) / cw;
  const y = (m(1) * p[0] + m(5) * p[1] + m(9) * p[2] + m(13)) / cw;
  return { x: (x * 0.5 + 0.5) * w, y: (1 - (y * 0.5 + 0.5)) * h };
}

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Deterministic PRNG (mulberry32) and string hash, so a repo always lays out the same way. */
export function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
