import { expect, it } from 'vitest';
import { KEYMAP } from './keymap';

// Held movement keys (app.ts keyMove). actionFor runs first, so an action on one of these would swallow movement.
const MOVEMENT = ['W', 'A', 'S', 'D', 'Q', 'E', '+', '=', '-'];

it('no action takes a movement key, and no key is bound twice', () => {
  const keys = KEYMAP.flatMap((d) => d.keys);
  expect(keys.filter((k) => MOVEMENT.includes(k))).toEqual([]);
  expect(new Set(keys).size).toBe(keys.length);
});
