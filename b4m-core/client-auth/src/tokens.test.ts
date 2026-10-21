import { describe, it, expect } from 'vitest';
import { isAuthTokenValid, normalizeEnvKey, swapActiveEnvAuth, type AuthTokens } from './tokens';

const token = (userId: string, expiresAt = new Date(Date.now() + 3_600_000).toISOString()): AuthTokens => ({
  accessToken: `access-${userId}`,
  refreshToken: `refresh-${userId}`,
  expiresAt,
  userId,
});

describe('normalizeEnvKey', () => {
  it('folds case and trailing slashes so trivial input variants share a cache entry', () => {
    expect(normalizeEnvKey('HTTPS://X.com/')).toBe(normalizeEnvKey('https://x.com'));
    expect(normalizeEnvKey('https://x.com///')).toBe('https://x.com');
  });
});

describe('isAuthTokenValid', () => {
  it('is false for a missing or expired token', () => {
    expect(isAuthTokenValid(undefined)).toBe(false);
    expect(isAuthTokenValid(token('u1', new Date(Date.now() - 1000).toISOString()))).toBe(false);
  });

  it('is true for a token that has not expired', () => {
    expect(isAuthTokenValid(token('u1'))).toBe(true);
  });
});

describe('swapActiveEnvAuth', () => {
  it('stashes the active token and restores the target environment cached one', () => {
    const active = token('hosted');
    const cached = token('selfhost');

    const swap = swapActiveEnvAuth(
      { auth: active, authByEnv: { 'https://self.example.com': cached } },
      'https://app.example.com',
      'https://self.example.com/'
    );

    expect(swap.changed).toBe(true);
    expect(swap.auth).toBe(cached);
    expect(swap.authByEnv['https://app.example.com']).toBe(active);
  });

  it('leaves the target unauthenticated when nothing was cached for it', () => {
    const swap = swapActiveEnvAuth({ auth: token('hosted') }, 'https://app.example.com', 'http://localhost:3000');

    expect(swap.auth).toBeUndefined();
    expect(swap.authByEnv['https://app.example.com']).toBeDefined();
  });

  it('drops a stale entry for the environment being left when it has no active token', () => {
    const swap = swapActiveEnvAuth(
      { authByEnv: { 'https://app.example.com': token('stale') } },
      'https://app.example.com',
      'http://localhost:3000'
    );

    expect(swap.authByEnv['https://app.example.com']).toBeUndefined();
  });

  it('reports no change and touches nothing when both URLs normalize to the same key', () => {
    const active = token('hosted');
    const swap = swapActiveEnvAuth({ auth: active }, 'https://app.example.com', 'https://APP.example.com/');

    expect(swap.changed).toBe(false);
    expect(swap.auth).toBe(active);
  });

  it('does not mutate the state it was given', () => {
    const state = { auth: token('hosted'), authByEnv: {} as Record<string, AuthTokens> };

    swapActiveEnvAuth(state, 'https://app.example.com', 'http://localhost:3000');

    expect(state.authByEnv).toEqual({});
  });
});
