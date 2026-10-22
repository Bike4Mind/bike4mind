import { describe, expect, it } from 'vitest';
import type { VideoModelCapabilities } from './types';
import {
  videoRequestInputs,
  VideoGenerationRequestSchema,
  type VideoGenerationRequest,
  type VideoInput,
} from './request';
import { validateAgainstCapabilities } from './validate';

const rangeCaps: VideoModelCapabilities = {
  provider: 'test',
  displayName: 'Range',
  modes: ['text_to_video', 'image_to_video'],
  inputs: { first_frame: { max: 1 }, reference: { max: 2 } },
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
  inputs: {},
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

  it('accepts a generated image key as the image_to_video input', () => {
    expect(
      validateAgainstCapabilities({ ...base, mode: 'image_to_video', inputGeneratedImageKey: 'k.png' }, rangeCaps)
    ).toMatchObject({ ok: true });
  });

  it('rejects image_to_video with both a file id and a generated key', () => {
    expect(
      validateAgainstCapabilities(
        { ...base, mode: 'image_to_video', inputImageFileId: 'f1', inputGeneratedImageKey: 'k.png' },
        rangeCaps
      )
    ).toMatchObject({ ok: false, code: 'unexpected_input_image' });
  });

  it('rejects a generated image key on text_to_video', () => {
    expect(validateAgainstCapabilities({ ...base, inputGeneratedImageKey: 'k.png' }, rangeCaps)).toMatchObject({
      ok: false,
      code: 'unexpected_input_image',
      message: 'a first_frame input is only valid for image_to_video',
    });
  });

  it('rejects an audio toggle when the model does not make audio optional', () => {
    expect(validateAgainstCapabilities({ ...base, audio: false, durationSeconds: 4 }, discreteCaps)).toMatchObject({
      ok: false,
      code: 'unsupported_audio_option',
    });
  });
});

describe('validateAgainstCapabilities with role-tagged inputs', () => {
  const imageToVideo: VideoGenerationRequest = { ...base, mode: 'image_to_video' };

  it('accepts inputs whose roles and counts the model declares', () => {
    const inputs: VideoInput[] = [
      { role: 'first_frame', fileId: 'f1' },
      { role: 'reference', fileId: 'r1' },
      { role: 'reference', generatedImageKey: 'k.png' },
    ];
    expect(validateAgainstCapabilities({ ...imageToVideo, inputs }, rangeCaps)).toMatchObject({ ok: true });
  });

  it('requires a first_frame for image_to_video even when other inputs are set', () => {
    expect(
      validateAgainstCapabilities({ ...imageToVideo, inputs: [{ role: 'reference', fileId: 'r1' }] }, rangeCaps)
    ).toEqual({ ok: false, code: 'missing_input_image', message: 'image_to_video requires a first_frame input' });
  });

  it('rejects a frame input on text_to_video', () => {
    expect(validateAgainstCapabilities({ ...base, inputs: [{ role: 'last_frame', fileId: 'f2' }] }, rangeCaps)).toEqual(
      {
        ok: false,
        code: 'unexpected_input_image',
        message: 'a last_frame input is only valid for image_to_video',
      }
    );
  });

  it('accepts a non-frame input on text_to_video when the model takes that role', () => {
    expect(
      validateAgainstCapabilities({ ...base, inputs: [{ role: 'reference', fileId: 'r1' }] }, rangeCaps)
    ).toMatchObject({ ok: true });
  });

  it('rejects a role the model does not declare and names the roles it takes', () => {
    const inputs: VideoInput[] = [
      { role: 'first_frame', fileId: 'f1' },
      { role: 'style', fileId: 's1' },
    ];
    expect(validateAgainstCapabilities({ ...imageToVideo, inputs }, rangeCaps)).toEqual({
      ok: false,
      code: 'unsupported_input_role',
      message: 'Range does not accept a style input (accepted: first_frame, reference)',
    });
  });

  it('rejects more inputs of a role than the model takes', () => {
    const inputs: VideoInput[] = [
      { role: 'first_frame', fileId: 'f1' },
      { role: 'first_frame', fileId: 'f2' },
    ];
    expect(validateAgainstCapabilities({ ...imageToVideo, inputs }, rangeCaps)).toEqual({
      ok: false,
      code: 'unsupported_input_role',
      message: 'Range accepts at most 1 first_frame input(s)',
    });
  });

  it('says so when the model takes no input images at all', () => {
    expect(
      validateAgainstCapabilities({ ...base, inputs: [{ role: 'reference', fileId: 'r1' }] }, discreteCaps)
    ).toEqual({
      ok: false,
      code: 'unsupported_input_role',
      message: 'Range does not accept a reference input (it takes no input images)',
    });
  });

  it('rejects mixing inputs with the legacy single-image fields', () => {
    expect(
      validateAgainstCapabilities(
        { ...imageToVideo, inputImageFileId: 'f1', inputs: [{ role: 'first_frame', fileId: 'f1' }] },
        rangeCaps
      )
    ).toMatchObject({ ok: false, code: 'unexpected_input_image' });
  });
});

describe('videoRequestInputs', () => {
  it('reads a legacy file id as a first_frame input', () => {
    expect(videoRequestInputs({ inputImageFileId: 'f1' })).toEqual([{ role: 'first_frame', fileId: 'f1' }]);
  });

  it('reads a legacy generated key as a first_frame input', () => {
    expect(videoRequestInputs({ inputGeneratedImageKey: 'k.png' })).toEqual([
      { role: 'first_frame', generatedImageKey: 'k.png' },
    ]);
  });

  it('returns inputs as given, and nothing for a text-only request', () => {
    const inputs: VideoInput[] = [{ role: 'reference', fileId: 'r1' }];
    expect(videoRequestInputs({ inputs })).toBe(inputs);
    expect(videoRequestInputs({})).toEqual([]);
  });
});

describe('VideoGenerationRequestSchema inputs', () => {
  const parse = (inputs: unknown) =>
    VideoGenerationRequestSchema.safeParse({ ...base, mode: 'image_to_video', inputs });

  it('accepts a file input and a generated-key input', () => {
    expect(
      parse([
        { role: 'first_frame', fileId: 'f1' },
        { role: 'reference', generatedImageKey: 'k.png' },
      ]).success
    ).toBe(true);
  });

  it('rejects an input naming both a file id and a generated key', () => {
    expect(parse([{ role: 'first_frame', fileId: 'f1', generatedImageKey: 'k.png' }]).success).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(parse([{ role: 'mask', fileId: 'f1' }]).success).toBe(false);
  });

  it('still parses a stored legacy request', () => {
    expect(
      VideoGenerationRequestSchema.safeParse({ ...base, mode: 'image_to_video', inputImageFileId: 'f1' }).success
    ).toBe(true);
  });
});
