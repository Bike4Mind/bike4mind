import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {
      use: () => chain,
      post: (fn: unknown) => fn,
      get: (fn: unknown) => fn,
      delete: (fn: unknown) => fn,
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockLogAuthAudit = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: unknown[]) => mockLogAuthAudit(...a) }));

const mockCompleteMfaLogin = vi.fn();
vi.mock('@server/auth/completeMfaLogin', () => ({ completeMfaLogin: (...a: unknown[]) => mockCompleteMfaLogin(...a) }));

const mockCompleteMfaEnrollment = vi.fn();
vi.mock('@server/auth/completeMfaEnrollment', () => ({
  completeMfaEnrollment: (...a: unknown[]) => mockCompleteMfaEnrollment(...a),
}));

const mockFindById = vi.fn();
const mockFindByIdWithMfaSecrets = vi.fn();
const mockRecordFailedAttempt = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    findByIdWithMfaSecrets: (...a: unknown[]) => mockFindByIdWithMfaSecrets(...a),
    atomicRecordMfaFailedAttempt: (...a: unknown[]) => mockRecordFailedAttempt(...a),
  },
  passkeyCredentialRepository: {},
  passkeyChallengeRepository: {},
}));

const RP = { rpID: 'app.example.com', rpName: 'Example', origin: 'https://app.example.com' };
const mockFinishAuthentication = vi.fn();
const mockFinishRegistration = vi.fn();
const mockStartRegistration = vi.fn();
vi.mock('@bike4mind/services', async () => {
  const { MFA_MAX_FAILED_ATTEMPTS } = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  const { isMfaAttemptRejectedError, recordFailedMfaAttempt } =
    await vi.importActual<typeof import('@bike4mind/auth/mfaService')>('@bike4mind/auth/mfaService');
  return {
    mfaService: {
      isMfaAttemptRejectedError,
      recordFailedMfaAttempt,
      resolvePasskeyRelyingParty: () => RP,
      userHasMFAConfigured: (
        user: { mfa?: { totpEnabled?: boolean; passkeyEnabled?: boolean } | null } | null | undefined
      ) => !!user?.mfa?.totpEnabled || !!user?.mfa?.passkeyEnabled,
      finishPasskeyAuthentication: (...a: unknown[]) => mockFinishAuthentication(...a),
      finishPasskeyRegistration: (...a: unknown[]) => mockFinishRegistration(...a),
      startPasskeyRegistration: (...a: unknown[]) => mockStartRegistration(...a),
      MAX_FAILED_ATTEMPTS: MFA_MAX_FAILED_ATTEMPTS,
      isUserLockedOut: (
        user: { mfa?: { totpEnabled?: boolean; passkeyEnabled?: boolean } | null } | null | undefined
      ) => !!user?.mfa?.lockedUntil && new Date(user.mfa.lockedUntil) > new Date(),
      getLockoutTimeRemaining: () => 15,
    },
  };
});

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  redactUserSecretsForSelf: (user: unknown) => user,
}));

import { secretUserFields, expectSelfUserStripped } from '@server/auth/__tests__/sessionUserSecrets';
import authenticateHandler from '@pages/api/auth/mfa/passkey/authenticate';
import registerHandler from '@pages/api/auth/mfa/passkey/register';
import registerOptionsHandler from '@pages/api/auth/mfa/passkey/register-options';

const passkeyError = (code: string) => Object.assign(new Error(`failed: ${code}`), { name: 'PasskeyError', code });

const assertion = {
  id: 'cred-a',
  rawId: 'cred-a',
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: 'cdj', authenticatorData: 'ad', signature: 'sig' },
};
const attestation = {
  id: 'cred-a',
  rawId: 'cred-a',
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: 'cdj', attestationObject: 'ao', transports: ['internal'] },
};

const makeReqRes = (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { user: { id: 'user-1' } });
  Object.assign(req, { body: body });
  Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByIdWithMfaSecrets.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true, totpSecret: 'SECRET' } });
  mockFindById.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true } });
  mockCompleteMfaLogin.mockResolvedValue({ accessToken: 'full-access', deviceRemembered: true });
  mockCompleteMfaEnrollment.mockResolvedValue({ accessToken: 'fresh-access' });
});

describe('/api/auth/mfa/passkey/authenticate', () => {
  it('mints the full session through the shared MFA tail on a verified assertion', async () => {
    mockFinishAuthentication.mockResolvedValue({ user: { id: 'user-1', tokenVersion: 3 }, credentialId: 'pk-1' });
    const { req, res } = makeReqRes({ response: assertion, rememberDevice: true });

    await authenticateHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ verified: true, accessToken: 'full-access', deviceRemembered: true });
    expect(mockFinishAuthentication.mock.calls[0][0]).toMatchObject({ rp: RP, response: assertion });
    expect(mockCompleteMfaLogin).toHaveBeenCalledWith(
      req,
      res,
      { id: 'user-1', tokenVersion: 3 },
      { rememberDevice: true }
    );
  });

  it('strips secrets and undeclared fields from the user in the response', async () => {
    mockFinishAuthentication.mockResolvedValue({ user: { id: 'user-1', ...secretUserFields() }, credentialId: 'pk-1' });
    const { req, res } = makeReqRes({ response: assertion });

    await authenticateHandler(
      req as unknown as Parameters<typeof authenticateHandler>[0],
      res as unknown as Parameters<typeof authenticateHandler>[1]
    );

    const body = res._getJSONData();
    expect(body.accessToken).toBe('full-access');
    expectSelfUserStripped(body.user, body, 'user-1');
  });

  it('honours the shared MFA lockout before verifying anything', async () => {
    mockFindByIdWithMfaSecrets.mockResolvedValue({
      id: 'user-1',
      mfa: { totpEnabled: true, lockedUntil: new Date(Date.now() + 60_000) },
    });
    const { req, res } = makeReqRes({ response: assertion });

    await authenticateHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(423);
    expect(mockFinishAuthentication).not.toHaveBeenCalled();
    expect(mockCompleteMfaLogin).not.toHaveBeenCalled();
  });

  it('counts a rejected assertion toward the lockout', async () => {
    mockFinishAuthentication.mockRejectedValue(passkeyError('verification_failed'));
    mockRecordFailedAttempt.mockResolvedValue({ id: 'user-1', mfa: { failedAttempts: 1 } });
    const { req, res } = makeReqRes({ response: assertion });

    await authenticateHandler(req as never, res as never);

    expect(mockRecordFailedAttempt).toHaveBeenCalledWith('user-1');
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'verification_failed', attemptsRemaining: 2 });
    expect(mockCompleteMfaLogin).not.toHaveBeenCalled();
  });

  it('locks the account when a rejected assertion reaches the limit', async () => {
    mockFinishAuthentication.mockRejectedValue(passkeyError('unknown_credential'));
    mockRecordFailedAttempt.mockResolvedValue({
      id: 'user-1',
      mfa: { failedAttempts: 3, lockedUntil: new Date(Date.now() + 60_000) },
    });
    const { req, res } = makeReqRes({ response: assertion });

    await authenticateHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(423);
  });

  it('does not count an expired ceremony as a failed attempt', async () => {
    mockFinishAuthentication.mockRejectedValue(passkeyError('challenge_expired'));
    const { req, res } = makeReqRes({ response: assertion });

    await authenticateHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(400);
    expect(mockRecordFailedAttempt).not.toHaveBeenCalled();
  });

  it('lets unexpected errors propagate instead of reporting them as a bad passkey', async () => {
    mockFinishAuthentication.mockRejectedValue(new Error('db down'));
    const { req, res } = makeReqRes({ response: assertion });

    await expect(authenticateHandler(req as never, res as never)).rejects.toThrow('db down');
    expect(mockRecordFailedAttempt).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a WebAuthn assertion', async () => {
    const { req, res } = makeReqRes({ response: { ...assertion, type: 'password' } });

    await expect(authenticateHandler(req as never, res as never)).rejects.toThrow();
    expect(mockFinishAuthentication).not.toHaveBeenCalled();
  });
});

describe('/api/auth/mfa/passkey/register', () => {
  const storedCredential = {
    id: 'pk-1',
    name: 'Laptop',
    deviceType: 'multiDevice',
    backedUp: true,
    createdAt: new Date('2026-01-01'),
    credentialId: 'secret-ish',
    publicKey: 'pub',
  };

  it('adds a passkey to an enrolled user: answers the passkey only and skips the enrollment tail', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true } });
    mockFinishRegistration.mockResolvedValue({ credential: storedCredential, firstFactor: false });
    const { req, res } = makeReqRes({ response: attestation, name: 'Laptop' });

    await registerHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.passkey).toMatchObject({ id: 'pk-1', name: 'Laptop', lastUsedAt: null });
    expect(body.passkey.publicKey).toBeUndefined();
    expect(body.backupCodes).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
    expect(mockCompleteMfaEnrollment).not.toHaveBeenCalled();
    expect(mockLogAuthAudit.mock.calls[0][1]).toMatchObject({ userId: 'user-1', event: 'passkey_registered' });
  });

  it('finishes a first-factor enrollment: backup codes, fresh session and the refreshed user', async () => {
    const before = { id: 'user-1', mfa: {} };
    const after = { id: 'user-1', mfa: { passkeyEnabled: true } };
    mockFindById.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    mockFinishRegistration.mockResolvedValue({
      credential: storedCredential,
      firstFactor: true,
      backupCodes: ['c1', 'c2'],
    });
    const { req, res } = makeReqRes({ response: attestation });

    await registerHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      passkey: { id: 'pk-1' },
      backupCodes: ['c1', 'c2'],
      accessToken: 'fresh-access',
      user: after,
    });
    // The user as it was before the factor was saved, so a forced enrollment still counts as forced.
    expect(mockCompleteMfaEnrollment).toHaveBeenCalledWith(req, res, before);
    expect(mockFinishRegistration.mock.calls[0][1]).toHaveProperty('users');
  });

  it('refuses a pending sign-in whose user already has a factor, before touching the ceremony', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { passkeyEnabled: true } });
    const { req, res } = makeReqRes({ response: attestation });
    Object.assign(req, { user: { id: 'user-1', mfaPending: true } });

    await registerHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(403);
    expect(mockFinishRegistration).not.toHaveBeenCalled();
    expect(mockCompleteMfaEnrollment).not.toHaveBeenCalled();
  });

  it('refuses first-factor enrollment from an emergency sign-in', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: {} });
    const { req, res } = makeReqRes({ response: attestation });
    Object.assign(req, { user: { id: 'user-1', mfaSignIn: { createdVia: 'emergency' } } });

    await registerHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(403);
    expect(mockFinishRegistration).not.toHaveBeenCalled();
  });

  it('maps a ceremony error to its status without auditing', async () => {
    mockFinishRegistration.mockRejectedValue(passkeyError('limit_reached'));
    const { req, res } = makeReqRes({ response: attestation });

    await registerHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ code: 'limit_reached' });
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
  });
});

// The step-up gate in front of this route is exercised in auth/step-up/__tests__/gatedRoutes.test.ts.
describe('/api/auth/mfa/passkey/register-options', () => {
  it('issues creation options without an authenticator code in the body', async () => {
    mockStartRegistration.mockResolvedValue({ challenge: 'chal' });
    const { req, res } = makeReqRes({});

    await registerOptionsHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ challenge: 'chal' });
    expect(mockStartRegistration.mock.calls[0][0]).toMatchObject({ user: { id: 'user-1' }, rp: RP });
  });

  it('refuses a pending sign-in whose user already has a factor', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true } });
    const { req, res } = makeReqRes({});
    Object.assign(req, { user: { id: 'user-1', mfaPending: true } });

    await registerOptionsHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(403);
    expect(mockStartRegistration).not.toHaveBeenCalled();
  });

  it('lets a pending sign-in with no factor start its first enrollment', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: {} });
    mockStartRegistration.mockResolvedValue({ challenge: 'chal' });
    const { req, res } = makeReqRes({});
    Object.assign(req, { user: { id: 'user-1', mfaPending: true } });

    await registerOptionsHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
  });

  it('refuses first-factor enrollment from an emergency sign-in', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: {} });
    const { req, res } = makeReqRes({});
    Object.assign(req, { user: { id: 'user-1', mfaSignIn: { createdVia: 'emergency' } } });

    await registerOptionsHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(403);
    expect(mockStartRegistration).not.toHaveBeenCalled();
  });

  it('maps a ceremony refusal to its status', async () => {
    mockStartRegistration.mockRejectedValue(passkeyError('limit_reached'));
    const { req, res } = makeReqRes({});

    await registerOptionsHandler(req as never, res as never);

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ code: 'limit_reached' });
  });
});
