import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../apiErrorCodes';
import { assertContractConventions } from '../api-contract/assertContractConventions';
import {
  cancelVideoGenerationContract,
  createVideoGenerationContract,
  getVideoGenerationContract,
  listVideoGenerationsContract,
  listVideoModelsContract,
} from '../api-contract/contracts/videoGeneration.contract';
import { VIDEO_VALIDATION_ERROR_CODES } from '../video/validate';
import {
  CreateVideoGenerationBodySchema,
  ListVideoGenerationsQuerySchema,
  VIDEO_GENERATION_API_ERROR_CODES,
  VIDEO_JOB_PUBLIC_ERROR_CODES,
  VIDEO_OUTPUT_AVAILABILITIES,
  VideoGenerationSchema,
  toPublicVideoJobErrorCode,
} from './videoGenerations';

describe('video generation wire schemas', () => {
  it('puts every video error code in the shared vocabulary', () => {
    for (const code of [...VIDEO_VALIDATION_ERROR_CODES, ...VIDEO_GENERATION_API_ERROR_CODES]) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });

  it('accepts a minimal body and leaves defaults to the server', () => {
    expect(CreateVideoGenerationBodySchema.parse({ model: 'gemini-omni-1.1-flash', prompt: 'a lighthouse' })).toEqual({
      model: 'gemini-omni-1.1-flash',
      prompt: 'a lighthouse',
    });
  });

  it('rejects unknown keys (e.g. the removed callbackUrl) and an over-long prompt', () => {
    const unknownKey = CreateVideoGenerationBodySchema.safeParse({
      model: 'm',
      prompt: 'p',
      callbackUrl: 'https://x.test',
    });
    expect(unknownKey.success).toBe(false);
    expect(unknownKey.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['callbackUrl'] });
    expect(CreateVideoGenerationBodySchema.safeParse({ model: 'm', prompt: 'p', durationSeconds: 5 }).success).toBe(
      false
    );
    expect(CreateVideoGenerationBodySchema.safeParse({ model: 'm', prompt: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('extends pagination with state and source filters', () => {
    expect(ListVideoGenerationsQuerySchema.parse({ limit: '10', state: 'succeeded', source: 'api' })).toEqual({
      limit: 10,
      state: 'succeeded',
      source: 'api',
    });
    expect(ListVideoGenerationsQuerySchema.safeParse({ state: 'done' }).success).toBe(false);
  });

  it('satisfies the public API conventions', () => {
    expect(() =>
      assertContractConventions([
        listVideoModelsContract,
        createVideoGenerationContract,
        getVideoGenerationContract,
        listVideoGenerationsContract,
        cancelVideoGenerationContract,
      ])
    ).not.toThrow();
  });

  it('puts every public job error code in the shared vocabulary', () => {
    for (const code of VIDEO_JOB_PUBLIC_ERROR_CODES) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });

  describe('toPublicVideoJobErrorCode', () => {
    it('maps orphaned_submit to provider_error', () => {
      expect(toPublicVideoJobErrorCode('orphaned_submit')).toBe('provider_error');
    });

    it('maps enqueue_failed to provider_error', () => {
      expect(toPublicVideoJobErrorCode('enqueue_failed')).toBe('provider_error');
    });

    it('passes a public code through unchanged', () => {
      expect(toPublicVideoJobErrorCode('content_blocked')).toBe('content_blocked');
    });
  });

  it('rejects an internal-only error code on the job resource', () => {
    const job = {
      id: 'x',
      object: 'video_generation',
      state: 'failed',
      model: 'm',
      mode: 'text_to_video',
      prompt: 'p',
      duration_seconds: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      source: 'api',
      progress: null,
      error: { code: 'orphaned_submit', message: 'm' },
      output: null,
      credits: { reserved: null, settled: null },
      created_at: 'a',
      updated_at: 'b',
    };
    expect(VideoGenerationSchema.safeParse(job).success).toBe(false);
    expect(VideoGenerationSchema.safeParse({ ...job, error: { code: 'provider_error', message: 'm' } }).success).toBe(
      true
    );
  });

  it('requires a known availability on a succeeded output', () => {
    const job = {
      id: 'x',
      object: 'video_generation',
      state: 'succeeded',
      model: 'm',
      mode: 'text_to_video',
      prompt: 'p',
      duration_seconds: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      source: 'api',
      progress: 1,
      error: null,
      credits: { reserved: 1, settled: 1 },
      created_at: 'a',
      updated_at: 'b',
    };
    const output = { url: null, expires_at: null, content_type: 'video/mp4', duration_seconds: 5, file_id: 'f' };
    for (const availability of VIDEO_OUTPUT_AVAILABILITIES) {
      expect(VideoGenerationSchema.safeParse({ ...job, output: { ...output, availability } }).success).toBe(true);
    }
    expect(VideoGenerationSchema.safeParse({ ...job, output }).success).toBe(false);
    expect(VideoGenerationSchema.safeParse({ ...job, output: { ...output, availability: 'later' } }).success).toBe(
      false
    );
  });
});
