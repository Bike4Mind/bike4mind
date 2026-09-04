import { describe, it, expect, vi, beforeEach } from 'vitest';
import passport from 'passport';
import { AuthStrategy } from '@bike4mind/common';

// The SAML verify function delegates to verifyCallback for the account lookup/link/create.
// Stub it so "was it reached?" is directly observable: the bind must refuse BEFORE it runs.
const mockAuthenticate = vi.fn();
vi.mock('@server/utils/auth/verifyCallback', () => ({
  verifyCallback: () => mockAuthenticate,
}));

// auth.ts wires every strategy at import time; none of those collaborators are exercised here.
vi.mock('@bike4mind/database', () => ({
  User: { findOne: vi.fn(), updateOne: vi.fn(), create: vi.fn() },
  SamlRequestId: { findOne: vi.fn(), create: vi.fn(), findOneAndDelete: vi.fn() },
  authSessionRepository: { revokeAllByUserId: vi.fn() },
}));
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findBySecretName: vi.fn() },
}));
// auth.ts pulls in the CASL ability, which drags the whole Mongoose model graph behind it.
vi.mock('@server/auth/ability', () => ({ default: vi.fn() }));
vi.mock('@server/utils/config', () => ({
  Config: { GOOGLE_CLIENT_ID: '', GITHUB_CLIENT_ID: '', JWT_SECRET: 'test-secret' },
}));

import { setupSamlStrategy } from './auth';

const SAML_CONFIG = {
  entryPoint: 'https://idp.a.example/sso',
  issuer: 'https://idp.a.example/metadata',
  cert: 'MIIC-not-a-real-cert',
};

/**
 * Register a strategy and invoke its verify function directly with a decoded profile.
 * That is exactly what @node-saml/passport-saml does once an assertion validates, so this
 * exercises the bind on the real code path without minting signed XML.
 */
async function verifyProfile(idp: { _id: string; emailDomain: string }, profile: Record<string, unknown>) {
  const strategyName = setupSamlStrategy({ ...idp, samlConfig: SAML_CONFIG });
  // Reaching into passport's registry is the only way to call the verify function the
  // strategy was constructed with.
  const strategy = (passport as any)._strategy(strategyName);

  return new Promise<{ err: unknown; user: unknown; info: any }>(resolve => {
    strategy._signonVerify(profile, (err: unknown, user: unknown, info: unknown) => {
      resolve({ err, user, info });
    });
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
      expect.objectContaining({ strategy: AuthStrategy.SAML, samlIdentityProviderId: 'idp-a' })
    );
  });
});

describe('setupSamlStrategy - signature and replay options', () => {
  it('leaves node-saml signature requirements at their secure defaults', () => {
    const strategyName = setupSamlStrategy({ _id: 'idp-a', emailDomain: 'a.example', samlConfig: SAML_CONFIG });
    const options = (passport as any)._strategy(strategyName)._saml.options;

    expect(options.wantAuthnResponseSigned).toBe(true);
    expect(options.wantAssertionsSigned).toBe(true);
    // Replay guard: each AuthnRequest id is redeemed once, via the shared Mongo cache.
    expect(options.validateInResponseTo).toBe('ifPresent');
  });
});
