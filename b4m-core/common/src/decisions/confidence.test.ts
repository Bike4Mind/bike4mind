import { describe, expect, it } from 'vitest';
import { choiceConfidence, scoreConfidence, weightedScore } from './confidence';

// Vendors round to 2 decimals, so every comparison against a vendor value allows 0.01.
const VENDOR_TOLERANCE = 0.01;

describe('choiceConfidence', () => {
  it.each([
    { source: 'OpenAI docs', probabilities: [0.95, 0.02, 0.01, 0.02], vendor: 0.93 },
    { source: 'OpenAI live', probabilities: [0.99, 0.01, 0], vendor: 0.99 },
    { source: 'Jev live n=3', probabilities: [0.98, 0.01, 0.01], vendor: 0.97 },
    { source: 'Jev live n=2', probabilities: [0.98, 0.02], vendor: 0.96 },
  ])('reproduces $source within 0.01', ({ probabilities, vendor }) => {
    expect(Math.abs(choiceConfidence(probabilities) - vendor)).toBeLessThanOrEqual(VENDOR_TOLERANCE);
  });

  it('is 0 for a uniform distribution and 1 for a certain one', () => {
    expect(choiceConfidence([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0);
    expect(choiceConfidence([0, 1, 0])).toBe(1);
  });
});

describe('scoreConfidence', () => {
  it.each([
    { source: 'TypeSafe docs', probabilities: [0.1, 0.7, 0.2], vendor: 0.55 },
    { source: 'OpenAI live', probabilities: [0.36, 0.64, 0], vendor: 0.46 },
    { source: 'Jev live', probabilities: [0, 0.01, 0.99], vendor: 0.98 },
  ])('reproduces $source within 0.01', ({ probabilities, vendor }) => {
    expect(Math.abs(scoreConfidence(probabilities) - vendor)).toBeLessThanOrEqual(VENDOR_TOLERANCE);
  });

  it('penalises mass on a far level more than on a neighbouring one', () => {
    expect(scoreConfidence([0.2, 0.8, 0, 0])).toBeGreaterThan(scoreConfidence([0, 0.8, 0, 0.2]));
  });

  it('never leaves [0, 1], even for a uniform distribution', () => {
    expect(scoreConfidence([1 / 3, 1 / 3, 1 / 3])).toBe(0);
    expect(scoreConfidence([0.5, 0, 0.5])).toBe(0);
  });
});

describe('weightedScore', () => {
  it('is the probability-weighted mean of level indices', () => {
    expect(weightedScore([0.1, 0.7, 0.2])).toBeCloseTo(1.1);
  });
});
