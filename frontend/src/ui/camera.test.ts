import { describe, expect, it } from 'vitest';
import { project } from '../render/math';
import { buildCamera, OrbitCamera, orbitFromPose, rayThrough } from './camera';

const W = 1200;
const H = 800;

describe('OrbitCamera', () => {
  it('zooms toward the cursor: the ground point under the cursor stays put', () => {
    const cam = new OrbitCamera();
    cam.frame(100);
    cam.snap();
    const { pos, tgt } = cam.pose();
    const C = buildCamera(pos, tgt, W, H, 2000);
    const cursor = { x: 900, y: 600 };
    const ray = rayThrough(C, cursor.x, cursor.y, W, H);
    const t = (tgt[1] - pos[1]) / ray[1];
    const ground: [number, number, number] = [pos[0] + ray[0] * t, tgt[1], pos[2] + ray[2] * t];
    cam.zoomAt(0.7, pos, ray);
    cam.snap();
    const after = cam.pose();
    const p = project(buildCamera(after.pos, after.tgt, W, H, 2000).vp, ground, W, H)!;
    expect(Math.abs(p.x - cursor.x)).toBeLessThan(1.5);
    expect(Math.abs(p.y - cursor.y)).toBeLessThan(1.5);
  });

  it('never flips at the poles and never goes under water', () => {
    const cam = new OrbitCamera();
    cam.frame(100);
    for (let i = 0; i < 500; i++) cam.orbit(0, 400);
    expect(cam.goal.pitch).toBeLessThan(Math.PI / 2);
    for (let i = 0; i < 500; i++) cam.orbit(0, -400);
    cam.snap();
    expect(cam.goal.pitch).toBeGreaterThan(0);
    expect(cam.pose().pos[1]).toBeGreaterThanOrEqual(1.2);
  });

  it('carries release velocity and then settles (inertia)', () => {
    const cam = new OrbitCamera();
    cam.frame(100);
    cam.snap();
    for (let i = 0; i < 5; i++) cam.orbit(-40, 0, 1 / 60);
    const released = cam.goal.yaw;
    cam.update(1 / 60, false);
    expect(cam.goal.yaw).toBeGreaterThan(released);
    for (let i = 0; i < 600; i++) cam.update(1 / 60, false);
    const settled = cam.goal.yaw;
    cam.update(1 / 60, false);
    expect(Math.abs(cam.goal.yaw - settled)).toBeLessThan(1e-4);
  });

  it('flights ease to the goal, take the short way round, and cancel on input', () => {
    const cam = new OrbitCamera();
    cam.frame(100);
    cam.snap();
    cam.flyTo({ ...cam.goal, yaw: cam.goal.yaw + 2 * Math.PI + 0.2, dist: 50 });
    expect(Math.abs(cam.goal.yaw - (cam.cur.yaw + 0.2))).toBeLessThan(1e-9);
    cam.update(0.1, false);
    expect(cam.flying).toBe(true);
    cam.orbit(10, 0);
    expect(cam.flying).toBe(false);
  });

  it('orbitFromPose reproduces the pose exactly (no pop on handover)', () => {
    const pos: [number, number, number] = [30, 20, -40];
    const tgt: [number, number, number] = [5, 2, 3];
    const cam = new OrbitCamera();
    cam.goal = orbitFromPose(pos, tgt);
    cam.snap();
    const p = cam.pose();
    p.pos.forEach((v, i) => expect(v).toBeCloseTo(pos[i]!, 9));
    p.tgt.forEach((v, i) => expect(v).toBeCloseTo(tgt[i]!, 9));
  });
});
