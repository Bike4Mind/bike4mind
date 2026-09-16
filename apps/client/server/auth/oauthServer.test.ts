import { describe, it, expect, beforeAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Keep the import chain light: generateIdToken only needs the RSA key pair + APP_URL. Stub the
// DB repositories and Config so importing oauthServer does not pull in mongoose/env validation.
vi.mock('@bike4mind/database', () => ({
  oauthClientRepository: {},
  oauthAuthorizationCodeRepository: {},
}));
vi.mock('@server/utils/config', () => ({ Config: { OAUTH_RSA_PRIVATE_KEY: undefined } }));

import { generateIdToken, releasedIdentityClaims } from './oauthServer';

beforeAll(() => {
  process.env.APP_URL = process.env.APP_URL || 'https://app.test';
});

const decode = (token: string) => jwt.decode(token) as Record<string, unknown>;
const base = {
  userId: 'u1',
  email: 'u@x.com',
  name: 'User One',
  picture: 'https://cdn.test/p.png',
  clientId: 'c1',
};

/**
 * OIDC claim gating (OpenID Connect Core 5.4): a scope-limited (relying-party) id_token carries a
 * PII claim only when the corresponding scope was granted. An openid-only grant must not leak the
 * user's email or name.
 */
describe('generateIdToken scope gating (relying-party, scopeLimited)', () => {
  it('openid-only: emits sub but neither email nor profile claims', () => {
    const claims = decode(generateIdToken({ ...base, scopes: ['openid'], scopeLimited: true }));
    expect(claims.sub).toBe('u1');
    expect(claims.email).toBeUndefined();
    expect(claims.name).toBeUndefined();
    expect(claims.picture).toBeUndefined();
  });

  it('email scope releases only the email claim', () => {
    const claims = decode(generateIdToken({ ...base, scopes: ['openid', 'email'], scopeLimited: true }));
    expect(claims.email).toBe('u@x.com');
    expect(claims.name).toBeUndefined();
    expect(claims.picture).toBeUndefined();
  });

  it('profile scope releases name and picture, not email', () => {
    const claims = decode(generateIdToken({ ...base, scopes: ['openid', 'profile'], scopeLimited: true }));
    expect(claims.name).toBe('User One');
    expect(claims.picture).toBe('https://cdn.test/p.png');
    expect(claims.email).toBeUndefined();
  });
});

/**
 * A first-party client is NOT scope-limited: its id_token keeps the full claim set even when it
 * asks for only `openid`. This is the pre-scoping behavior the OAuth-hardening change must preserve;
 * the regression it guards against is a first-party `scope=openid` login losing email and name.
 */
describe('generateIdToken (first-party, not scopeLimited)', () => {
  it('openid-only first-party token still carries email, name and picture', () => {
    const claims = decode(generateIdToken({ ...base, scopes: ['openid'], scopeLimited: false }));
    expect(claims.sub).toBe('u1');
    expect(claims.email).toBe('u@x.com');
    expect(claims.name).toBe('User One');
    expect(claims.picture).toBe('https://cdn.test/p.png');
  });
});

/**
 * releasedIdentityClaims is the single source of truth both generateIdToken and the userinfo
 * endpoint consult, so the two claim projections cannot drift apart.
 */
describe('releasedIdentityClaims', () => {
  it('a non-scope-limited token releases everything regardless of scopes', () => {
    expect(releasedIdentityClaims({ scopes: ['openid'], scopeLimited: false })).toEqual({
      email: true,
      profile: true,
    });
  });

  it('a scope-limited openid-only token releases nothing beyond sub', () => {
    expect(releasedIdentityClaims({ scopes: ['openid'], scopeLimited: true })).toEqual({
      email: false,
      profile: false,
    });
  });

  it('a scope-limited token releases exactly the scopes it holds', () => {
    expect(releasedIdentityClaims({ scopes: ['openid', 'email'], scopeLimited: true })).toEqual({
      email: true,
      profile: false,
    });
    expect(releasedIdentityClaims({ scopes: ['openid', 'profile'], scopeLimited: true })).toEqual({
      email: false,
      profile: true,
    });
  });
});
