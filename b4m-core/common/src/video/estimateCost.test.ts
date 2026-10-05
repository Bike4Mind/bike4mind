import { describe, expect, it } from 'vitest';
import { usdToCredits } from '../pricing';
import type { VideoModelCapabilities } from './types';
import type { VideoGenerationRequest } from './request';
import { estimateVideoCostCredits, estimateVideoCostUsd } from './estimateCost';

const perSecond: VideoModelCapabilities = {
  provider: 'test',
  displayName: 'Per second',
  modes: ['text_to_video'],
  duration: { kind: 'range', min: 3, max: 10, step: 1 },
  aspectRatios: ['16:9'],
  resolutions: ['720p', '1080p'],
  defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
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
