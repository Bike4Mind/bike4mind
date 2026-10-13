import { describe, it, expect } from 'vitest';
import { executionTurnAuth, requestTurnAuth } from './turnAuth';

describe('requestTurnAuth', () => {
  it('marks a key-authenticated request as an apiKey turn with its key id', () => {
    expect(requestTurnAuth({ apiKeyInfo: { keyId: 'k1' } })).toEqual({ authOrigin: 'apiKey', apiKeyId: 'k1' });
  });

  it('marks a request without a key as a signed-in session', () => {
    expect(requestTurnAuth({})).toEqual({ authOrigin: 'session' });
  });

  it('refuses a key credential with an empty key id rather than reading it as a session', () => {
    expect(() => requestTurnAuth({ apiKeyInfo: { keyId: '' } })).toThrow(/key id/);
  });
});

describe('executionTurnAuth', () => {
  it.each([
    [{ authOrigin: 'session' as const }, { authOrigin: 'session' }],
    [{ authOrigin: 'internal' as const }, { authOrigin: 'internal' }],
    [
      { authOrigin: 'apiKey' as const, apiKeyId: 'k1' },
      { authOrigin: 'apiKey', apiKeyId: 'k1' },
    ],
  ])('returns the persisted origin %o', (execution, expected) => {
    expect(executionTurnAuth(execution)).toEqual(expected);
  });

  // Runs started before authOrigin was persisted.
  it('keeps a pre-field run with a key id a key turn', () => {
    expect(executionTurnAuth({ apiKeyId: 'k1' })).toEqual({ authOrigin: 'apiKey', apiKeyId: 'k1' });
  });

  it('fails a pre-field run without a key closed to internal, not a session', () => {
    expect(executionTurnAuth({})).toEqual({ authOrigin: 'internal' });
  });
});
