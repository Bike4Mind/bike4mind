import { describe, expect, it } from 'vitest';
import { VIDEO_MODEL_CATALOG } from './catalog';
import { VideoGenerationRequestSchema, videoRequestInputs, type VideoGenerationRequest } from './request';
import { validateAgainstCapabilities } from './validate';
import { billedVideoRequest, estimateVideoCostCredits, estimateVideoCostUsd } from './estimateCost';
import { usdToCredits } from '../pricing';
import { CreateVideoGenerationBodySchema } from '../schemas/videoGenerations';

const caps = VIDEO_MODEL_CATALOG['flux-3-video'];
const request: VideoGenerationRequest = {
  model: 'flux-3-video',
  mode: 'image_to_video',
  prompt: 'p',
  durationSeconds: 5,
  aspectRatio: '16:9',
  resolution: '720p',
  draft: true,
  keyframes: [
    { fileId: 'f1', timeSeconds: 0 },
    { fileId: 'f2', timeSeconds: 5 },
  ],
};

describe('keyframes and draft', () => {
  it('preserves domain fields and exposes every image for ownership and lineage', () => {
    expect(VideoGenerationRequestSchema.parse(request)).toEqual(request);
    expect(validateAgainstCapabilities(request, caps)).toMatchObject({ ok: true });
    expect(videoRequestInputs(request)).toEqual([
      { role: 'reference', fileId: 'f1' },
      { role: 'reference', fileId: 'f2' },
    ]);
  });

  it('accepts public fields and rejects a non-boolean draft or non-file source', () => {
    const body = { model: request.model, prompt: 'p', draft: false, keyframes: [{ file_id: 'f1', time_seconds: 0 }] };
    expect(CreateVideoGenerationBodySchema.parse(body)).toEqual(body);
    expect(CreateVideoGenerationBodySchema.safeParse({ ...body, draft: 'true' }).success).toBe(false);
    expect(
      CreateVideoGenerationBodySchema.safeParse({
        ...body,
        keyframes: [{ url: 'https://example.com/a.png', time_seconds: 0 }],
      }).success
    ).toBe(false);
  });

  it('names unsupported capabilities and rejects non-HD drafts', () => {
    const unsupported = VIDEO_MODEL_CATALOG['gemini-omni-1.1-flash'];
    expect(validateAgainstCapabilities(request, unsupported)).toMatchObject({
      ok: false,
      code: 'unsupported_keyframes',
      message: expect.stringContaining('keyframes'),
    });
    expect(validateAgainstCapabilities({ ...request, keyframes: undefined }, unsupported)).toMatchObject({
      ok: false,
      code: 'unsupported_draft',
      message: expect.stringContaining('draft'),
    });
    expect(validateAgainstCapabilities({ ...request, resolution: '1080p' }, caps)).toMatchObject({
      ok: false,
      code: 'unsupported_draft',
    });
  });

  it.each(
    [
      [{ fileId: 'f1', timeSeconds: 1 }],
      [
        { fileId: 'f1', timeSeconds: 0 },
        { fileId: 'f2', timeSeconds: 0 },
      ],
      [
        { fileId: 'f1', timeSeconds: 0 },
        { fileId: 'f2', timeSeconds: 6 },
      ],
    ].map(keyframes => ({ keyframes }))
  )('rejects invalid keyframe times or count: %j', ({ keyframes }) => {
    expect(validateAgainstCapabilities({ ...request, keyframes }, caps)).toMatchObject({
      ok: false,
      code: 'invalid_keyframes',
    });
  });

  it('rejects mixed image forms and explicit text mode', () => {
    for (const extra of [
      { inputs: [] },
      { inputImageFileId: 'f3' },
      { inputGeneratedImageKey: 'k.png' },
      { mode: 'text_to_video' as const },
    ]) {
      expect(validateAgainstCapabilities({ ...request, ...extra }, caps)).toMatchObject({
        ok: false,
        code: 'invalid_keyframes',
      });
    }
  });

  it('does not advertise first-frame image mode but admits keyframes, including the model count limit', () => {
    expect(caps.modes).toEqual(['text_to_video']);
    expect(
      validateAgainstCapabilities({ ...request, keyframes: undefined, inputImageFileId: 'f1' }, caps)
    ).toMatchObject({ ok: false, code: 'unsupported_mode' });
    const keyframes = Array.from({ length: 11 }, (_, index) => ({ fileId: `f${index}`, timeSeconds: index / 2 }));
    expect(VideoGenerationRequestSchema.safeParse({ ...request, keyframes }).success).toBe(true);
    expect(
      CreateVideoGenerationBodySchema.safeParse({
        model: request.model,
        prompt: 'p',
        keyframes: keyframes.map(frame => ({ file_id: frame.fileId, time_seconds: frame.timeSeconds })),
      }).success
    ).toBe(true);
    expect(validateAgainstCapabilities({ ...request, keyframes }, caps)).toMatchObject({
      ok: false,
      code: 'invalid_keyframes',
    });
  });

  it('bills a shorter delivered keyframe clip without dropping its images or draft rate', () => {
    const requested = {
      ...request,
      durationSeconds: 8,
      keyframes: [
        { fileId: 'f1', timeSeconds: 0 },
        { fileId: 'f2', timeSeconds: 8 },
      ],
    };
    const billed = billedVideoRequest(caps, requested, 5);
    expect(billed).toEqual({ ...requested, durationSeconds: 5 });
    expect(estimateVideoCostUsd(caps, billed)).toBeCloseTo(0.3);
  });

  it('uses the draft rate for estimates, holds and settlement, and full rate for false or omitted', () => {
    expect(estimateVideoCostUsd(caps, request)).toBeCloseTo(0.3);
    expect(estimateVideoCostCredits(caps, request)).toBe(usdToCredits(0.3));
    expect(
      estimateVideoCostUsd(
        caps,
        billedVideoRequest(caps, { ...request, mode: 'text_to_video', keyframes: undefined }, 6)
      )
    ).toBeCloseTo(0.36);
    for (const draft of [false, undefined]) expect(estimateVideoCostUsd(caps, { ...request, draft })).toBeCloseTo(0.75);
    expect(() => estimateVideoCostUsd(caps, { ...request, resolution: '1080p' })).toThrow(/draft price/);
  });
});
