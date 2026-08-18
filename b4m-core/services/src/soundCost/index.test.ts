import { describe, expect, it } from 'vitest';
import { computeSoundUsdCost, estimateSoundCredits, UnsupportedSoundVendorError } from './index';

describe('computeSoundUsdCost (elevenlabs)', () => {
  it('bills a custom duration at $0.12/minute', () => {
    // 30s => 0.5 min => $0.06
    expect(computeSoundUsdCost('elevenlabs', { durationSeconds: 30 })).toBeCloseTo(0.06, 6);
    // 3s => $0.006
    expect(computeSoundUsdCost('elevenlabs', { durationSeconds: 3 })).toBeCloseTo(0.006, 6);
  });

  it('bills an omitted duration at the auto-duration equivalent (~18.2s)', () => {
    const cost = computeSoundUsdCost('elevenlabs', {});
    // (200/11) seconds * $0.002/s ~= $0.0364
    expect(cost).toBeCloseTo((200 / 11) * (0.12 / 60), 6);
  });

  it('throws for an unknown vendor', () => {
    expect(() => computeSoundUsdCost('nope' as 'elevenlabs', {})).toThrow(UnsupportedSoundVendorError);
  });
});

describe('estimateSoundCredits', () => {
  it('converts USD to credits (round-up, min 1) at the platform rate', () => {
    // $0.006 * 2000 credits/USD = 12 credits
    expect(estimateSoundCredits('elevenlabs', { durationSeconds: 3 })).toEqual({
      requiredCredits: 12,
      usdCost: expect.closeTo(0.006, 6),
      billedSeconds: 3,
    });
  });

  it('reports the auto-duration default as billedSeconds when no duration is given', () => {
    // billedSeconds must match what the cost was computed on, so usage-event
    // units stay consistent with costUsd for auto-duration calls.
    const { billedSeconds, usdCost } = estimateSoundCredits('elevenlabs', {});
    expect(billedSeconds).toBeCloseTo(200 / 11, 6);
    expect(usdCost).toBeCloseTo((200 / 11) * (0.12 / 60), 6);
  });

  it('never charges below 1 credit', () => {
    const { requiredCredits } = estimateSoundCredits('elevenlabs', { durationSeconds: 0.5 });
    expect(requiredCredits).toBeGreaterThanOrEqual(1);
  });
});
