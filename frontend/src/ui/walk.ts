/**
 * Walk mode (docs/ROADMAP.md #3): a first-person camera at street height that cannot pass through buildings.
 *
 * Every building stands in its own grid cell (world/build.ts places one file per CELL square, footprint < CELL), so
 * collision only looks at the 3x3 cells around the walker. Only buildings that exist at the current history time
 * block the way, matching what is drawn.
 */
import { clamp, type V3 } from '../render/math';
import { CELL, INST, type World } from '../world/build';

export const EYE = 1.35; // ground is at 0.28 and windows start 1 above it: eye level with the first lit floor
export const RADIUS = 0.12; // fits the narrowest gaps between neighbouring buildings (>= 0.32)
export const NEAR = 0.05; // the orbit camera's 0.4 near plane would cut through walls this close
const WALK = 3; // world units per second
const RUN = 9;
const PITCH = 1.2;

export type WalkInput = { forward: number; strafe: number; turn: number; look: number; run: boolean };

export class Walker {
  x: number;
  z: number;
  yaw: number; // same convention as OrbitCamera.walk: forward is (-sin yaw, -cos yaw)
  pitch = 0;
  private readonly grid = new Map<number, number[]>();

  constructor(
    private readonly world: World,
    x: number,
    z: number,
    yaw: number,
  ) {
    const { inst } = world;
    for (let i = 0; i < inst.length / INST; i++) {
      const key = cellKey(Math.floor(inst[i * INST]! / CELL), Math.floor(inst[i * INST + 1]! / CELL));
      const list = this.grid.get(key);
      if (list) list.push(i);
      else this.grid.set(key, [i]);
    }
    this.x = x;
    this.z = z;
    this.yaw = yaw;
  }

  /** Mouse or drag look, in pixels. */
  look(dx: number, dy: number): void {
    this.yaw -= dx * 0.0025;
    this.pitch = clamp(this.pitch - dy * 0.0025, -PITCH, PITCH);
  }

  /** Move for `dt` seconds; `t` is the normalised history time (buildings born later do not block). */
  step(dt: number, input: WalkInput, t: number): void {
    this.yaw -= input.turn * 1.8 * dt;
    this.pitch = clamp(this.pitch + input.look * 1.2 * dt, -PITCH, PITCH);
    const len = Math.hypot(input.forward, input.strafe);
    if (len > 0) {
      const s = ((input.run ? RUN : WALK) * dt) / len;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Sub-steps so a fast frame cannot tunnel through a thin building.
      const n = Math.ceil((len * s) / (RADIUS * 0.8));
      for (let k = 0; k < n; k++) {
        this.x += ((-sin * input.forward + cos * input.strafe) * s) / n;
        this.z += ((-cos * input.forward - sin * input.strafe) * s) / n;
        this.resolve(t);
      }
    }
    const bound = this.world.radius * 1.3;
    const r = Math.hypot(this.x, this.z);
    if (r > bound) {
      this.x *= bound / r;
      this.z *= bound / r;
    }
  }

  /** Push the walker out of any building it overlaps (circle vs box), sliding along walls. */
  resolve(t: number): void {
    const { inst } = this.world;
    const gx = Math.floor(this.x / CELL);
    const gz = Math.floor(this.z / CELL);
    for (let ox = -1; ox <= 1; ox++)
      for (let oz = -1; oz <= 1; oz++)
        for (const i of this.grid.get(cellKey(gx + ox, gz + oz)) ?? []) {
          const o = i * INST;
          if (inst[o + 5]! >= t) continue; // not built yet at this point in history
          const cx = inst[o]!;
          const cz = inst[o + 1]!;
          const hx = inst[o + 2]! / 2;
          const hz = inst[o + 3]! / 2;
          const px = clamp(this.x, cx - hx, cx + hx);
          const pz = clamp(this.z, cz - hz, cz + hz);
          const dx = this.x - px;
          const dz = this.z - pz;
          const d = Math.hypot(dx, dz);
          if (d >= RADIUS) continue;
          if (d > 1e-6) {
            this.x = px + (dx / d) * RADIUS;
            this.z = pz + (dz / d) * RADIUS;
          } else {
            // Centre inside the box: leave by the nearest face.
            const ex = hx - Math.abs(this.x - cx);
            const ez = hz - Math.abs(this.z - cz);
            if (ex < ez) this.x = cx + Math.sign(this.x - cx || 1) * (hx + RADIUS);
            else this.z = cz + Math.sign(this.z - cz || 1) * (hz + RADIUS);
          }
        }
  }

  /** Distance from (x, z) to the nearest building standing at time `t`, looking up to 2 cells away (else Infinity). */
  clearance(x: number, z: number, t: number): number {
    const { inst } = this.world;
    const gx = Math.floor(x / CELL);
    const gz = Math.floor(z / CELL);
    let best = Infinity;
    for (let ox = -2; ox <= 2; ox++)
      for (let oz = -2; oz <= 2; oz++)
        for (const i of this.grid.get(cellKey(gx + ox, gz + oz)) ?? []) {
          const o = i * INST;
          if (inst[o + 5]! >= t) continue;
          const dx = Math.max(Math.abs(x - inst[o]!) - inst[o + 2]! / 2, 0);
          const dz = Math.max(Math.abs(z - inst[o + 1]!) - inst[o + 3]! / 2, 0);
          best = Math.min(best, Math.hypot(dx, dz));
        }
    return best;
  }

  pose(): { pos: V3; tgt: V3 } {
    const c = Math.cos(this.pitch);
    const pos: V3 = [this.x, EYE, this.z];
    return { pos, tgt: [this.x - Math.sin(this.yaw) * c, EYE + Math.sin(this.pitch), this.z - Math.cos(this.yaw) * c] };
  }
}

const cellKey = (gx: number, gz: number): number => (gx + 4096) * 8192 + (gz + 4096);
