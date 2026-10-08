import { describe, expect, it } from 'vitest';
import type { VideoModelCapabilities } from './types';
import type { VideoGenerationRequest } from './request';
import { validateAgainstCapabilities } from './validate';

const rangeCaps: VideoModelCapabilities = {
  provider: 'test',
  displayName: 'Range',
  modes: ['text_to_video', 'image_to_video'],
  duration: { kind: 'range', min: 3, max: 10, step: 1 },
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['720p', '1080p'],
  defaults: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' },
  typicalRenderSeconds: 8,
  audio: 'optional',
  pricing: { unit: 'per_second', usdByResolution: { '720p': 0.1, '1080p': 0.2 } },
  defaultEnabled: true,
};
const discreteCaps: VideoModelCapabilities = {
  ...rangeCaps,
  modes: ['text_to_video'],
  duration: { kind: 'discrete', values: [4, 6, 8] },
  audio: 'always',
};
const base: VideoGenerationRequest = {
  model: 'test-video',
  mode: 'text_to_video',
  prompt: 'a red bicycle',
  durationSeconds: 5,
  aspectRatio: '16:9',
  resolution: '720p',
};

describe('validateAgainstCapabilities', () => {
  it('accepts a request inside every capability', () => {
    expect(validateAgainstCapabilities(base, rangeCaps)).toMatchObject({ ok: true });
  });

  it.each([2, 11, 3.5])('rejects duration %s on a 3-10s step-1 range', durationSeconds => {
    expect(validateAgainstCapabilities({ ...base, durationSeconds }, rangeCaps)).toEqual({
      ok: false,
      code: 'unsupported_duration',
      message: expect.stringContaining('3-10'),
    });
  });

  it('rejects a duration outside the discrete set and names the allowed values', () => {
    expect(validateAgainstCapabilities({ ...base, durationSeconds: 5 }, discreteCaps)).toEqual({
      ok: false,
      code: 'unsupported_duration',
      message: expect.stringContaining('4, 6, 8'),
    });
  });

  it('rejects an aspect ratio the model does not declare', () => {
    expect(validateAgainstCapabilities({ ...base, aspectRatio: '1:1' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'unsupported_aspect_ratio',
    });
  });

  it('rejects a resolution the model does not declare', () => {
    expect(validateAgainstCapabilities({ ...base, resolution: '4k' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'unsupported_resolution',
    });
  });

  it('rejects a mode the model does not declare', () => {
    expect(
      validateAgainstCapabilities({ ...base, mode: 'image_to_video', inputImageFileId: 'f1' }, discreteCaps)
    ).toMatchObject({ ok: false, code: 'unsupported_mode' });
  });

  it('requires an input image for image_to_video', () => {
    expect(validateAgainstCapabilities({ ...base, mode: 'image_to_video' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'missing_input_image',
    });
  });

  it('rejects an input image on text_to_video rather than silently ignoring it', () => {
    expect(validateAgainstCapabilities({ ...base, inputImageFileId: 'f1' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'unexpected_input_image',
    });
  });

  it('rejects an audio toggle when the model does not make audio optional', () => {
    expect(validateAgainstCapabilities({ ...base, audio: false, durationSeconds: 4 }, discreteCaps)).toMatchObject({
      ok: false,
      code: 'unsupported_audio_option',
    });
  });
});
