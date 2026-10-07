import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn, get: (fn: any) => fn, delete: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockLogAuthAudit = vi.fn((..._args: any[]) => Promise.resolve());
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: any[]) => mockLogAuthAudit(...a) }));

const mockCompleteMfaLogin = vi.fn();
vi.mock('@server/auth/completeMfaLogin', () => ({ completeMfaLogin: (...a: any[]) => mockCompleteMfaLogin(...a) }));

const mockFindById = vi.fn();
const mockFindByIdWithMfaSecrets = vi.fn();
const mockRecordFailedAttempt = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findById: (...a: any[]) => mockFindById(...a),
    findByIdWithMfaSecrets: (...a: any[]) => mockFindByIdWithMfaSecrets(...a),
    atomicRecordMfaFailedAttempt: (...a: any[]) => mockRecordFailedAttempt(...a),
  },
  passkeyCredentialRepository: {},
  passkeyChallengeRepository: {},
}));

const RP = { rpID: 'app.example.com', rpName: 'Example', origin: 'https://app.example.com' };
const mockFinishAuthentication = vi.fn();
const mockFinishRegistration = vi.fn();
const mockStartRegistration = vi.fn();
const mockVerifyTOTP = vi.fn();
vi.mock('@bike4mind/services', () => ({
  mfaService: {
    resolvePasskeyRelyingParty: () => RP,
    finishPasskeyAuthentication: (...a: any[]) => mockFinishAuthentication(...a),
    finishPasskeyRegistration: (...a: any[]) => mockFinishRegistration(...a),
    startPasskeyRegistration: (...a: any[]) => mockStartRegistration(...a),
    verifyTOTPToken: (...a: any[]) => mockVerifyTOTP(...a),
    MAX_FAILED_ATTEMPTS: 3,
    isUserLockedOut: (user: any) => !!user?.mfa?.lockedUntil && new Date(user.mfa.lockedUntil) > new Date(),
    getLockoutTimeRemaining: () => 15,
  },
}));

vi.mock('@bike4mind/common', () => ({ redactUserSecretsForSelf: (user: unknown) => user }));

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
  (req as any).user = { id: 'user-1' };
  (req as any).body = body;
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByIdWithMfaSecrets.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true, totpSecret: 'SECRET' } });
  mockFindById.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true } });
  mockCompleteMfaLogin.mockResolvedValue({ accessToken: 'full-access', deviceRemembered: true });
});

describe('/api/auth/mfa/passkey/authenticate', () => {
  it('mints the full session through the shared MFA tail on a verified assertion', async () => {
    mockFinishAuthentication.mockResolvedValue({ user: { id: 'user-1', tokenVersion: 3 }, credentialId: 'pk-1' });
    const { req, res } = makeReqRes({ response: assertion, rememberDevice: true });

    await authenticateHandler(req as any, res as any);

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

  it('honours the shared MFA lockout before verifying anything', async () => {
    mockFindByIdWithMfaSecrets.mockResolvedValue({
      id: 'user-1',
      mfa: { totpEnabled: true, lockedUntil: new Date(Date.now() + 60_000) },
    });
    const { req, res } = makeReqRes({ response: assertion });

    await authenticateHandler(req as any, res as any);

    expect(res._getStatusCode()).toBe(423);
    expect(mockFinishAuthentication).not.toHaveBeenCalled();
    expect(mockCompleteMfaLogin).not.toHaveBeenCalled();
  });

  it('counts a rejected assertion toward the lockout', async () => {
    mockFinishAuthentication.mockRejectedValue(passkeyError('verification_failed'));
    mockRecordFailedAttempt.mockResolvedValue({ id: 'user-1', mfa: { failedAttempts: 1 } });
    const { req, res } = makeReqRes({ response: assertion });

    await authenticateHandler(req as any, res as any);

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

    await authenticateHandler(req as any, res as any);

    expect(res._getStatusCode()).toBe(423);
  });

  it('does not count an expired ceremony as a failed attempt', async () => {
    mockFinishAuthentication.mockRejectedValue(passkeyError('challenge_expired'));
    const { req, res } = makeReqRes({ response: assertion });

    await authenticateHandler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(mockRecordFailedAttempt).not.toHaveBeenCalled();
  });

  it('lets unexpected errors propagate instead of reporting them as a bad passkey', async () => {
    mockFinishAuthentication.mockRejectedValue(new Error('db down'));
    const { req, res } = makeReqRes({ response: assertion });

    await expect(authenticateHandler(req as any, res as any)).rejects.toThrow('db down');
    expect(mockRecordFailedAttempt).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a WebAuthn assertion', async () => {
    const { req, res } = makeReqRes({ response: { ...assertion, type: 'password' } });

    await expect(authenticateHandler(req as any, res as any)).rejects.toThrow();
    expect(mockFinishAuthentication).not.toHaveBeenCalled();
  });
});

describe('/api/auth/mfa/passkey/register', () => {
  it('stores the passkey and writes an audit entry', async () => {
    mockFinishRegistration.mockResolvedValue({
      id: 'pk-1',
      name: 'Laptop',
      deviceType: 'multiDevice',
      backedUp: true,
      createdAt: new Date('2026-01-01'),
      credentialId: 'secret-ish',
      publicKey: 'pub',
    });
    const { req, res } = makeReqRes({ response: attestation, name: 'Laptop' });

    await registerHandler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const { passkey } = res._getJSONData();
    expect(passkey).toMatchObject({ id: 'pk-1', name: 'Laptop', lastUsedAt: null });
    expect(passkey.publicKey).toBeUndefined();
    expect(mockLogAuthAudit.mock.calls[0][1]).toMatchObject({ userId: 'user-1', event: 'passkey_registered' });
  });

  it('maps a ceremony error to its status without auditing', async () => {
    mockFinishRegistration.mockRejectedValue(passkeyError('limit_reached'));
    const { req, res } = makeReqRes({ response: attestation });

    await registerHandler(req as any, res as any);

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ code: 'limit_reached' });
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
  });
});

describe('/api/auth/mfa/passkey/register-options', () => {
  it('issues creation options only after a valid authenticator code', async () => {
    mockVerifyTOTP.mockReturnValue(true);
    mockStartRegistration.mockResolvedValue({ challenge: 'chal' });
    const { req, res } = makeReqRes({ token: '123456' });

    await registerOptionsHandler(req as any, res as any);

    expect(mockVerifyTOTP).toHaveBeenCalledWith('SECRET', '123456');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ challenge: 'chal' });
  });

  it('refuses a stolen session that cannot produce a current code, counting the miss', async () => {
    mockVerifyTOTP.mockReturnValue(false);
    mockRecordFailedAttempt.mockResolvedValue({ id: 'user-1', mfa: { failedAttempts: 1 } });
    const { req, res } = makeReqRes({ token: '000000' });

    await registerOptionsHandler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ attemptsRemaining: 2 });
    expect(mockRecordFailedAttempt).toHaveBeenCalledWith('user-1');
    expect(mockStartRegistration).not.toHaveBeenCalled();
  });

  it('honours the shared MFA lockout', async () => {
    mockFindByIdWithMfaSecrets.mockResolvedValue({
      id: 'user-1',
      mfa: { totpEnabled: true, totpSecret: 'SECRET', lockedUntil: new Date(Date.now() + 60_000) },
    });
    const { req, res } = makeReqRes({ token: '123456' });

    await registerOptionsHandler(req as any, res as any);

    expect(res._getStatusCode()).toBe(423);
    expect(mockVerifyTOTP).not.toHaveBeenCalled();
  });

  it('rejects a request without a code', async () => {
    const { req, res } = makeReqRes({});
    await expect(registerOptionsHandler(req as any, res as any)).rejects.toThrow();
    expect(mockStartRegistration).not.toHaveBeenCalled();
  });
});
