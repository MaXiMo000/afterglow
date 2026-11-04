/**
 * Explore camera: map-style ground grab with momentum, orbit with inertia, eased keyboard driving, zoom toward the
 * cursor, eased flights, presets. Goals are set by input; the rendered pose follows with frame-rate-independent damping.
 * Pitch is clamped short of the poles (never flips) and the camera never goes under the water.
 */
import { clamp, cross, lookAt, mul, norm, perspective, sub, type V3 } from '../render/math';
import { reflectVP, type Camera } from '../render/renderer';

export type Orbit = { yaw: number; pitch: number; dist: number; x: number; y: number; z: number };
export type Preset = 'overview' | 'street' | 'top' | 'skyline' | 'cinematic';
/** Held-key input, each -1..1: move forward / right, turn, tilt up, zoom out. */
export type Drive = { fwd: number; strafe: number; turn: number; tilt: number; zoom: number };
const KEYS = ['yaw', 'pitch', 'dist', 'x', 'y', 'z'] as const;
const PITCH_MIN = 0.06;
const PITCH_MAX = 1.48;
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class OrbitCamera {
  goal: Orbit = { yaw: 0.6, pitch: 0.5, dist: 120, x: 0, y: 4, z: 0 };
  cur: Orbit = { ...this.goal };
  minDist = 7;
  maxDist = 400;
  bound = 200; // how far the target may wander from the centre
  autoOrbit = false;
  private spin = { yaw: 0, pitch: 0 }; // inertia, radians per second
  private drift = { x: 0, z: 0 }; // pan momentum after a fling, world units per second
  private vel: Drive = { fwd: 0, strafe: 0, turn: 0, tilt: 0, zoom: 0 }; // eased keyboard input
  private flight: { from: Orbit; to: Orbit; k: number; dur: number } | null = null;

  frame(radius: number): void {
    this.maxDist = Math.max(120, radius * 3.2);
    this.bound = Math.max(40, radius * 1.2);
    this.goal = this.home(radius);
  }

  /** Pull-back for narrow (portrait) screens, set by the app from the canvas aspect: 1 on landscape. */
  fit = 1;

  home(radius: number): Orbit {
    return { yaw: 0.6, pitch: 0.55, dist: clamp(radius * 1.55 * this.fit, 40, this.maxDist), x: 0, y: 4, z: 0 };
  }

  preset(p: Preset, radius: number): Orbit {
    switch (p) {
      case 'overview':
        return this.home(radius);
      case 'street':
        return { yaw: this.goal.yaw, pitch: 0.09, dist: 22, x: this.goal.x, y: 2, z: this.goal.z };
      case 'top':
        return { yaw: this.goal.yaw, pitch: PITCH_MAX, dist: clamp(radius * 2.1, 40, this.maxDist), x: 0, y: 0, z: 0 };
      case 'skyline':
        return { yaw: this.goal.yaw, pitch: 0.12, dist: clamp(radius * 1.35, 40, this.maxDist), x: 0, y: 6, z: 0 };
      case 'cinematic':
        return { ...this.home(radius), pitch: 0.32, dist: clamp(radius * 1.25, 40, this.maxDist) };
    }
  }

  snap(): void {
    this.cur = { ...this.goal };
    this.spin = { yaw: 0, pitch: 0 };
    this.drift = { x: 0, z: 0 };
    this.flight = null;
  }

  /** Eased flight to a goal (700-1000 ms, cancellable by any input). */
  flyTo(to: Orbit, dur = 0.85, reduced = false): void {
    this.spin = { yaw: 0, pitch: 0 };
    this.drift = { x: 0, z: 0 };
    const target = this.clampOrbit({ ...to });
    // Take the short way round.
    const d = ((target.yaw - this.cur.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    target.yaw = this.cur.yaw + d;
    if (reduced) {
      this.goal = target;
      this.snap();
      return;
    }
    this.flight = { from: { ...this.cur }, to: target, k: 0, dur };
    this.goal = { ...target };
  }

  cancel(): void {
    if (!this.flight) return;
    this.goal = { ...this.cur };
    this.flight = null;
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  update(dt: number, reduced: boolean): void {
    if (this.flight) {
      const f = this.flight;
      f.k = Math.min(1, f.k + dt / f.dur);
      const e = ease(f.k);
      for (const key of KEYS) this.cur[key] = f.from[key] + (f.to[key] - f.from[key]) * e;
      if (f.k >= 1) this.flight = null;
      return;
    }
    if (this.autoOrbit && !reduced) this.goal.yaw += dt * 0.05;
    if (Math.abs(this.spin.yaw) + Math.abs(this.spin.pitch) > 1e-4) {
      this.goal.yaw += this.spin.yaw * dt;
      this.goal.pitch = clamp(this.goal.pitch + this.spin.pitch * dt, PITCH_MIN, PITCH_MAX);
      const decay = Math.exp(-dt * 4.5);
      this.spin.yaw *= decay;
      this.spin.pitch *= decay;
    }
    if (Math.abs(this.drift.x) + Math.abs(this.drift.z) > 1e-3) {
      this.goal.x += this.drift.x * dt;
      this.goal.z += this.drift.z * dt;
      this.clampTarget();
      const decay = Math.exp(-dt * 5);
      this.drift.x *= decay;
      this.drift.z *= decay;
    }
    const k = reduced ? 1 : 1 - Math.exp(-dt * 9);
    for (const key of KEYS) this.cur[key] += (this.goal[key] - this.cur[key]) * k;
  }

  /** Drag orbit. `dt` is the event interval, used to carry release velocity (inertia). */
  orbit(dx: number, dy: number, dt = 0): void {
    this.cancel();
    const yaw = -dx * 0.0052;
    const pitch = dy * 0.004;
    this.goal.yaw += yaw;
    this.goal.pitch = clamp(this.goal.pitch + pitch, PITCH_MIN, PITCH_MAX);
    if (dt > 0) {
      this.spin.yaw = 0.6 * this.spin.yaw + 0.4 * (yaw / dt);
      this.spin.pitch = 0.6 * this.spin.pitch + 0.4 * (pitch / dt);
    }
  }

  /** Stop carrying velocity (pointer held still before release). */
  still(): void {
    this.spin = { yaw: 0, pitch: 0 };
    this.drift = { x: 0, z: 0 };
  }

  /**
   * Map-style drag: move the target so the ground point `from` (under the pointer before) lands on `to` (under it
   * now). A move is capped at most of the view distance, so a ray grazing the horizon cannot throw the camera away.
   */
  grab(from: V3, to: V3, dt = 0): void {
    this.cancel();
    let dx = from[0] - to[0];
    let dz = from[2] - to[2];
    const max = this.goal.dist * 0.5;
    const m = Math.hypot(dx, dz);
    if (m > max) (dx *= max / m), (dz *= max / m);
    this.goal.x += dx;
    this.goal.z += dz;
    this.clampTarget();
    if (dt > 0) {
      this.drift.x = 0.6 * this.drift.x + 0.4 * (dx / dt);
      this.drift.z = 0.6 * this.drift.z + 0.4 * (dz / dt);
      // A fling glides about one view-width at most: fast flicks never throw the city out of sight.
      const cap = this.goal.dist * 1.2;
      const v = Math.hypot(this.drift.x, this.drift.z);
      if (v > cap) (this.drift.x *= cap / v), (this.drift.z *= cap / v);
    }
  }

  /** Twist (two-finger rotate), radians; positive turns the scene clockwise on screen. */
  turn(rad: number): void {
    this.cancel();
    this.goal.yaw += rad;
  }

  /**
   * Keyboard driving: held keys ease the camera up to speed and back to rest instead of stepping it. Speeds scale
   * with the view distance, so moving feels the same zoomed in or out. Call every frame, with zeros when idle.
   */
  drive(input: Drive, dt: number, fast = false): void {
    const k = 1 - Math.exp(-dt * 7);
    let moving = false;
    for (const key of ['fwd', 'strafe', 'turn', 'tilt', 'zoom'] as const) {
      this.vel[key] += (input[key] * (fast ? 2 : 1) - this.vel[key]) * k;
      if (Math.abs(this.vel[key]) < 1e-3) this.vel[key] = 0;
      else moving = true;
      if (input[key]) this.cancel();
    }
    if (!moving) return;
    const v = this.vel;
    const move = this.goal.dist * 0.7 * dt;
    const { yaw } = this.goal;
    this.goal.x += (-Math.sin(yaw) * v.fwd + Math.cos(yaw) * v.strafe) * move;
    this.goal.z += (-Math.cos(yaw) * v.fwd - Math.sin(yaw) * v.strafe) * move;
    this.clampTarget();
    this.goal.yaw += v.turn * 1.3 * dt;
    this.goal.pitch = clamp(this.goal.pitch + v.tilt * 0.8 * dt, PITCH_MIN, PITCH_MAX);
    this.goal.dist = clamp(this.goal.dist * Math.exp(v.zoom * 1.4 * dt), this.minDist, this.maxDist);
  }

  pan(dx: number, dy: number): void {
    this.cancel();
    const s = this.goal.dist * 0.0016;
    const { yaw } = this.goal;
    this.goal.x -= (Math.cos(yaw) * dx + Math.sin(yaw) * dy) * s;
    this.goal.z += (Math.sin(yaw) * dx - Math.cos(yaw) * dy) * s;
    this.clampTarget();
  }

  zoom(factor: number): void {
    this.cancel();
    this.goal.dist = clamp(this.goal.dist * factor, this.minDist, this.maxDist);
  }

  /**
   * Zoom toward the cursor: the ground point under the cursor stays under the cursor. `ray` is the world-space
   * direction through the cursor from the current camera position.
   */
  zoomAt(factor: number, eye: V3, ray: V3): void {
    this.cancel();
    const f = clamp(this.goal.dist * factor, this.minDist, this.maxDist) / this.goal.dist;
    if (ray[1] < -1e-3) {
      const t = (this.goal.y - eye[1]) / ray[1];
      const hit: V3 = [eye[0] + ray[0] * t, this.goal.y, eye[2] + ray[2] * t];
      this.goal.x = hit[0] + (this.goal.x - hit[0]) * f;
      this.goal.z = hit[2] + (this.goal.z - hit[2]) * f;
    }
    this.goal.dist *= f;
    this.clampTarget();
  }

  private clampTarget(): void {
    const r = Math.hypot(this.goal.x, this.goal.z);
    if (r > this.bound) {
      this.goal.x *= this.bound / r;
      this.goal.z *= this.bound / r;
    }
  }

  private clampOrbit(o: Orbit): Orbit {
    o.pitch = clamp(o.pitch, PITCH_MIN, PITCH_MAX);
    o.dist = clamp(o.dist, this.minDist, this.maxDist);
    return o;
  }

  pose(): { pos: V3; tgt: V3 } {
    const c = this.cur;
    const cp = Math.cos(c.pitch);
    const pos: V3 = [c.x + Math.sin(c.yaw) * cp * c.dist, c.y + Math.sin(c.pitch) * c.dist, c.z + Math.cos(c.yaw) * cp * c.dist];
    pos[1] = Math.max(1.2, pos[1]); // never into the water
    return { pos, tgt: [c.x, c.y, c.z] };
  }
}

export function buildCamera(pos: V3, tgt: V3, width: number, height: number, far: number, fovDeg = 50, near = 0.4): Camera {
  const aspect = width / Math.max(1, height);
  const fov = ((aspect < 1 ? fovDeg + 20 : fovDeg) * Math.PI) / 180; // portrait screens need a wider view
  const vp = mul(perspective(fov, aspect, near, far), lookAt(pos, tgt, [0, 1, 0]));
  const f = norm(sub(tgt, pos));
  const r = norm(cross(f, [0, 1, 0]));
  return { vp, vpR: reflectVP(vp), pos, posR: [pos[0], -pos[1], pos[2]], right: r, up: cross(r, f), fwd: f, tanH: Math.tan(fov / 2), near, far };
}

/** World-space ray through a canvas point (CSS px) for the given camera. */
export function rayThrough(C: Camera, x: number, y: number, w: number, h: number): V3 {
  const aspect = w / Math.max(1, h);
  const nx = (x / w) * 2 - 1;
  const ny = 1 - (y / h) * 2;
  return norm([
    C.fwd[0] + (nx * aspect * C.tanH) * C.right[0] + ny * C.tanH * C.up[0],
    C.fwd[1] + (nx * aspect * C.tanH) * C.right[1] + ny * C.tanH * C.up[1],
    C.fwd[2] + (nx * aspect * C.tanH) * C.right[2] + ny * C.tanH * C.up[2],
  ]);
}

/** Orbit parameters that reproduce a given pose, so switching from a scripted camera to orbit never pops. */
export function orbitFromPose(pos: V3, tgt: V3): Orbit {
  const dx = pos[0] - tgt[0];
  const dy = pos[1] - tgt[1];
  const dz = pos[2] - tgt[2];
  const dist = Math.max(1e-3, Math.hypot(dx, dy, dz));
  return { yaw: Math.atan2(dx, dz), pitch: Math.asin(clamp(dy / dist, -1, 1)), dist, x: tgt[0], y: tgt[1], z: tgt[2] };
}
