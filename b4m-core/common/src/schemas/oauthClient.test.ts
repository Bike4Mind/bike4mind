import { describe, it, expect } from 'vitest';
import {
  createOAuthClientSchema,
  oauthRedirectUriSchema,
  postLogoutRedirectUrisSchema,
  resolveOAuthFederatedIdp,
  updateOAuthClientSchema,
  oauthClientRoleSchema,
  oauthClientRoleAssignmentInputSchema,
} from './oauthClient';
import { FEDERATED_ADMIN_STATUS_SCOPE, OAUTH_CLIENT_SCOPES } from '../constants/oauthClients';

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
    'http://local\thost:3000/cb',
    'https://app.example.test/c b',
  ])('rejects %s', uri => expect(oauthRedirectUriSchema.safeParse(uri).success).toBe(false));
});

describe('createOAuthClientSchema', () => {
  const federatedIdp = { issuer: 'https://idp.example.test', audience: 'app', providerName: 'B4M' };
  const base = { name: 'App', redirectUris: ['https://app.example.test/cb'], federatedIdp };

  it('accepts an optional federated quota profile without changing defaults', () => {
    const rateLimit = { requestsPerMinute: 300, requestsPerDay: 20_000 };
    expect(createOAuthClientSchema.parse({ ...base, rateLimit }).rateLimit).toEqual(rateLimit);
    expect(createOAuthClientSchema.parse(base).rateLimit).toBeUndefined();
    expect(updateOAuthClientSchema.parse({ rateLimit }).rateLimit).toEqual(rateLimit);
    expect(updateOAuthClientSchema.parse({ rateLimit: null }).rateLimit).toBeNull();
    expect(createOAuthClientSchema.safeParse({ ...base, federatedIdp: undefined, rateLimit }).success).toBe(false);
  });

  it.each([
    { requestsPerMinute: 0, requestsPerDay: 20_000 },
    { requestsPerMinute: 1.5, requestsPerDay: 20_000 },
    { requestsPerMinute: 10_001, requestsPerDay: 20_000 },
    { requestsPerMinute: 300, requestsPerDay: 1_000_001 },
    { requestsPerMinute: 300 },
  ])('rejects an invalid profile %j', rateLimit => {
    expect(createOAuthClientSchema.safeParse({ ...base, rateLimit }).success).toBe(false);
    expect(updateOAuthClientSchema.safeParse({ rateLimit }).success).toBe(false);
  });

  it('accepts unpaidAccountsAllowed on any client and rejects non-booleans', () => {
    const plain = { name: 'App', redirectUris: ['https://app.example.test/cb'] };
    expect(createOAuthClientSchema.parse({ ...plain, unpaidAccountsAllowed: false }).unpaidAccountsAllowed).toBe(false);
    expect(createOAuthClientSchema.parse(plain).unpaidAccountsAllowed).toBeUndefined();
    expect(updateOAuthClientSchema.parse({ unpaidAccountsAllowed: true }).unpaidAccountsAllowed).toBe(true);
    expect(updateOAuthClientSchema.safeParse({ unpaidAccountsAllowed: 'no' }).success).toBe(false);
    expect(updateOAuthClientSchema.safeParse({ unpaidAccountsAllowed: null }).success).toBe(false);
  });

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

describe('updateOAuthClientSchema', () => {
  const trust = { subjectSource: 'sub', issuer: 'https://b4m.example.test' };

  it('accepts allowedScopes with openid, including a legacy out-of-set scope', () => {
    expect(updateOAuthClientSchema.parse({ allowedScopes: ['openid', 'legacy:x'] }).allowedScopes).toEqual([
      'openid',
      'legacy:x',
    ]);
  });

  it.each([
    ['without openid', ['email']],
    ['with duplicates', ['openid', 'openid']],
    ['empty', []],
  ])('rejects allowedScopes %s', (_n, allowedScopes) => {
    expect(updateOAuthClientSchema.safeParse({ allowedScopes }).success).toBe(false);
  });

  it('accepts a federatedIdp object and null', () => {
    expect(updateOAuthClientSchema.safeParse({ federatedIdp: trust }).success).toBe(true);
    expect(updateOAuthClientSchema.parse({ federatedIdp: null }).federatedIdp).toBeNull();
  });

  it('accepts an Overwatch product id and null, and rejects one that is not a lower-case slug', () => {
    expect(updateOAuthClientSchema.parse({ overwatchProductId: ' reading-app ' }).overwatchProductId).toBe(
      'reading-app'
    );
    expect(updateOAuthClientSchema.parse({ overwatchProductId: null }).overwatchProductId).toBeNull();
    for (const bad of ['', 'Reading-App', '-reading', 'reading app', 'a'.repeat(65)]) {
      expect(updateOAuthClientSchema.safeParse({ overwatchProductId: bad }).success).toBe(false);
    }
  });

  it('rejects a non-https issuer in federatedIdp', () => {
    expect(
      updateOAuthClientSchema.safeParse({ federatedIdp: { ...trust, issuer: 'http://b4m.example.test' } }).success
    ).toBe(false);
  });

  it('still rejects unknown keys and an empty body', () => {
    expect(updateOAuthClientSchema.safeParse({ name: 'x' }).success).toBe(false);
    const empty = updateOAuthClientSchema.safeParse({});
    expect(empty.success).toBe(false);
    expect(!empty.success && empty.error.issues[0].message).toBe('Nothing to update');
  });

  it('accepts an ISO expectedUpdatedAt or null, rejects other strings', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(updateOAuthClientSchema.safeParse({ isActive: false, expectedUpdatedAt: iso }).success).toBe(true);
    expect(updateOAuthClientSchema.safeParse({ isActive: false, expectedUpdatedAt: null }).success).toBe(true);
    expect(updateOAuthClientSchema.safeParse({ isActive: false, expectedUpdatedAt: 'yesterday' }).success).toBe(false);
  });

  it('does not count expectedUpdatedAt as something to update', () => {
    const r = updateOAuthClientSchema.safeParse({ expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });
    expect(!r.success && r.error.issues[0].message).toBe('Nothing to update');
  });

  it('OAUTH_CLIENT_SCOPES lists the grantable scopes', () => {
    expect(OAUTH_CLIENT_SCOPES).toEqual(
      expect.arrayContaining(['openid', 'ai:generate', 'me:read', FEDERATED_ADMIN_STATUS_SCOPE])
    );
  });
});

describe('postLogoutRedirectUris', () => {
  const base = { name: 'App', redirectUris: ['https://app.example.test/cb'] };

  it('is optional on create and update, and accepts an empty list', () => {
    expect(createOAuthClientSchema.parse(base).postLogoutRedirectUris).toBeUndefined();
    expect(createOAuthClientSchema.parse({ ...base, postLogoutRedirectUris: [] }).postLogoutRedirectUris).toEqual([]);
    expect(updateOAuthClientSchema.parse({ postLogoutRedirectUris: [] }).postLogoutRedirectUris).toEqual([]);
  });

  it('accepts https and loopback http URIs', () => {
    const uris = ['https://rp.example.test/signed-out', 'http://localhost:3000/signed-out'];
    expect(postLogoutRedirectUrisSchema.parse(uris)).toEqual(uris);
    expect(updateOAuthClientSchema.parse({ postLogoutRedirectUris: uris }).postLogoutRedirectUris).toEqual(uris);
  });

  it.each([
    ['plain http', ['http://rp.example.test/out']],
    ['a fragment', ['https://rp.example.test/out#x']],
    ['userinfo', ['https://u:p@rp.example.test/out']],
    ['a javascript: URI', ['javascript:alert(1)']],
    ['duplicates', ['https://rp.example.test/out', 'https://rp.example.test/out']],
    ['too many', Array.from({ length: 21 }, (_, i) => `https://rp.example.test/out${i}`)],
  ])('rejects %s', (_n, uris) => {
    expect(postLogoutRedirectUrisSchema.safeParse(uris).success).toBe(false);
    expect(createOAuthClientSchema.safeParse({ ...base, postLogoutRedirectUris: uris }).success).toBe(false);
    expect(updateOAuthClientSchema.safeParse({ postLogoutRedirectUris: uris }).success).toBe(false);
  });
});

describe('oauthClientRoleSchema', () => {
  it('accepts a slug key with a label, trimmed', () => {
    expect(oauthClientRoleSchema.parse({ key: ' admin_1-x ', label: ' Admin ' })).toEqual({
      key: 'admin_1-x',
      label: 'Admin',
    });
  });

  it.each([
    { key: '', label: 'A' },
    { key: 'Admin', label: 'A' },
    { key: '9lives', label: 'A' },
    { key: 'has space', label: 'A' },
    { key: 'a'.repeat(33), label: 'A' },
    { key: 'admin', label: ' ' },
    { key: 'admin', label: 'x'.repeat(65) },
    { key: 'admin', label: 'A', extra: true },
  ])('rejects %j', input => {
    expect(oauthClientRoleSchema.safeParse(input).success).toBe(false);
  });

  it('validates an assignment input', () => {
    expect(oauthClientRoleAssignmentInputSchema.safeParse({ clientId: 'b4m_x', role: 'admin' }).success).toBe(true);
    expect(oauthClientRoleAssignmentInputSchema.safeParse({ clientId: '', role: 'admin' }).success).toBe(false);
    expect(oauthClientRoleAssignmentInputSchema.safeParse({ clientId: 'b4m_x', role: 'Admin' }).success).toBe(false);
  });
});

describe('federated https URL fields', () => {
  it.each(['not a url', 'http://idp.example.test'])('rejects issuer %s', issuer => {
    const input = { name: 'A', redirectUris: ['https://app.example.test/cb'], federatedIdp: { issuer } };
    expect(createOAuthClientSchema.safeParse(input).success).toBe(false);
  });
});

describe('resolveOAuthFederatedIdp remaining shapes', () => {
  it('requires an issuer for the sub source', () => {
    expect(() => resolveOAuthFederatedIdp({ subjectSource: 'sub' }, 'cid')).toThrow(/requires an issuer/);
  });

  it('keeps an explicit audience for the sub source and a jwksUri for the identities source', () => {
    expect(
      resolveOAuthFederatedIdp(
        {
          subjectSource: 'sub',
          issuer: 'https://b4m.example.test',
          jwksUri: 'https://b4m.example.test/jwks',
          audience: 'aud',
        },
        'cid'
      )
    ).toMatchObject({ audience: 'aud' });
    expect(
      resolveOAuthFederatedIdp(
        { issuer: 'https://idp.example.test', audience: 'a', providerName: 'p', jwksUri: 'https://idp.example.test/j' },
        'cid'
      )
    ).toEqual({
      issuer: 'https://idp.example.test',
      audience: 'a',
      providerName: 'p',
      jwksUri: 'https://idp.example.test/j',
    });
  });
});
