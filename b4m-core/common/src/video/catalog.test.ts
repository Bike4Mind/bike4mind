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
      typicalRenderSeconds: 90,
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

describe('grok-imagine-video-1.5', () => {
  const caps = VIDEO_MODEL_CATALOG['grok-imagine-video-1.5'];
  const request = (overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest => ({
    model: 'grok-imagine-video-1.5',
    mode: 'text_to_video',
    prompt: 'a lighthouse at dusk',
    durationSeconds: 6,
    aspectRatio: '16:9',
    resolution: '480p',
    ...overrides,
  });

  it('declares the Grok Imagine capabilities', () => {
    expect(caps).toEqual({
      provider: 'xai',
      displayName: 'Grok Imagine Video 1.5',
      modes: ['text_to_video', 'image_to_video'],
      duration: { kind: 'range', min: 1, max: 15, step: 1 },
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
      resolutions: ['480p', '720p'],
      defaults: { durationSeconds: 6, aspectRatio: '16:9', resolution: '480p' },
      typicalRenderSeconds: 60,
      audio: 'always',
      pricing: { unit: 'per_second', usdByResolution: { '480p': 0.08, '720p': 0.14 } },
      defaultEnabled: true,
    });
  });

  it.each([
    ['480p', 0.8],
    ['720p', 1.4],
  ] as const)('prices a 10s %s clip at its per-second rate', (resolution, usd) => {
    expect(estimateVideoCostUsd(caps, request({ durationSeconds: 10, resolution }))).toBeCloseTo(usd, 6);
  });

  it.each([0, 16])('rejects %ss', seconds => {
    expect(validateAgainstCapabilities(request({ durationSeconds: seconds }), caps)).toMatchObject({
      ok: false,
      code: 'unsupported_duration',
    });
  });

  it.each([
    { durationSeconds: 1 },
    { durationSeconds: 15 },
    { aspectRatio: '3:2' as const },
    { aspectRatio: '2:3' as const },
  ])('accepts %o', overrides => {
    expect(validateAgainstCapabilities(request(overrides), caps).ok).toBe(true);
  });

  it('rejects 1080p (deferred until per-resolution pricing is confirmed) and 21:9', () => {
    expect(validateAgainstCapabilities(request({ resolution: '1080p' }), caps)).toMatchObject({
      ok: false,
      code: 'unsupported_resolution',
    });
    expect(validateAgainstCapabilities(request({ aspectRatio: '21:9' }), caps)).toMatchObject({
      ok: false,
      code: 'unsupported_aspect_ratio',
    });
  });
});

describe('veo-3.1-fast-generate-preview', () => {
  const caps = VIDEO_MODEL_CATALOG['veo-3.1-fast-generate-preview'];
  const request = (overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest => ({
    model: 'veo-3.1-fast-generate-preview',
    mode: 'text_to_video',
    prompt: 'a lighthouse at dusk',
    durationSeconds: 4,
    aspectRatio: '16:9',
    resolution: '720p',
    ...overrides,
  });

  it('declares the Veo 3.1 Fast capabilities', () => {
    expect(caps).toEqual({
      provider: 'veo',
      displayName: 'Veo 3.1 Fast',
      modes: ['text_to_video', 'image_to_video'],
      duration: { kind: 'discrete', values: [4, 6, 8] },
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p'],
      defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
      typicalRenderSeconds: 90,
      audio: 'always',
      pricing: { unit: 'per_second', usdByResolution: { '720p': 0.1 } },
      defaultEnabled: true,
    });
  });

  it('prices an 8s clip at the per-second rate', () => {
    expect(estimateVideoCostUsd(caps, request({ durationSeconds: 8 }))).toBeCloseTo(0.8, 6);
  });

  it.each([3, 5, 7, 10])('rejects %ss', seconds => {
    expect(validateAgainstCapabilities(request({ durationSeconds: seconds }), caps)).toMatchObject({
      ok: false,
      code: 'unsupported_duration',
    });
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

it('gives every model a positive typical render time', () => {
  for (const id of VIDEO_MODEL_IDS) {
    expect(VIDEO_MODEL_CATALOG[id].typicalRenderSeconds).toBeGreaterThan(0);
  }
});
