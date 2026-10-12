import { describe, expect, it } from 'vitest';
import { usdToCredits } from '../pricing';
import { billedMusicRequest, estimateMusicCostCredits, estimateMusicCostUsd } from './estimateCost';
import type { MusicModelCapabilities } from './types';

const withPricing = (pricing: MusicModelCapabilities['pricing']): MusicModelCapabilities => ({
  provider: 'test',
  displayName: 'Model',
  vocals: 'optional',
  lyrics: null,
  duration: { control: 'exact', min: 1, max: 300, default: 60 },
  outputFormats: ['mp3'],
  typicalRenderSeconds: 1,
  pricing,
  preview: false,
  defaultEnabled: true,
});

describe('estimateMusicCost', () => {
  it('charges a flat price per song', () => {
    expect(estimateMusicCostUsd(withPricing({ unit: 'per_song', usd: 0.08 }), { durationSeconds: 170 })).toBe(0.08);
  });

  it('charges per second of requested length', () => {
    expect(estimateMusicCostUsd(withPricing({ unit: 'per_second', usd: 0.01 }), { durationSeconds: 30 })).toBeCloseTo(
      0.3,
      10
    );
  });

  it('converts through the shared credit rate', () => {
    const caps = withPricing({ unit: 'per_song', usd: 0.08 });
    expect(estimateMusicCostCredits(caps, { durationSeconds: 60 })).toBe(usdToCredits(0.08));
  });
});

describe('billedMusicRequest', () => {
  const request = { durationSeconds: 60 };

  it('bills the reported length when shorter than requested', () => {
    expect(billedMusicRequest(request, 57.5)).toEqual({ durationSeconds: 57.5 });
  });

  it('never bills past the requested length (the hold)', () => {
    expect(billedMusicRequest(request, 61)).toEqual({ durationSeconds: 60 });
  });

  it('falls back to the requested length without a usable report', () => {
    expect(billedMusicRequest(request, undefined)).toBe(request);
    expect(billedMusicRequest(request, 0)).toBe(request);
    expect(billedMusicRequest(request, Number.NaN)).toBe(request);
  });
});
