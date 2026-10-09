import { describe, it, expect } from 'vitest';
import { createOAuthClientSchema, oauthRedirectUriSchema, resolveOAuthFederatedIdp } from './oauthClient';

describe('oauthRedirectUriSchema', () => {
  it.each([
    'https://app.example.test/cb',
    'http://localhost:9999/callback',
    'http://127.0.0.1:3000/cb',
    'http://[::1]:3000/cb',
    'https://app.example.test/cb?x=1,2',
  ])('accepts %s', uri => expect(oauthRedirectUriSchema.safeParse(uri).success).toBe(true));

  it.each([
    '/cb',
    'javascript:alert(1)',
    'data:text/html,x',
    'https://app.example.test/cb#x',
    'app.example.test',
    'http://app.example.test/cb',
    'http://localhost.evil.test/cb',
    'https://user:pass@app.example.test/cb',
    'https://user@app.example.test/cb',
  ])('rejects %s', uri => expect(oauthRedirectUriSchema.safeParse(uri).success).toBe(false));
});

describe('createOAuthClientSchema', () => {
  it('trims the name and defaults clientType to relying-party', () => {
    const parsed = createOAuthClientSchema.parse({ name: '  App ', redirectUris: ['https://a.example.test/cb'] });
    expect(parsed).toMatchObject({ name: 'App', clientType: 'relying-party' });
  });

  it('rejects duplicate redirect URIs and unknown keys', () => {
    const uri = 'https://a.example.test/cb';
    expect(createOAuthClientSchema.safeParse({ name: 'A', redirectUris: [uri, uri] }).success).toBe(false);
    expect(createOAuthClientSchema.safeParse({ name: 'A', redirectUris: [uri], isActive: false }).success).toBe(false);
  });
});

describe('federated URLs', () => {
  const base = { name: 'A', redirectUris: ['https://a.example.test/cb'] };

  it.each([{ issuer: 'http://idp.example.test/pool' }, { jwksUri: 'http://idp.example.test/jwks.json' }])(
    'rejects a non-https %j',
    federatedIdp => {
      expect(createOAuthClientSchema.safeParse({ ...base, federatedIdp }).success).toBe(false);
    }
  );

  it('accepts https issuer and jwksUri', () => {
    const federatedIdp = { issuer: 'https://idp.example.test/pool', jwksUri: 'https://idp.example.test/jwks.json' };
    expect(createOAuthClientSchema.safeParse({ ...base, federatedIdp }).success).toBe(true);
  });
});

describe('resolveOAuthFederatedIdp', () => {
  const cognito = { issuer: 'https://idp.example.test/pool', audience: 'app-client', providerName: 'B4M' };

  it('returns undefined only when no trust config is given', () => {
    expect(resolveOAuthFederatedIdp(undefined, 'cid')).toBeUndefined();
  });

  it('treats a supplied object as federation intent instead of dropping it', () => {
    expect(() => resolveOAuthFederatedIdp({}, 'cid')).toThrow(/together/);
    expect(() => resolveOAuthFederatedIdp({ subjectSource: 'identities' }, 'cid')).toThrow(/together/);
    expect(() => resolveOAuthFederatedIdp({ jwksUri: 'https://idp.example.test/jwks.json' }, 'cid')).toThrow(
      /together/
    );
  });

  it('keeps the identities shape free of an explicit subjectSource', () => {
    expect(resolveOAuthFederatedIdp({ ...cognito, subjectSource: 'identities' }, 'cid')).toEqual(cognito);
  });

  it('requires issuer, audience and providerName together for the identities shape', () => {
    expect(() => resolveOAuthFederatedIdp({ issuer: cognito.issuer }, 'cid')).toThrow(/together/);
  });

  it('requires an explicit JWKS URI for the sub shape and defaults its audience to the client_id', () => {
    expect(() => resolveOAuthFederatedIdp({ subjectSource: 'sub', issuer: 'https://b4m.example.test' }, 'cid')).toThrow(
      /JWKS URI/
    );
    expect(
      resolveOAuthFederatedIdp(
        {
          subjectSource: 'sub',
          issuer: 'https://b4m.example.test',
          jwksUri: 'https://b4m.example.test/api/oauth/jwks',
        },
        'cid'
      )
    ).toMatchObject({ audience: 'cid', subjectSource: 'sub' });
  });
});
