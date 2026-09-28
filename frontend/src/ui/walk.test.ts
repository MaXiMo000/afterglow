import { describe, expect, it } from 'vitest';
import { CELL, INST, type World } from '../world/build';
import { RADIUS, Walker } from './walk';

/** One 1x1 building centred in the cell at (0.8, 0.8), born at history time `birth`. */
function world(birth = 0): World {
  const inst = new Float32Array(INST);
  inst.set([CELL / 2, CELL / 2, 1, 1, 5, birth]);
  return { inst, radius: 50 } as unknown as World;
}
const still = { forward: 0, strafe: 0, turn: 0, look: 0, run: false };

describe('Walker', () => {
  it('cannot walk through a building', () => {
    const w = new Walker(world(), CELL / 2, 5, 0); // south of it, facing -z (towards it)
    for (let i = 0; i < 60; i++) w.step(1 / 30, { ...still, forward: 1 }, 1);
    expect(w.z).toBeCloseTo(CELL / 2 + 0.5 + RADIUS, 5); // stopped at the wall
  });
  it('slides along a wall when walking into it at an angle', () => {
    const w = new Walker(world(), CELL / 2 + 0.3, 2, Math.PI / 12); // heading mostly -z, a little -x
    for (let i = 0; i < 20; i++) w.step(1 / 30, { ...still, forward: 1 }, 1); // 2 units: ~0.6 to the wall
    expect(w.z).toBeCloseTo(CELL / 2 + 0.5 + RADIUS, 5); // held at the wall...
    expect(w.x).toBeLessThan(CELL / 2 + 0.3 - 0.4); // ...while still moving along it
  });
  it('is not blocked by a building that does not exist yet at this time', () => {
    const w = new Walker(world(0.8), CELL / 2, 5, 0);
    for (let i = 0; i < 60; i++) w.step(1 / 30, { ...still, forward: 1 }, 0.5);
    expect(w.z).toBeLessThan(0);
  });
  it('a big frame does not tunnel through', () => {
    const w = new Walker(world(), CELL / 2, 2, 0);
    w.step(0.5, { ...still, forward: 1, run: true }, 1); // 4.5 units in one step
    expect(w.z).toBeGreaterThan(CELL / 2);
  });
  it('looks along its heading', () => {
    const { pos, tgt } = new Walker(world(), 0, 0, 0).pose();
    expect(tgt[2]).toBeLessThan(pos[2]);
  });
});
