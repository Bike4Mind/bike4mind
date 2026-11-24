import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// Keep the import chain light: generateIdToken only needs the RSA key pair + APP_URL. Stub the
// DB repositories and Config so importing oauthServer does not pull in mongoose/env validation.
// An in-memory SystemSecret store with the repository's $setOnInsert semantics, shared by every
// "instance" a test simulates. Encryption is a reversible stand-in; the real cipher has its own tests.
const store = vi.hoisted(() => {
  const rows = new Map<string, { secretName: string; encryptedValue: string }>();
  return {
    rows,
    findBySecretName: vi.fn(async (secretName: string) => rows.get(secretName) ?? null),
    upsertSecret: vi.fn(async (secretName: string, data: { encryptedValue: string }) => {
      if (!rows.has(secretName)) rows.set(secretName, { secretName, encryptedValue: data.encryptedValue });
      return rows.get(secretName)!;
    }),
  };
});
vi.mock('@bike4mind/database', () => ({
  oauthClientRepository: {},
  oauthAuthorizationCodeRepository: {},
  systemSecretRepository: { findBySecretName: store.findBySecretName, upsertSecret: store.upsertSecret },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (value: string) => `enc:${value}`,
  decryptStoredSecret: (value: string) => value.replace(/^enc:/, ''),
}));
const config = vi.hoisted(() => ({ OAUTH_RSA_PRIVATE_KEY: undefined as string | undefined }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config }));

import {
  GENERATED_SIGNING_KEY_SECRET_NAME,
  generateIdToken,
  releasedIdentityClaims,
  verifyIdTokenHint,
  verifyPkce,
} from './oauthServer';

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
  it('openid-only: emits sub but neither email nor profile claims', async () => {
    const claims = decode(await generateIdToken({ ...base, scopes: ['openid'], scopeLimited: true }));
    expect(claims.sub).toBe('u1');
    expect(claims.email).toBeUndefined();
    expect(claims.name).toBeUndefined();
    expect(claims.picture).toBeUndefined();
  });

  it('email scope releases only the email claim', async () => {
    const claims = decode(await generateIdToken({ ...base, scopes: ['openid', 'email'], scopeLimited: true }));
    expect(claims.email).toBe('u@x.com');
    expect(claims.name).toBeUndefined();
    expect(claims.picture).toBeUndefined();
  });

  it('profile scope releases name and picture, not email', async () => {
    const claims = decode(await generateIdToken({ ...base, scopes: ['openid', 'profile'], scopeLimited: true }));
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
  it('openid-only first-party token still carries email, name and picture', async () => {
    const claims = decode(await generateIdToken({ ...base, scopes: ['openid'], scopeLimited: false }));
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

  it('returns the subject of an id_token we issued to this client', async () => {
    expect(await verifyIdTokenHint(await idToken(), 'c1')).toEqual({ sub: 'u1', clientId: 'c1' });
  });

  it('takes the client from the audience when none is given', async () => {
    expect(await verifyIdTokenHint(await idToken({ clientId: 'c2' }))).toEqual({ sub: 'u1', clientId: 'c2' });
  });

  it('rejects a token whose audience is not a single client when none is given', async () => {
    const multiAudience = await idToken({ clientId: ['c1', 'c2'] as unknown as string });
    expect(await verifyIdTokenHint(multiAudience)).toBeNull();
    expect(await verifyIdTokenHint(multiAudience, 'c1')).toEqual({ sub: 'u1', clientId: 'c1' });
  });

  it('accepts an expired id_token', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() - 24 * 60 * 60 * 1000);
      const stale = await idToken();
      vi.useRealTimers();
      expect(await verifyIdTokenHint(stale, 'c1')).toEqual({ sub: 'u1', clientId: 'c1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects another client's id_token", async () => {
    expect(await verifyIdTokenHint(await idToken({ clientId: 'c2' }), 'c1')).toBeNull();
  });

  it('rejects a token from another issuer', async () => {
    const token = await idToken();
    const previous = process.env.APP_URL;
    process.env.APP_URL = 'https://other-issuer.test';
    try {
      expect(await verifyIdTokenHint(token, 'c1')).toBeNull();
    } finally {
      process.env.APP_URL = previous;
    }
  });

  it('rejects a token signed with any other key or algorithm', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const claims = { iss: process.env.APP_URL, aud: 'c1', sub: 'u1' };
    expect(await verifyIdTokenHint(jwt.sign(claims, privateKey, { algorithm: 'RS256' }), 'c1')).toBeNull();
    expect(await verifyIdTokenHint(jwt.sign(claims, 'shared-secret', { algorithm: 'HS256' }), 'c1')).toBeNull();
    expect(await verifyIdTokenHint('not-a-jwt', 'c1')).toBeNull();
  });

  it('rejects a token without a subject', async () => {
    expect(await verifyIdTokenHint(await idToken({ userId: '' }), 'c1')).toBeNull();
  });
});

describe('signing key without OAUTH_RSA_PRIVATE_KEY', () => {
  /** A new server instance: a fresh module, so nothing is cached in memory, over the same store. */
  const freshInstance = async () => {
    vi.resetModules();
    return import('./oauthServer');
  };

  beforeEach(() => {
    store.rows.clear();
    store.findBySecretName.mockClear();
    store.upsertSecret.mockClear();
  });

  const claims = { ...base, scopes: ['openid'], scopeLimited: true };

  it('verifies on one instance a token another instance signed, and both publish its key', async () => {
    const signer = await freshInstance();
    const token = await signer.generateIdToken(claims);
    const signerKid = (await signer.getJwks()).jwks.keys[0].kid;

    const verifier = await freshInstance();

    expect((await verifier.getJwks()).jwks.keys.map(key => key.kid)).toEqual([signerKid]);
    expect(jwt.decode(token, { complete: true })?.header.kid).toBe(signerKid);
    expect(await verifier.verifyIdTokenHint(token, 'c1')).toEqual({ sub: 'u1', clientId: 'c1' });
  });

  it('stores the generated key encrypted, once', async () => {
    await (await freshInstance()).generateIdToken(claims);
    await (await freshInstance()).generateIdToken(claims);

    expect(store.upsertSecret).toHaveBeenCalledTimes(1);
    expect(store.upsertSecret).toHaveBeenCalledWith(
      GENERATED_SIGNING_KEY_SECRET_NAME,
      expect.objectContaining({ category: 'oauth', source: 'auto_generated', isOverridable: false })
    );
    expect(store.rows.get(GENERATED_SIGNING_KEY_SECRET_NAME)?.encryptedValue).toMatch(
      /^enc:-----BEGIN PRIVATE KEY-----/
    );
  });

  it('reads the store once for concurrent requests on one instance', async () => {
    const instance = await freshInstance();

    const tokens = await Promise.all([1, 2, 3].map(() => instance.generateIdToken(claims)));

    expect(store.findBySecretName).toHaveBeenCalledTimes(1);
    expect(store.upsertSecret).toHaveBeenCalledTimes(1);
    expect(new Set(tokens.map(token => jwt.decode(token, { complete: true })?.header.kid)).size).toBe(1);
  });

  it('adopts the key a concurrent instance stored first', async () => {
    const winner = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    // The other instance's insert lands between this instance's read and its upsert.
    store.findBySecretName.mockResolvedValueOnce(null);
    store.rows.set(GENERATED_SIGNING_KEY_SECRET_NAME, {
      secretName: GENERATED_SIGNING_KEY_SECRET_NAME,
      encryptedValue: `enc:${winner.privateKey}`,
    });

    const token = await (await freshInstance()).generateIdToken(claims);

    expect(jwt.verify(token, winner.publicKey, { algorithms: ['RS256'] })).toMatchObject({ sub: 'u1' });
  });

  it('still signs and verifies on this instance when the store is unavailable, then retries it after a backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const instance = await freshInstance();
      store.findBySecretName.mockRejectedValueOnce(new Error('db down'));

      const token = await instance.generateIdToken(claims);
      expect(await instance.verifyIdTokenHint(token, 'c1')).toEqual({ sub: 'u1', clientId: 'c1' });
      expect((await instance.getJwks()).cacheable).toBe(false);
      expect(store.findBySecretName).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      const recovered = await instance.getJwks();
      expect(store.findBySecretName).toHaveBeenCalledTimes(2);
      expect(store.rows.has(GENERATED_SIGNING_KEY_SECRET_NAME)).toBe(true);
      expect(recovered.cacheable).toBe(true);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('marks the JWKS uncacheable while serving an instance-local key', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      store.findBySecretName.mockRejectedValueOnce(new Error('db down'));

      expect((await (await freshInstance()).getJwks()).cacheable).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('signing key with OAUTH_RSA_PRIVATE_KEY configured', () => {
  const configured = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const claims = { ...base, scopes: ['openid'], scopeLimited: true };

  beforeEach(() => {
    config.OAUTH_RSA_PRIVATE_KEY = Buffer.from(configured.privateKey).toString('base64');
    store.findBySecretName.mockClear();
    store.upsertSecret.mockClear();
  });
  afterEach(() => {
    config.OAUTH_RSA_PRIVATE_KEY = undefined;
  });

  it('signs with the configured key and never touches the store', async () => {
    vi.resetModules();
    const instance = await import('./oauthServer');

    const token = await instance.generateIdToken(claims);
    const { jwks, cacheable } = await instance.getJwks();

    expect(jwt.verify(token, configured.publicKey, { algorithms: ['RS256'] })).toMatchObject({ sub: 'u1' });
    expect(jwks.keys[0].kid).toBe(jwt.decode(token, { complete: true })?.header.kid);
    expect(cacheable).toBe(true);
    expect(store.findBySecretName).not.toHaveBeenCalled();
    expect(store.upsertSecret).not.toHaveBeenCalled();
  });

  it('treats the SST placeholder as unset', async () => {
    config.OAUTH_RSA_PRIVATE_KEY = 'not-configured';
    vi.resetModules();
    const instance = await import('./oauthServer');

    await instance.generateIdToken(claims);

    expect(store.findBySecretName).toHaveBeenCalled();
  });
});
