import { describe, it, expect, beforeAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Keep the import chain light: generateIdToken only needs the RSA key pair + APP_URL. Stub the
// DB repositories and Config so importing oauthServer does not pull in mongoose/env validation.
vi.mock('@bike4mind/database', () => ({
  oauthClientRepository: {},
  oauthAuthorizationCodeRepository: {},
}));
vi.mock('@server/utils/config', () => ({ Config: { OAUTH_RSA_PRIVATE_KEY: undefined } }));

import { generateIdToken } from './oauthServer';

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
 * OIDC claim gating (OpenID Connect Core 5.4): the id_token carries a PII claim only when the
 * corresponding scope was granted. An openid-only grant must not leak the user's email or name.
 */
describe('generateIdToken scope gating', () => {
  it('openid-only: emits sub but neither email nor profile claims', () => {
    const claims = decode(generateIdToken({ ...base, scopes: ['openid'] }));
    expect(claims.sub).toBe('u1');
    expect(claims.email).toBeUndefined();
    expect(claims.name).toBeUndefined();
    expect(claims.picture).toBeUndefined();
  });

  it('email scope releases only the email claim', () => {
    const claims = decode(generateIdToken({ ...base, scopes: ['openid', 'email'] }));
    expect(claims.email).toBe('u@x.com');
    expect(claims.name).toBeUndefined();
    expect(claims.picture).toBeUndefined();
  });

  it('profile scope releases name and picture, not email', () => {
    const claims = decode(generateIdToken({ ...base, scopes: ['openid', 'profile'] }));
    expect(claims.name).toBe('User One');
    expect(claims.picture).toBe('https://cdn.test/p.png');
    expect(claims.email).toBeUndefined();
  });
});
