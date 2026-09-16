import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@server/utils/config', () => ({ Config: { OAUTH_RSA_PRIVATE_KEY: 'not-configured' } }));
vi.mock('@bike4mind/database', () => ({
  oauthClientRepository: {},
  oauthAuthorizationCodeRepository: {},
}));

import { getOidcDiscovery } from './oauthServer';

const APP_URL = 'https://app.example-b4m.test';

describe('getOidcDiscovery', () => {
  const previous = process.env.APP_URL;
  beforeEach(() => {
    process.env.APP_URL = APP_URL;
  });
  afterEach(() => {
    process.env.APP_URL = previous;
  });

  it('publishes the JWKS URI explicitly, so a federated client never has to derive it', () => {
    // A client registered with B4M as its trusted issuer must copy this value into its
    // federatedIdp.jwksUri; the aws-jwt-verify default derives Cognito's
    // `/.well-known/jwks.json`, which does not exist here.
    expect(getOidcDiscovery().jwks_uri).toBe(`${APP_URL}/api/oauth/jwks`);
  });

  it('advertises RS256 ID tokens from the same issuer', () => {
    const discovery = getOidcDiscovery();
    expect(discovery.issuer).toBe(APP_URL);
    expect(discovery.id_token_signing_alg_values_supported).toContain('RS256');
  });
});
