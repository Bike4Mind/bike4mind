import { describe, it, expect } from 'vitest';
import { computeSoundUsdCost, estimateSoundCreditCost } from './soundPricing';

const USD_PER_SECOND = 0.12 / 60;

describe('computeSoundUsdCost', () => {
  it('prices by the requested duration in seconds', () => {
    expect(computeSoundUsdCost('elevenlabs', { durationSeconds: 10 })).toEqual({
      usdCost: 10 * USD_PER_SECOND,
      billedSeconds: 10,
    });
  });

  it('bills the auto-duration default when no duration is requested (not free)', () => {
    const { usdCost, billedSeconds } = computeSoundUsdCost('elevenlabs', {});
    expect(billedSeconds).toBeCloseTo(200 / 11, 6);
    expect(usdCost).toBeGreaterThan(0);
  });
});

describe('estimateSoundCreditCost', () => {
  it('scales with duration', () => {
    expect(estimateSoundCreditCost('elevenlabs', { durationSeconds: 30 })).toBeGreaterThan(
      estimateSoundCreditCost('elevenlabs', { durationSeconds: 1 })
    );
  });

  it('never estimates below the 1-credit floor', () => {
    expect(estimateSoundCreditCost('elevenlabs', { durationSeconds: 0.5 })).toBeGreaterThanOrEqual(1);
  });
});
