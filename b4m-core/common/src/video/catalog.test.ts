import { describe, expect, it } from 'vitest';
import { VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS } from './catalog';
import type { VideoGenerationRequest } from './request';
import type { DurationCapability } from './types';
import { validateAgainstCapabilities } from './validate';
import { estimateVideoCostUsd } from './estimateCost';

const declaredDurations = (duration: DurationCapability): number[] => {
  if (duration.kind === 'discrete') return [...duration.values];
  const count = Math.round((duration.max - duration.min) / duration.step);
  return Array.from({ length: count + 1 }, (_, i) => duration.min + i * duration.step);
};

// Guards every future declaration: a model must accept its own defaults and price every
// resolution/duration it declares, or the studio would offer an option the server rejects.
describe.each(VIDEO_MODEL_IDS)('catalog entry %s', id => {
  const caps = VIDEO_MODEL_CATALOG[id];

  it('accepts its own defaults', () => {
    const result = validateAgainstCapabilities(
      { model: id, mode: 'text_to_video', prompt: 'p', ...caps.defaults },
      caps.modes.includes('text_to_video') ? caps : { ...caps, modes: [...caps.modes, 'text_to_video'] }
    );
    expect(result.ok).toBe(true);
  });

  it('prices every declared duration at every declared resolution', () => {
    for (const durationSeconds of declaredDurations(caps.duration)) {
      for (const resolution of caps.resolutions) {
        const usd = estimateVideoCostUsd(caps, {
          model: id,
          mode: 'text_to_video',
          prompt: 'p',
          ...caps.defaults,
          durationSeconds,
          resolution,
        });
        expect(usd, `${durationSeconds}s at ${resolution}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('gemini-omni-1.1-flash', () => {
  const caps = VIDEO_MODEL_CATALOG['gemini-omni-1.1-flash'];
  const request = (overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest => ({
    model: 'gemini-omni-1.1-flash',
    mode: 'text_to_video',
    prompt: 'a lighthouse at dusk',
    durationSeconds: 6,
    aspectRatio: '16:9',
    resolution: '720p',
    ...overrides,
  });

  it('declares the Omni Flash capabilities', () => {
    expect(caps).toEqual({
      provider: 'gemini-omni',
      displayName: 'Gemini Omni Flash',
      modes: ['text_to_video', 'image_to_video'],
      duration: { kind: 'range', min: 3, max: 10, step: 1 },
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p'],
      defaults: { durationSeconds: 6, aspectRatio: '16:9', resolution: '720p' },
      audio: 'always',
      pricing: { unit: 'per_second', usdByResolution: { '720p': 0.1014 } },
      defaultEnabled: false,
    });
  });

  it('prices a 6s clip at the per-second rate', () => {
    expect(estimateVideoCostUsd(caps, request())).toBeCloseTo(0.6084, 6);
  });

  it.each([2, 11])('rejects %ss', seconds => {
    const result = validateAgainstCapabilities(request({ durationSeconds: seconds }), caps);
    expect(result).toMatchObject({ ok: false, code: 'unsupported_duration' });
  });

  it('rejects 1080p and 1:1', () => {
    expect(validateAgainstCapabilities(request({ resolution: '1080p' }), caps)).toMatchObject({
      ok: false,
      code: 'unsupported_resolution',
    });
    expect(validateAgainstCapabilities(request({ aspectRatio: '1:1' }), caps)).toMatchObject({
      ok: false,
      code: 'unsupported_aspect_ratio',
    });
  });
});
