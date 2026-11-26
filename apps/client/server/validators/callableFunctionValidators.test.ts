import { describe, it, expect } from 'vitest';
import { CALLABLE_FUNCTION_DATA_LIMITS } from '@bike4mind/common';
import { callableFunctionPinBodySchema, callableFunctionSourcesBodySchema } from './callableFunctionValidators';

const source = (index: number) => ({
  name: `s${index}.csv`,
  url: `https://data.example.com/s${index}.csv`,
  mode: 'live' as const,
});

describe('callableFunctionSourcesBodySchema', () => {
  it('holds as many sources as the source limit, whatever the data file limit is', () => {
    const body = (count: number) => ({ sources: Array.from({ length: count }, (_, i) => source(i)) });
    expect(callableFunctionSourcesBodySchema.safeParse(body(CALLABLE_FUNCTION_DATA_LIMITS.maxSources)).success).toBe(
      true
    );
    expect(
      callableFunctionSourcesBodySchema.safeParse(body(CALLABLE_FUNCTION_DATA_LIMITS.maxSources + 1)).success
    ).toBe(false);
  });
});

describe('callableFunctionPinBodySchema', () => {
  it('refuses a body that asks to accept a breaking change', () => {
    const body = { expectedVersion: 2, contract: {} };
    expect(callableFunctionPinBodySchema.safeParse(body).success).toBe(true);
    expect(callableFunctionPinBodySchema.safeParse({ ...body, acceptBreaking: true }).success).toBe(false);
  });
});
