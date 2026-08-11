import { describe, it, expect } from 'vitest';
import { ACTOR_COLOR_SLOTS, NEUTRAL_ACTOR_COLOR, actorColor, actorColorSlot } from './actorColors';

describe('actorColorSlot', () => {
  it('is a pure function of actorId, so a session keeps its color across reloads', () => {
    expect(actorColorSlot('actor-1')).toBe(actorColorSlot('actor-1'));
    expect(actorColorSlot('6540b58d1f703ade3ea1e82c')).toBe(actorColorSlot('6540b58d1f703ade3ea1e82c'));
  });

  it('stays inside the palette for every input', () => {
    for (const id of ['', 'a', 'actor-1', '6540b58d1f703ade3ea1e82c', 'x'.repeat(500)]) {
      expect(actorColorSlot(id)).toBeGreaterThanOrEqual(0);
      expect(actorColorSlot(id)).toBeLessThan(ACTOR_COLOR_SLOTS.length);
    }
  });
});

describe('actorColor', () => {
  it('falls back to the neutral rather than a palette slot when there is no actorId', () => {
    expect(actorColor('')).toBe(NEUTRAL_ACTOR_COLOR);
  });
});

/**
 * These four are the largest subset of the house categorical palette that clears
 * the all-pairs CVD and normal-vision separation gates in BOTH theme modes - a
 * log is an all-pairs problem because any two actors can post back to back.
 * Adding or editing a hex means re-running the palette validator over the whole
 * set; it is not a per-color choice. Pinned so that cannot happen by accident.
 */
describe('the validated palette', () => {
  it('is exactly the validated set, in the validated order', () => {
    expect(ACTOR_COLOR_SLOTS).toEqual([
      { light: '#2a78d6', dark: '#3987e5' },
      { light: '#eda100', dark: '#c98500' },
      { light: '#e87ba4', dark: '#d55181' },
      { light: '#008300', dark: '#008300' },
    ]);
  });

  it('never generates a hue for the overflow case - it reuses slots', () => {
    const slots = new Set(Array.from({ length: 200 }, (_, i) => actorColorSlot(`actor-${i}`)));
    expect(slots.size).toBeLessThanOrEqual(ACTOR_COLOR_SLOTS.length);
  });
});
