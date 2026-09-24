/**
 * Orbit camera for A3 (the full camera model with zoom-to-cursor, inertia and presets is A5, EXPERIENCE section 3).
 * Goals are set by input; the rendered pose follows them with frame-rate-independent damping.
 */
import { clamp, cross, lookAt, mul, norm, perspective, sub, type V3 } from '../render/math';
import { reflectVP, type Camera } from '../render/renderer';

export type Orbit = { yaw: number; pitch: number; dist: number; x: number; y: number; z: number };

export class OrbitCamera {
  goal: Orbit = { yaw: 0.6, pitch: 0.5, dist: 120, x: 0, y: 4, z: 0 };
  cur: Orbit = { ...this.goal };
  minDist = 7;
  maxDist = 400;

  frame(radius: number): void {
    this.maxDist = Math.max(120, radius * 3.2);
    this.goal = { yaw: 0.6, pitch: 0.55, dist: clamp(radius * 1.55, 40, this.maxDist), x: 0, y: 4, z: 0 };
  }

  snap(): void {
    this.cur = { ...this.goal };
  }

  update(dt: number, reduced: boolean): void {
    const k = reduced ? 1 : 1 - Math.exp(-dt * 6);
    for (const key of ['yaw', 'pitch', 'dist', 'x', 'y', 'z'] as const) this.cur[key] += (this.goal[key] - this.cur[key]) * k;
  }

  orbit(dx: number, dy: number): void {
    this.goal.yaw -= dx * 0.0052;
    this.goal.pitch = clamp(this.goal.pitch + dy * 0.004, 0.06, 1.45);
  }

  zoom(factor: number): void {
    this.goal.dist = clamp(this.goal.dist * factor, this.minDist, this.maxDist);
  }

  pan(dx: number, dy: number): void {
    const s = this.goal.dist * 0.0016;
    const { yaw } = this.goal;
    this.goal.x -= (Math.cos(yaw) * dx + Math.sin(yaw) * dy) * s;
    this.goal.z += (Math.sin(yaw) * dx - Math.cos(yaw) * dy) * s;
  }

  pose(): { pos: V3; tgt: V3 } {
    const c = this.cur;
    const cp = Math.cos(c.pitch);
    return {
      pos: [c.x + Math.sin(c.yaw) * cp * c.dist, c.y + Math.sin(c.pitch) * c.dist, c.z + Math.cos(c.yaw) * cp * c.dist],
      tgt: [c.x, c.y, c.z],
    };
  }
}

export function buildCamera(pos: V3, tgt: V3, width: number, height: number, far: number): Camera {
  const aspect = width / Math.max(1, height);
  const fov = ((aspect < 1 ? 70 : 50) * Math.PI) / 180;
  const vp = mul(perspective(fov, aspect, 0.4, far), lookAt(pos, tgt, [0, 1, 0]));
  const f = norm(sub(tgt, pos));
  const r = norm(cross(f, [0, 1, 0]));
  return { vp, vpR: reflectVP(vp), pos, posR: [pos[0], -pos[1], pos[2]], right: r, up: cross(r, f), fwd: f, tanH: Math.tan(fov / 2) };
}
