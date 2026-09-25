/**
 * Share links (EXPERIENCE section 5, SECURITY T15). The URL hash carries only strictly validated numbers and the
 * repo name; anything unexpected is dropped, and nothing from it is ever inserted as HTML.
 *   #v=1&r=owner/name&c=yaw,pitch,dist,x,z&t=0.734
 */
import { parseRepo, type RepoRef } from './repo';

export type View = { repo: RepoRef; cam: { yaw: number; pitch: number; dist: number; x: number; z: number } | null; t: number | null };

const MAX_HASH = 300;
const NUM = /^-?\d{1,6}(\.\d{1,4})?$/;

function num(s: string | undefined, lo: number, hi: number): number | null {
  if (s === undefined || !NUM.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

export function encodeView(v: View): string {
  const parts = [`v=1`, `r=${v.repo.owner}/${v.repo.name}`];
  if (v.cam) {
    const c = v.cam;
    const wrap = ((c.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    parts.push(`c=${[wrap, c.pitch, c.dist, c.x, c.z].map((n) => n.toFixed(3)).join(',')}`);
  }
  if (v.t !== null) parts.push(`t=${v.t.toFixed(4)}`);
  return `#${parts.join('&')}`;
}

export function decodeView(hash: string): View | null {
  if (!hash.startsWith('#') || hash.length > MAX_HASH) return null;
  const params = new Map<string, string>();
  for (const kv of hash.slice(1).split('&')) {
    const i = kv.indexOf('=');
    if (i <= 0) return null;
    const k = kv.slice(0, i);
    if (!['v', 'r', 'c', 't'].includes(k) || params.has(k)) return null;
    params.set(k, kv.slice(i + 1));
  }
  if (params.get('v') !== '1') return null;
  const repo = parseRepo(params.get('r') ?? '');
  if (!repo) return null;
  let cam: View['cam'] = null;
  const c = params.get('c');
  if (c !== undefined) {
    const p = c.split(',');
    if (p.length !== 5) return null;
    const yaw = num(p[0], 0, 7);
    const pitch = num(p[1], 0, 1.6);
    const dist = num(p[2], 1, 5000);
    const x = num(p[3], -5000, 5000);
    const z = num(p[4], -5000, 5000);
    if (yaw === null || pitch === null || dist === null || x === null || z === null) return null;
    cam = { yaw, pitch, dist, x, z };
  }
  const tRaw = params.get('t');
  const t = tRaw === undefined ? null : num(tRaw, 0, 1);
  if (tRaw !== undefined && t === null) return null;
  return { repo, cam, t };
}
