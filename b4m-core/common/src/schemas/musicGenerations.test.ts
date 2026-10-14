import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../apiErrorCodes';
import { assertContractConventions } from '../api-contract/assertContractConventions';
import {
  cancelMusicGenerationContract,
  createMusicGenerationContract,
  getMusicGenerationContract,
  listMusicGenerationsContract,
  listMusicModelsContract,
} from '../api-contract/contracts/musicGeneration.contract';
import { GENERATION_OUTPUT_AVAILABILITIES } from '../generation/types';
import { MUSIC_VALIDATION_ERROR_CODES } from '../music/validate';
import {
  CreateMusicGenerationBodySchema,
  ListMusicGenerationsQuerySchema,
  MUSIC_GENERATION_API_ERROR_CODES,
  MUSIC_JOB_PUBLIC_ERROR_CODES,
  MusicGenerationSchema,
  toPublicMusicJobErrorCode,
} from './musicGenerations';

describe('music generation wire schemas', () => {
  it('puts every music error code in the shared vocabulary', () => {
    for (const code of [...MUSIC_VALIDATION_ERROR_CODES, ...MUSIC_GENERATION_API_ERROR_CODES]) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });

  it('accepts a minimal body and leaves defaults to the server', () => {
    expect(CreateMusicGenerationBodySchema.parse({ model: 'lyria-3.5', prompt: 'a calm piano piece' })).toEqual({
      model: 'lyria-3.5',
      prompt: 'a calm piano piece',
    });
  });

  it('rejects unknown keys, camelCase fields and an over-long prompt', () => {
    const unknownKey = CreateMusicGenerationBodySchema.safeParse({
      model: 'm',
      prompt: 'p',
      callbackUrl: 'https://x.test',
    });
    expect(unknownKey.success).toBe(false);
    expect(unknownKey.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['callbackUrl'] });
    expect(CreateMusicGenerationBodySchema.safeParse({ model: 'm', prompt: 'p', durationSeconds: 5 }).success).toBe(
      false
    );
    expect(CreateMusicGenerationBodySchema.safeParse({ model: 'm', prompt: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('extends pagination with state and source filters', () => {
    expect(ListMusicGenerationsQuerySchema.parse({ limit: '10', state: 'succeeded', source: 'api' })).toEqual({
      limit: 10,
      state: 'succeeded',
      source: 'api',
    });
    expect(ListMusicGenerationsQuerySchema.safeParse({ state: 'done' }).success).toBe(false);
  });

  it('satisfies the public API conventions', () => {
    expect(() =>
      assertContractConventions([
        listMusicModelsContract,
        createMusicGenerationContract,
        getMusicGenerationContract,
        listMusicGenerationsContract,
        cancelMusicGenerationContract,
      ])
    ).not.toThrow();
  });

  it('puts every public job error code in the shared vocabulary', () => {
    for (const code of MUSIC_JOB_PUBLIC_ERROR_CODES) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });

  describe('toPublicMusicJobErrorCode', () => {
    it.each(['orphaned_submit', 'enqueue_failed', 'input_image_not_found'] as const)(
      'maps %s to provider_error',
      code => {
        expect(toPublicMusicJobErrorCode(code)).toBe('provider_error');
      }
    );

    it.each(MUSIC_JOB_PUBLIC_ERROR_CODES)('passes the public code %s through unchanged', code => {
      expect(toPublicMusicJobErrorCode(code)).toBe(code);
    });
  });

  const job = {
    id: 'x',
    object: 'music_generation',
    state: 'succeeded',
    model: 'm',
    prompt: 'p',
    lyrics: null,
    instrumental: false,
    duration_seconds: 5,
    source: 'api',
    error: null,
    output: null,
    credits: { reserved: 1, settled: 1 },
    created_at: 'a',
    updated_at: 'b',
  };

  it('rejects an internal-only error code on the job resource', () => {
    expect(MusicGenerationSchema.safeParse({ ...job, error: { code: 'orphaned_submit', message: 'm' } }).success).toBe(
      false
    );
    expect(MusicGenerationSchema.safeParse({ ...job, error: { code: 'provider_error', message: 'm' } }).success).toBe(
      true
    );
  });

  it('requires a known availability on a succeeded output', () => {
    const output = {
      url: null,
      expires_at: null,
      content_type: 'audio/mpeg',
      duration_seconds: 5,
      lyrics: null,
      file_id: 'f',
    };
    for (const availability of GENERATION_OUTPUT_AVAILABILITIES) {
      expect(MusicGenerationSchema.safeParse({ ...job, output: { ...output, availability } }).success).toBe(true);
    }
    expect(MusicGenerationSchema.safeParse({ ...job, output }).success).toBe(false);
    expect(MusicGenerationSchema.safeParse({ ...job, output: { ...output, availability: 'later' } }).success).toBe(
      false
    );
  });
});
