import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { JwtRsaVerifier } from 'aws-jwt-verify';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuthStrategy } from '@bike4mind/common';

const { authenticateSelfServeProfile } = vi.hoisted(() => ({ authenticateSelfServeProfile: vi.fn() }));
vi.mock('@server/utils/auth/verifyCallback', () => ({ authenticateSelfServeProfile }));
vi.mock('@bike4mind/utils/security', () => ({ encryptAtRest: (value: string) => `enc:${value}` }));

import {
  createAppleIdTokenVerifier,
  createAppleVerifyCallback,
  parseAppleDisplayName,
  registerAppleStrategy,
} from './appleStrategy';

const CLIENT_ID = 'com.example.services';
const ISSUER = 'https://appleid.apple.com';
const KID = 'apple-test-key';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
  keys: [{ ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: KID, alg: 'RS256', use: 'sig' }],
};

// The Apple JWKS is mocked by seeding the verifier's cache, so no network is touched.
const verifier = JwtRsaVerifier.create({ issuer: ISSUER, audience: CLIENT_ID, jwksUri: `${ISSUER}/auth/keys` });
verifier.cacheJwks(jwks as never);
const verifyIdToken = createAppleIdTokenVerifier(CLIENT_ID, verifier);

const signIdToken = (claims: Record<string, unknown>, options: jwt.SignOptions = {}) =>
  jwt.sign(claims, privateKey, {
    algorithm: 'RS256',
    keyid: KID,
    issuer: ISSUER,
    audience: CLIENT_ID,
    expiresIn: 300,
    ...options,
  });

describe('createAppleIdTokenVerifier', () => {
  it('accepts a correctly signed token and parses the string email_verified form', async () => {
    const claims = await verifyIdToken(signIdToken({ sub: 'sub-1', email: 'a@b.co', email_verified: 'true' }));
    expect(claims).toMatchObject({ sub: 'sub-1', email: 'a@b.co', email_verified: 'true' });
  });

  it('rejects a token for another audience', async () => {
    await expect(verifyIdToken(signIdToken({ sub: 's' }, { audience: 'someone.else' }))).rejects.toThrow();
  });

  it('rejects a token signed by a key outside the JWKS', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = jwt.sign({ sub: 's' }, other, {
      algorithm: 'RS256',
      keyid: KID,
      issuer: ISSUER,
      audience: CLIENT_ID,
      expiresIn: 300,
    });
    await expect(verifyIdToken(forged)).rejects.toThrow();
  });
});

describe('parseAppleDisplayName', () => {
  it('joins first and last name from the first-authorization user field', () => {
    expect(parseAppleDisplayName(JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }))).toBe(
      'Ada Lovelace'
    );
  });

  it.each([undefined, '', 'not json', '{}', JSON.stringify({ name: {} })])('returns undefined for %p', raw => {
    expect(parseAppleDisplayName(raw)).toBeUndefined();
  });
});

describe('Apple verify callback', () => {
  const callback = createAppleVerifyCallback(verifyIdToken);
  const done = vi.fn();
  beforeEach(() => {
    authenticateSelfServeProfile.mockReset();
    done.mockReset();
  });

  it('first authorization: passes verified email, sub and the form-post name, with encrypted tokens', async () => {
    const idToken = signIdToken({ sub: 'sub-1', email: 'a@b.co', email_verified: 'true' });
    const req = { query: { user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }) } };

    await callback(req as never, 'acc', 'ref', { id_token: idToken }, {}, done);

    const [strategy, , accessToken, refreshToken, profile, , authProvider] = authenticateSelfServeProfile.mock.calls[0];
    expect(strategy).toBe(AuthStrategy.Apple);
    expect([accessToken, refreshToken]).toEqual(['acc', 'ref']);
    expect(profile).toEqual({ id: 'sub-1', email: 'a@b.co', email_verified: true, displayName: 'Ada Lovelace' });
    expect(authProvider).toEqual({ encrypted: true, accessToken: 'enc:acc', refreshToken: 'enc:ref' });
  });

  it('repeat authorization: only sub arrives, so no email and no name are invented', async () => {
    const idToken = signIdToken({ sub: 'sub-1' });

    await callback({ query: {} } as never, 'acc', 'ref', { id_token: idToken }, {}, done);

    const profile = authenticateSelfServeProfile.mock.calls[0][4];
    expect(profile).toEqual({ id: 'sub-1', email: undefined, email_verified: false, displayName: undefined });
  });

  it('refuses to authenticate when the id_token does not verify', async () => {
    await callback({ query: {} } as never, 'acc', 'ref', { id_token: 'garbage' }, {}, done);

    expect(authenticateSelfServeProfile).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(null, undefined, { code: 'internal' });
  });
});

describe('registerAppleStrategy', () => {
  it('does not register the strategy when the Apple env is unset', () => {
    const passportInstance = { use: vi.fn() };
    expect(registerAppleStrategy(passportInstance, null)).toBe(false);
    expect(passportInstance.use).not.toHaveBeenCalled();
  });

  it('registers it under the name apple when configured', () => {
    const { privateKey: ec } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const passportInstance = { use: vi.fn() };
    const registered = registerAppleStrategy(
      passportInstance,
      {
        clientId: CLIENT_ID,
        teamId: 'TEAM',
        keyId: 'KEY',
        privateKey: ec.export({ format: 'pem', type: 'pkcs8' }).toString(),
      },
      'https://app.example.com'
    );
    expect(registered).toBe(true);
    expect(passportInstance.use).toHaveBeenCalledWith('apple', expect.anything());
  });
});
