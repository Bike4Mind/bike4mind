import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../apiErrorCodes';
import { assertContractConventions } from '../api-contract/assertContractConventions';
import {
  cancelImageJobContract,
  createImageJobContract,
  getImageJobContract,
  listImageJobsContract,
} from '../api-contract/contracts/imageJob.contract';
import { GENERATION_JOB_ERROR_CODES } from '../types/entities/GenerationJobTypes';
import { IMAGE_VALIDATION_ERROR_CODES } from '../image/validate';
import {
  CreateImageJobBodySchema,
  IMAGE_JOB_API_ERROR_CODES,
  IMAGE_JOB_COUNT_MAX,
  IMAGE_JOB_PUBLIC_ERROR_CODES,
  ImageJobSchema,
  ListImageJobsQuerySchema,
  toPublicImageJobErrorCode,
} from './imageJobs';

describe('image job wire schemas', () => {
  it('puts every image error code in the shared vocabulary', () => {
    for (const code of [...IMAGE_VALIDATION_ERROR_CODES, ...IMAGE_JOB_API_ERROR_CODES]) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });

  it('accepts a minimal body and leaves defaults to the server', () => {
    expect(CreateImageJobBodySchema.parse({ model: 'gpt-image-2', mode: 'generate', prompt: 'a bicycle' })).toEqual({
      model: 'gpt-image-2',
      mode: 'generate',
      prompt: 'a bicycle',
    });
  });

  it('rejects unknown keys, camelCase fields and a count over the cap', () => {
    const body = { model: 'm', mode: 'generate', prompt: 'p' };
    const unknownKey = CreateImageJobBodySchema.safeParse({ ...body, callbackUrl: 'https://x.test' });
    expect(unknownKey.success).toBe(false);
    expect(unknownKey.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['callbackUrl'] });
    expect(CreateImageJobBodySchema.safeParse({ ...body, aspectRatio: '1:1' }).success).toBe(false);
    expect(CreateImageJobBodySchema.safeParse({ ...body, count: IMAGE_JOB_COUNT_MAX }).success).toBe(true);
    expect(CreateImageJobBodySchema.safeParse({ ...body, count: IMAGE_JOB_COUNT_MAX + 1 }).success).toBe(false);
  });

  it('extends pagination with state and source filters', () => {
    expect(ListImageJobsQuerySchema.parse({ limit: '10', state: 'succeeded', source: 'api' })).toEqual({
      limit: 10,
      state: 'succeeded',
      source: 'api',
    });
    expect(ListImageJobsQuerySchema.safeParse({ state: 'done' }).success).toBe(false);
  });

  it('satisfies the public API conventions', () => {
    expect(() =>
      assertContractConventions([
        createImageJobContract,
        getImageJobContract,
        listImageJobsContract,
        cancelImageJobContract,
      ])
    ).not.toThrow();
  });

  it('puts every public job error code in the shared vocabulary', () => {
    for (const code of IMAGE_JOB_PUBLIC_ERROR_CODES) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });

  describe('toPublicImageJobErrorCode', () => {
    it.each(['orphaned_submit', 'enqueue_failed'] as const)('maps %s to provider_error', code => {
      expect(toPublicImageJobErrorCode(code)).toBe('provider_error');
    });

    it('maps account_blocked to cancelled', () => {
      expect(toPublicImageJobErrorCode('account_blocked')).toBe('cancelled');
    });

    it.each(IMAGE_JOB_PUBLIC_ERROR_CODES)('passes the public code %s through unchanged', code => {
      expect(toPublicImageJobErrorCode(code)).toBe(code);
    });

    it.each(GENERATION_JOB_ERROR_CODES)('maps %s into the public set', code => {
      expect(IMAGE_JOB_PUBLIC_ERROR_CODES).toContain(toPublicImageJobErrorCode(code));
    });
  });

  const job = {
    id: 'x',
    object: 'image_generation',
    state: 'failed',
    model: 'm',
    mode: 'generate',
    prompt: 'p',
    group_id: null,
    source: 'api',
    error: null,
    output: null,
    credits: { reserved: 1, settled: null },
    created_at: 'a',
    updated_at: 'b',
  };

  it('rejects an internal-only error code on the job resource', () => {
    expect(ImageJobSchema.safeParse({ ...job, error: { code: 'orphaned_submit', message: 'm' } }).success).toBe(false);
    expect(ImageJobSchema.safeParse({ ...job, error: { code: 'provider_error', message: 'm' } }).success).toBe(true);
  });
});
