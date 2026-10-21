import { describe, it, expect } from 'vitest';
import { assertAuthOriginMatchesApiKey } from './authOrigin';

describe('assertAuthOriginMatchesApiKey', () => {
  it.each([
    ['session', undefined],
    ['internal', undefined],
    ['apiKey', 'key1'],
  ] as const)('accepts %s with key id %s', (authOrigin, apiKeyId) => {
    expect(() => assertAuthOriginMatchesApiKey(authOrigin, apiKeyId)).not.toThrow();
  });

  it.each([
    ['apiKey', undefined],
    ['apiKey', ''],
    ['session', 'key1'],
    ['internal', 'key1'],
  ] as const)('rejects %s with key id %s', (authOrigin, apiKeyId) => {
    expect(() => assertAuthOriginMatchesApiKey(authOrigin, apiKeyId)).toThrow(/authOrigin/);
  });
});
