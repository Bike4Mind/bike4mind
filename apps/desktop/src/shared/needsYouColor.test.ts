import { describe, expect, it } from 'vitest';
import {
  NEEDS_YOU_AMBER,
  NEEDS_YOU_MIN_DELTA_E,
  contrastRatio,
  deltaE,
  looksLikeNeedsYou,
  needsYouLookalikeKeys,
} from './needsYouColor';

describe('looksLikeNeedsYou', () => {
  it.each([
    ['the exact amber', NEEDS_YOU_AMBER, true],
    ['a near amber', '#f0c050', true],
    ['a saturated gold', '#ffcc00', true],
    ['the built-in working orange', '#ff9d3c', false],
    ['a clearly different blue', '#3cc8ff', false],
  ])('%s (%s): %s', (_label, color, expected) => {
    expect(looksLikeNeedsYou(color)).toBe(expected);
  });

  it('measures distance in Lab, symmetric and zero for the same colour', () => {
    expect(deltaE(NEEDS_YOU_AMBER, NEEDS_YOU_AMBER)).toBe(0);
    expect(deltaE('#f0c050', NEEDS_YOU_AMBER)).toBeCloseTo(deltaE(NEEDS_YOU_AMBER, '#f0c050'));
    expect(deltaE('#ff9d3c', NEEDS_YOU_AMBER)).toBeGreaterThan(NEEDS_YOU_MIN_DELTA_E);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white, 1 for a colour on itself, and symmetric', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrastRatio('#3cc8ff', '#3cc8ff')).toBe(1);
    expect(contrastRatio('#0f1a24', '#f0f4f8')).toBeCloseTo(contrastRatio('#f0f4f8', '#0f1a24'));
  });
});

describe('needsYouLookalikeKeys', () => {
  it('names each state and surface key too close to the amber, not the needs-you state itself', () => {
    const keys = needsYouLookalikeKeys({
      states: { 'needs-you': NEEDS_YOU_AMBER, working: '#f0c050', done: '#b48cff' },
      surfaces: { stage: '#0f1a24', card: NEEDS_YOU_AMBER },
    });
    expect(keys).toEqual(['states.working', 'surfaces.card']);
  });

  it('is empty for a skin with no colours', () => {
    expect(needsYouLookalikeKeys({})).toEqual([]);
  });
});
