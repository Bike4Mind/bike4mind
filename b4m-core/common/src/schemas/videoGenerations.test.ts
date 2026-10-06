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

  it('strips unknown camelCase fields and rejects an over-long prompt', () => {
    expect(CreateVideoGenerationBodySchema.parse({ model: 'm', prompt: 'p', durationSeconds: 5 })).not.toHaveProperty(
      'durationSeconds'
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
});
