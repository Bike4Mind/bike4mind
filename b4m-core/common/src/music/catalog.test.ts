import { describe, expect, it } from 'vitest';
import { MUSIC_MODEL_CATALOG, MUSIC_MODEL_IDS, type MusicModelId } from './catalog';
import { estimateMusicCostUsd } from './estimateCost';
import { validateMusicRequest } from './validate';

const request = (model: MusicModelId) => ({ model, prompt: 'An upbeat folk song about a bicycle' });

describe.each(MUSIC_MODEL_IDS)('%s', id => {
  const caps = MUSIC_MODEL_CATALOG[id];

  it('accepts a bare prompt, resolving its default length', () => {
    const result = validateMusicRequest(request(id), caps);
    expect(result.ok).toBe(true);
  });

  it('declares a sane duration and a positive render time', () => {
    expect(caps.typicalRenderSeconds).toBeGreaterThan(0);
    if (caps.duration.control === 'fixed') {
      expect(caps.duration.seconds).toBeGreaterThan(0);
      return;
    }
    expect(caps.duration.min).toBeGreaterThan(0);
    expect(caps.duration.min).toBeLessThanOrEqual(caps.duration.default);
    expect(caps.duration.default).toBeLessThanOrEqual(caps.duration.max);
  });

  // A per-second price on a prompt-steered length would hold credits on a number the provider does not honour.
  it('bills per second only when the length is an exact provider parameter', () => {
    if (caps.pricing.unit === 'per_second') expect(caps.duration.control).toBe('exact');
  });

  it('has a non-negative price', () => {
    expect(caps.pricing.usd).toBeGreaterThanOrEqual(0);
  });
});

describe('published prices', () => {
  it('bills Lyria per song whatever the length', () => {
    expect(estimateMusicCostUsd(MUSIC_MODEL_CATALOG['lyria-3.5'], { durationSeconds: 180 })).toBe(0.08);
    expect(estimateMusicCostUsd(MUSIC_MODEL_CATALOG['lyria-3-clip-preview'], { durationSeconds: 30 })).toBe(0.04);
  });

  it.each(['music_v2_5', 'music_v2', 'music_v1'] as const)('bills %s at $0.15 per output minute', id => {
    expect(estimateMusicCostUsd(MUSIC_MODEL_CATALOG[id], { durationSeconds: 60 })).toBeCloseTo(0.15, 10);
  });

  it('enables the current ElevenLabs models by default and leaves v1 to an admin', () => {
    expect(MUSIC_MODEL_CATALOG.music_v2_5.defaultEnabled).toBe(true);
    expect(MUSIC_MODEL_CATALOG.music_v2.defaultEnabled).toBe(true);
    expect(MUSIC_MODEL_CATALOG.music_v1.defaultEnabled).toBe(false);
  });
});
