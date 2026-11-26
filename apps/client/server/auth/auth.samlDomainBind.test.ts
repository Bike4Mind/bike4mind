import { describe, it, expect, vi, beforeEach } from 'vitest';
import passport from 'passport';
import { AuthStrategy } from '@bike4mind/common';

// The SAML verify function delegates to verifyCallback for the account lookup/link/create.
// Stub it so "was it reached?" is directly observable: the bind must refuse BEFORE it runs.
const mockAuthenticate = vi.fn();
const mockFindById = vi.fn();
vi.mock('@server/utils/auth/verifyCallback', () => ({
  verifyCallback: () => mockAuthenticate,
}));

// auth.ts wires every strategy at import time; none of those collaborators are exercised here.
vi.mock('@bike4mind/database', () => ({
  User: { findOne: vi.fn(), updateOne: vi.fn(), create: vi.fn(), findById: (...a: unknown[]) => mockFindById(...a) },
  SamlRequestId: { findOne: vi.fn(), updateOne: vi.fn(), findOneAndDelete: vi.fn() },
  authSessionRepository: { revokeAllByUserId: vi.fn() },
}));
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findBySecretName: vi.fn() },
}));
// auth.ts pulls in the CASL ability, which drags the whole Mongoose model graph behind it.
vi.mock('@bike4mind/server-utils/auth/ability', () => ({ default: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { GOOGLE_CLIENT_ID: '', GITHUB_CLIENT_ID: '', JWT_SECRET: 'test-secret' },
}));

import { setupSamlStrategy } from './auth';
import { samlRequestCache } from './samlRequestCache';

const SAML_CONFIG = {
  entryPoint: 'https://idp.a.example/sso',
  issuer: 'https://idp.a.example/metadata',
  cert: 'MIIC-not-a-real-cert',
};

type PassportDone = (err: unknown, ...rest: unknown[]) => void;
// Passport's strategy registry and session (de)serializers are private and untyped.
const passportInternals = passport as unknown as {
  _strategy(name: string): {
    _signonVerify(req: unknown, profile: unknown, done: PassportDone): void;
    _logoutVerify(req: unknown, profile: unknown, done: PassportDone): void;
  };
  _serializers: Array<(user: unknown, done: PassportDone) => void>;
  _deserializers: Array<(id: unknown, done: PassportDone) => void>;
};

/**
 * Register a strategy and invoke its verify function directly with a decoded profile.
 * That is exactly what @node-saml/passport-saml does once an assertion validates, so this
 * exercises the bind on the real code path without minting signed XML. The profile carries
 * the configured issuer unless a test overrides it.
 */
async function verifyProfile(
  idp: { _id: string; emailDomain: string },
  profile: Record<string, unknown>,
  samlConfig = SAML_CONFIG,
  req: Record<string, unknown> = { method: 'POST', body: {} }
) {
  const strategyName = setupSamlStrategy({ ...idp, samlConfig });
  // Reaching into passport's registry is the only way to call the verify function the
  // strategy was constructed with.
  const strategy = (passport as any)._strategy(strategyName);

  return new Promise<{ err: unknown; user: unknown; info: any }>(resolve => {
    strategy._signonVerify(
      req,
      { issuer: SAML_CONFIG.issuer, ...profile },
      (err: unknown, user: unknown, info: unknown) => {
        resolve({ err, user, info });
      }
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = 'https://app.example';
});

describe('setupSamlStrategy - IDP email-domain bind', () => {
  it('refuses an assertion naming an email registered to a different IDP', async () => {
    const { user, info } = await verifyProfile(
      { _id: 'idp-a', emailDomain: 'a.example' },
      { nameID: 'victim@b.example', email: 'victim@b.example' }
    );

    expect(user).toBeFalsy();
    expect(info).toMatchObject({ email: 'victim@b.example', reason: 'idp_email_domain_mismatch' });
    // Refused before any account lookup, link or session issuance.
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('refuses when only the bare nameID carries the foreign email', async () => {
    const { user } = await verifyProfile({ _id: 'idp-a', emailDomain: 'a.example' }, { nameID: 'victim@b.example' });

    expect(user).toBeFalsy();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('refuses an assertion that names no address at all', async () => {
    const { user } = await verifyProfile({ _id: 'idp-a', emailDomain: 'a.example' }, {});

    expect(user).toBeFalsy();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('refuses a subdomain of the registered domain', async () => {
    const { user } = await verifyProfile(
      { _id: 'idp-a', emailDomain: 'a.example' },
      { nameID: 'user@eu.a.example', email: 'user@eu.a.example' }
    );

    expect(user).toBeFalsy();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('passes an assertion inside the registered domain through to verifyCallback', async () => {
    mockAuthenticate.mockImplementation(async (_at, _rt, _profile, done) => done(null, { id: 'u1' }));

    const { user } = await verifyProfile(
      { _id: 'idp-a', emailDomain: 'a.example' },
      { nameID: 'user@a.example', email: 'user@a.example' }
    );

    expect(user).toEqual({ id: 'u1' });
    expect(mockAuthenticate).toHaveBeenCalledWith(
      'null',
      'null',
      expect.objectContaining({ emails: [{ value: 'user@a.example', verified: true }] }),
      expect.any(Function),
      expect.objectContaining({ strategy: AuthStrategy.SAML, samlIdentityProviderId: 'idp-a' }),
      undefined
    );
  });

  it('forwards the RelayState redirectTo so a new account can record its OAuth client', async () => {
    mockAuthenticate.mockImplementation(async (_at, _rt, _profile, done) => done(null, { id: 'u1' }));
    const redirectTo = '/oauth/authorize?client_id=b4m_acme_0a1b2c3d';

    await verifyProfile(
      { _id: 'idp-a', emailDomain: 'a.example' },
      { nameID: 'user@a.example', email: 'user@a.example' },
      SAML_CONFIG,
      { method: 'POST', body: { RelayState: new URLSearchParams({ idp: 'idp-a', redirectTo }).toString() } }
    );

    expect(mockAuthenticate.mock.calls[0][5]).toBe(redirectTo);
  });
});

describe('setupSamlStrategy - IDP issuer bind', () => {
  it.each([
    ['another IDP', 'https://idp.b.example/metadata'],
    ['no issuer', undefined],
  ])('refuses an assertion naming %s as its issuer, before any account lookup', async (_label, issuer) => {
    const { user, info } = await verifyProfile(
      { _id: 'idp-a', emailDomain: 'a.example' },
      { issuer, nameID: 'user@a.example', email: 'user@a.example' }
    );

    expect(user).toBeFalsy();
    expect(info).toEqual({ reason: 'idp_issuer_mismatch' });
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it.each([
    ['the asserted issuer', { issuer: `\n  ${SAML_CONFIG.issuer}\n` }, SAML_CONFIG],
    ['the configured issuer', {}, { ...SAML_CONFIG, issuer: `${SAML_CONFIG.issuer} \n` }],
  ])('ignores whitespace around %s', async (_label, issuer, samlConfig) => {
    mockAuthenticate.mockImplementation(async (_at, _rt, _profile, done) => done(null, { id: 'u1' }));

    const { user } = await verifyProfile(
      { _id: 'idp-a', emailDomain: 'a.example' },
      { ...issuer, nameID: 'user@a.example', email: 'user@a.example' },
      samlConfig
    );

    expect(user).toEqual({ id: 'u1' });
  });
});

describe('setupSamlStrategy - signature and replay options', () => {
  it('leaves node-saml signature requirements at their secure defaults', () => {
    const strategyName = setupSamlStrategy({ _id: 'idp-a', emailDomain: 'a.example', samlConfig: SAML_CONFIG });
    const options = (passport as any)._strategy(strategyName)._saml.options;

    expect(options.wantAuthnResponseSigned).toBe(true);
    expect(options.wantAssertionsSigned).toBe(true);
    // Replay guard: each AuthnRequest id is redeemed once, via the shared Mongo cache.
    // Both halves are asserted - validateInResponseTo alone would stay green if the
    // cacheProvider were dropped, and node-saml would silently fall back to an
    // in-process map that rejects legitimate logins on Lambda.
    expect(options.validateInResponseTo).toBe('ifPresent');
    expect(options.cacheProvider).toBe(samlRequestCache);
  });
});

describe('setupSamlStrategy - configuration and profile edges', () => {
  const IDP = { _id: 'idp-a', emailDomain: 'a.example' };

  it.each([
    ['no SAML config', undefined, 'SAML configuration missing for IDP'],
    ['no entry point', { ...SAML_CONFIG, entryPoint: '' }, 'SAML entryPoint is required'],
    ['no issuer', { ...SAML_CONFIG, issuer: '' }, 'SAML issuer is required'],
    ['no certificate', { ...SAML_CONFIG, cert: '' }, 'SAML certificate is required'],
  ])('refuses to build a strategy with %s', (_label, samlConfig, message) => {
    expect(() => setupSamlStrategy({ ...IDP, samlConfig })).toThrow(message);
  });

  it('rethrows when the strategy itself cannot be built', () => {
    expect(() => setupSamlStrategy({ ...IDP, samlConfig: { ...SAML_CONFIG, cert: '   ' } })).toThrow();
  });

  it('fails a null profile', async () => {
    const strategy = passportInternals._strategy(setupSamlStrategy({ ...IDP, samlConfig: SAML_CONFIG }));
    const err = await new Promise(resolve => strategy._signonVerify({}, null, (e: unknown) => resolve(e)));

    expect(err).toEqual(new Error('SAML profile is null'));
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('fails the login when account resolution throws', async () => {
    mockAuthenticate.mockRejectedValue(new Error('db down'));

    const { err } = await verifyProfile(IDP, { nameID: 'user@a.example', email: 'user@a.example' });

    expect(err).toEqual(new Error('db down'));
  });

  it('reads mapped attributes, then the standard claims, then the nameID', async () => {
    mockAuthenticate.mockImplementation(async (_at, _rt, _profile, done) => done(null, { id: 'u1' }));
    const mapped = {
      ...SAML_CONFIG,
      attributeMappings: { email: 'mail', firstName: 'fn', lastName: 'ln', name: 'full' },
    };

    await verifyProfile(IDP, { mail: 'mapped@a.example', fn: 'Map', ln: 'Ped' }, mapped);
    await verifyProfile(IDP, {
      nameID: 'claims@a.example',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'Claim',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname': 'Ed',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'Claimed Name',
    });
    await verifyProfile(IDP, { nameID: 'bare@a.example' });

    const profiles = mockAuthenticate.mock.calls.map(call => call[2]);
    expect(profiles[0]).toMatchObject({ id: 'mapped@a.example', displayName: 'Map Ped' });
    expect(profiles[1]).toMatchObject({
      id: 'claims@a.example',
      displayName: 'Claimed Name',
      name: { givenName: 'Claim', familyName: 'Ed' },
    });
    expect(profiles[2]).toMatchObject({ id: 'bare@a.example', displayName: 'bare@a.example' });
  });

  it('answers a logout request without tearing down a session', async () => {
    const strategy = passportInternals._strategy(setupSamlStrategy({ ...IDP, samlConfig: SAML_CONFIG }));
    const result = await new Promise(resolve =>
      strategy._logoutVerify({}, { nameID: 'user@a.example' }, (...args: unknown[]) => resolve(args))
    );

    expect(result).toEqual([null]);
  });
});

describe('passport session serialization', () => {
  // passport is one instance per worker and CI reuses workers across files, so each auth.ts load
  // appends its own pair: the last one is this file's, bound to this file's User mock.
  const serialize = (user: unknown) =>
    new Promise((resolve, reject) =>
      passportInternals._serializers.at(-1)!(user, (err: unknown, id: unknown) => (err ? reject(err) : resolve(id)))
    );
  const deserialize = (id: string) =>
    new Promise(resolve =>
      passportInternals._deserializers.at(-1)!(id, (err: unknown, user: unknown) => resolve({ err, user }))
    );

  it('stores the user id and loads the user back by it', async () => {
    mockFindById.mockResolvedValue({ id: 'u1' });

    expect(await serialize({ id: 'u1' })).toBe('u1');
    expect(await deserialize('u1')).toEqual({ err: null, user: { id: 'u1' } });
  });

  it('passes a failed load to passport', async () => {
    mockFindById.mockRejectedValue(new Error('db down'));

    expect(await deserialize('u1')).toEqual({ err: new Error('db down'), user: undefined });
  });
});
