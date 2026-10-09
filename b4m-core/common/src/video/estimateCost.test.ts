import { describe, expect, it } from 'vitest';
import { usdToCredits } from '../pricing';
import type { VideoModelCapabilities } from './types';
import type { VideoGenerationRequest } from './request';
import { billedVideoRequest, estimateVideoCostCredits, estimateVideoCostUsd } from './estimateCost';

const perSecond: VideoModelCapabilities = {
  provider: 'test',
  displayName: 'Per second',
  modes: ['text_to_video'],
  duration: { kind: 'range', min: 3, max: 10, step: 1 },
  aspectRatios: ['16:9'],
  resolutions: ['720p', '1080p'],
  defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
  typicalRenderSeconds: 8,
  audio: 'none',
  pricing: { unit: 'per_second', usdByResolution: { '720p': 0.1, '1080p': 0.25 } },
  defaultEnabled: true,
};
const perClip: VideoModelCapabilities = {
  ...perSecond,
  duration: { kind: 'discrete', values: [6, 10] },
  pricing: {
    unit: 'per_clip',
    clips: [
      { durationSeconds: 6, resolution: '720p', usd: 0.28 },
      { durationSeconds: 10, resolution: '720p', usd: 0.56 },
    ],
  },
};
const request = (overrides: Partial<VideoGenerationRequest>): VideoGenerationRequest => ({
  model: 'test-video',
  mode: 'text_to_video',
  prompt: 'p',
  durationSeconds: 4,
  aspectRatio: '16:9',
  resolution: '720p',
  ...overrides,
});

describe('estimateVideoCostUsd', () => {
  it('multiplies the per-second rate for the resolution by the duration', () => {
    expect(estimateVideoCostUsd(perSecond, request({ durationSeconds: 8, resolution: '1080p' }))).toBeCloseTo(2);
  });

  it('looks up the exact per-clip price', () => {
    expect(estimateVideoCostUsd(perClip, request({ durationSeconds: 10 }))).toBeCloseTo(0.56);
  });

  it('throws on a per-clip combination the model does not price (a declaration bug, not user input)', () => {
    expect(() => estimateVideoCostUsd(perClip, request({ durationSeconds: 6, resolution: '1080p' }))).toThrow(
      /no per_clip price/
    );
  });
});

describe('estimateVideoCostCredits', () => {
  it('converts through usdToCredits so the shown estimate equals the held amount', () => {
    expect(estimateVideoCostCredits(perSecond, request({ durationSeconds: 5 }))).toBe(usdToCredits(0.5));
  });
});

describe('billedVideoRequest', () => {
  it('bills a reported duration the per-clip model has no clip for on the requested duration', () => {
    const requested = request({ durationSeconds: 6 });
    const billed = billedVideoRequest(perClip, requested, 6.04);
    expect(billed).toEqual(requested);
    expect(estimateVideoCostUsd(perClip, billed)).toBeCloseTo(0.28);
  });

  it('bills on the reported duration when the model accepts it', () => {
    expect(billedVideoRequest(perSecond, request({ durationSeconds: 8 }), 5).durationSeconds).toBe(5);
  });

  it('ignores a reported duration outside the model range', () => {
    expect(billedVideoRequest(perSecond, request({ durationSeconds: 8 }), 2).durationSeconds).toBe(8);
  });

  it('uses the requested duration when nothing was reported', () => {
    const requested = request({ durationSeconds: 8 });
    expect(billedVideoRequest(perSecond, requested, undefined)).toBe(requested);
  });
});
