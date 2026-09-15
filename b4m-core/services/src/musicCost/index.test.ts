import { describe, expect, it } from 'vitest';
import { computeMusicUsdCost, estimateMusicCredits, UnsupportedMusicVendorError } from './index';

describe('computeMusicUsdCost (elevenlabs)', () => {
  it('bills a custom length at $0.15/minute', () => {
    // 60s => 1 min => $0.15
    expect(computeMusicUsdCost('elevenlabs', { lengthMs: 60000 })).toBeCloseTo(0.15, 6);
    // 30s => $0.075
    expect(computeMusicUsdCost('elevenlabs', { lengthMs: 30000 })).toBeCloseTo(0.075, 6);
  });

  it('bills an omitted length at the default clip length (10s)', () => {
    // 10s * $0.0025/s = $0.025
    expect(computeMusicUsdCost('elevenlabs', {})).toBeCloseTo(10 * (0.15 / 60), 6);
  });

  it('throws for an unknown vendor', () => {
    expect(() => computeMusicUsdCost('nope' as 'elevenlabs', {})).toThrow(UnsupportedMusicVendorError);
  });
});

describe('estimateMusicCredits', () => {
  it('converts USD to credits (round-up, min 1) at the platform rate', () => {
    // $0.075 * 2000 credits/USD = 150 credits
    expect(estimateMusicCredits('elevenlabs', { lengthMs: 30000 })).toEqual({
      requiredCredits: 150,
      usdCost: expect.closeTo(0.075, 6),
      billedSeconds: 30,
    });
  });

  it('reports the default clip length as billedSeconds when no length is given', () => {
    // billedSeconds must match what the cost was computed on, so usage-event
    // units stay consistent with costUsd.
    const { billedSeconds, usdCost } = estimateMusicCredits('elevenlabs', {});
    expect(billedSeconds).toBeCloseTo(10, 6);
    expect(usdCost).toBeCloseTo(10 * (0.15 / 60), 6);
  });

  it('rounds a fractional credit cost UP rather than down or to nearest', () => {
    // 3050ms -> $0.0076250 -> 15.25 raw credits. The only nearby length whose raw
    // value discriminates ceil (16) from round/floor (15), so it is what actually
    // pins the rounding mode - every whole-second length looks identical.
    expect(estimateMusicCredits('elevenlabs', { lengthMs: 3050 }).requiredCredits).toBe(16);
  });

  it('never charges below 1 credit', () => {
    // The shortest accepted clip must still cost something, or a caller can drive
    // real provider spend for free.
    const { requiredCredits } = estimateMusicCredits('elevenlabs', { lengthMs: 3000 });
    expect(requiredCredits).toBe(15);
    expect(requiredCredits).toBeGreaterThanOrEqual(1);
  });

  it('throws for an unknown vendor rather than estimating zero', () => {
    expect(() => estimateMusicCredits('nope' as 'elevenlabs', { lengthMs: 30000 })).toThrow(
      UnsupportedMusicVendorError
    );
  });
});
