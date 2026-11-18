import { describe, it, expect, beforeAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// Keep the import chain light: generateIdToken only needs the RSA key pair + APP_URL. Stub the
// DB repositories and Config so importing oauthServer does not pull in mongoose/env validation.
vi.mock('@bike4mind/database', () => ({
  oauthClientRepository: {},
  oauthAuthorizationCodeRepository: {},
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { OAUTH_RSA_PRIVATE_KEY: undefined } }));

import { generateIdToken, releasedIdentityClaims, verifyIdTokenHint, verifyPkce } from './oauthServer';

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

/**
 * PKCE grammar + S256 match (RFC 7636). Before the grammar guard, verifyPkce hashed any string and
 * returned true for a matching challenge, so a 1-char verifier passed - offline-recoverable from the
 * challenge exposed at authorization. These pin the 43-128 unreserved verifier grammar, the 43-char
 * base64url S256 challenge grammar, and that a well-formed non-match still fails.
 */
describe('verifyPkce (RFC 7636 grammar + S256 match)', () => {
  const challengeFor = (v: string) => crypto.createHash('sha256').update(v).digest('base64url');

  it('accepts the RFC 7636 Appendix B example pair', () => {
    expect(
      verifyPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    ).toBe(true);
  });

  it('accepts verifiers at the length bounds (43 and 128) with a matching challenge', () => {
    for (const len of [43, 128]) {
      const v = 'a'.repeat(len);
      expect(verifyPkce(v, challengeFor(v))).toBe(true);
    }
  });

  it('rejects verifiers outside the length bounds even with a correctly computed challenge', () => {
    // These all returned true before the grammar guard (the offline-recovery hole onoya flagged).
    for (const len of [1, 42, 129]) {
      const v = 'a'.repeat(len);
      expect(verifyPkce(v, challengeFor(v))).toBe(false);
    }
  });

  it('rejects a verifier with an out-of-set character', () => {
    const v = 'a'.repeat(42) + '!'; // 43 chars, '!' is not in the unreserved set
    expect(verifyPkce(v, challengeFor(v))).toBe(false);
  });

  it('rejects a challenge that is not exactly 43 base64url characters', () => {
    const v = 'a'.repeat(43);
    expect(verifyPkce(v, 'a'.repeat(42))).toBe(false);
    expect(verifyPkce(v, 'a'.repeat(44))).toBe(false);
  });

  it('rejects a well-formed but non-matching verifier/challenge pair', () => {
    expect(verifyPkce('a'.repeat(43), challengeFor('b'.repeat(43)))).toBe(false);
  });
});

describe('verifyIdTokenHint', () => {
  const idToken = (overrides: Partial<typeof base> = {}) =>
    generateIdToken({ ...base, ...overrides, scopes: ['openid'], scopeLimited: true });

  it('returns the subject of an id_token we issued to this client', () => {
    expect(verifyIdTokenHint(idToken(), 'c1')).toEqual({ sub: 'u1', clientId: 'c1' });
  });

  it('takes the client from the audience when none is given', () => {
    expect(verifyIdTokenHint(idToken({ clientId: 'c2' }))).toEqual({ sub: 'u1', clientId: 'c2' });
  });

  it('rejects a token whose audience is not a single client when none is given', () => {
    const multiAudience = idToken({ clientId: ['c1', 'c2'] as unknown as string });
    expect(verifyIdTokenHint(multiAudience)).toBeNull();
    expect(verifyIdTokenHint(multiAudience, 'c1')).toEqual({ sub: 'u1', clientId: 'c1' });
  });

  it('accepts an expired id_token', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() - 24 * 60 * 60 * 1000);
      const stale = idToken();
      vi.useRealTimers();
      expect(verifyIdTokenHint(stale, 'c1')).toEqual({ sub: 'u1', clientId: 'c1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects another client's id_token", () => {
    expect(verifyIdTokenHint(idToken({ clientId: 'c2' }), 'c1')).toBeNull();
  });

  it('rejects a token from another issuer', () => {
    const token = idToken();
    const previous = process.env.APP_URL;
    process.env.APP_URL = 'https://other-issuer.test';
    try {
      expect(verifyIdTokenHint(token, 'c1')).toBeNull();
    } finally {
      process.env.APP_URL = previous;
    }
  });

  it('rejects a token signed with any other key or algorithm', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const claims = { iss: process.env.APP_URL, aud: 'c1', sub: 'u1' };
    expect(verifyIdTokenHint(jwt.sign(claims, privateKey, { algorithm: 'RS256' }), 'c1')).toBeNull();
    expect(verifyIdTokenHint(jwt.sign(claims, 'shared-secret', { algorithm: 'HS256' }), 'c1')).toBeNull();
    expect(verifyIdTokenHint('not-a-jwt', 'c1')).toBeNull();
  });

  it('rejects a token without a subject', () => {
    expect(verifyIdTokenHint(idToken({ userId: '' }), 'c1')).toBeNull();
  });
});
