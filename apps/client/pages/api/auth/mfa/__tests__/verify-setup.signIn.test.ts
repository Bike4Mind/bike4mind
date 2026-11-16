import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  findByIdWithMfaSecrets: vi.fn(),
  verifyMFASetup: vi.fn(),
  revokeUserSessions: vi.fn(),
  issueBrowserSession: vi.fn(),
  logAuthAudit: vi.fn(),
  logSecondFactorSignIn: vi.fn(),
  recordForcedEnrollmentStep: vi.fn(),
  removeAllForUser: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findByIdWithMfaSecrets: mocks.findByIdWithMfaSecrets },
  authSessionRepository: {},
  passkeyCredentialRepository: { removeAllForUser: mocks.removeAllForUser },
  realtimeConnectionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: {
    userHasMFAConfigured: (user: { mfa?: { totpEnabled?: boolean; passkeyEnabled?: boolean } }) =>
      !!user?.mfa?.totpEnabled || !!user?.mfa?.passkeyEnabled,
    isUserLockedOut: () => false,
    verifyMFASetup: mocks.verifyMFASetup,
  },
  userService: { revokeUserSessions: mocks.revokeUserSessions },
}));
vi.mock('@server/auth/issueSession', () => ({ issueBrowserSession: mocks.issueBrowserSession }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: mocks.logAuthAudit }));
vi.mock('@server/auth/signInSecondFactor', () => ({
  readSignInOrigin: (user: { mfaSignIn?: unknown } | undefined) => user?.mfaSignIn,
  logSecondFactorSignIn: mocks.logSecondFactorSignIn,
}));

vi.mock('@server/auth/mfaEnrollmentFunnel', () => ({ recordForcedEnrollmentStep: mocks.recordForcedEnrollmentStep }));

import handler from '../verify-setup';

async function verifySetupAs(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body: { token: '123456' } });
  (req as any).user = user;
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByIdWithMfaSecrets.mockResolvedValue({ id: 'u1', mfa: { totpEnabled: false } });
  mocks.verifyMFASetup.mockResolvedValue({ success: true, user: { id: 'u1' }, backupCodes: ['aaaa-bbbb'] });
  mocks.revokeUserSessions.mockResolvedValue(4);
  mocks.issueBrowserSession.mockResolvedValue({ accessToken: 'full-access' });
  mocks.logAuthAudit.mockResolvedValue(undefined);
  mocks.logSecondFactorSignIn.mockResolvedValue(undefined);
});

describe('POST /api/auth/mfa/verify-setup - emergency sign-in', () => {
  it('refuses enrollment for an emergency pending token, without enrolling or minting a session', async () => {
    const res = await verifySetupAs({
      id: 'u1',
      mfaPending: true,
      mfaSignIn: { strategy: 'local', createdVia: 'emergency' },
    });

    expect(res._getStatusCode()).toBe(403);
    expect(mocks.verifyMFASetup).not.toHaveBeenCalled();
    expect(mocks.recordForcedEnrollmentStep).not.toHaveBeenCalled();
    expect(mocks.issueBrowserSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/mfa/verify-setup - account that already has a passkey', () => {
  const passkeyOnly = { id: 'u1', mfa: { totpEnabled: false, passkeyEnabled: true, totpSecret: 'PENDING' } };

  it('refuses a pending token: it has proved only the password, not the passkey', async () => {
    mocks.findByIdWithMfaSecrets.mockResolvedValue(passkeyOnly);

    const res = await verifySetupAs({
      id: 'u1',
      mfaPending: true,
      mfaSignIn: { strategy: 'local', createdVia: 'password' },
    });

    expect(res._getStatusCode()).toBe(403);
    expect(mocks.verifyMFASetup).not.toHaveBeenCalled();
    expect(mocks.issueBrowserSession).not.toHaveBeenCalled();
  });

  it('lets a full session add the app', async () => {
    mocks.findByIdWithMfaSecrets.mockResolvedValue(passkeyOnly);

    const res = await verifySetupAs({ id: 'u1' });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.verifyMFASetup).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/mfa/verify-setup - sign-in audit', () => {
  it('records the sign-in that enrollment completed when the pending token carries an origin', async () => {
    const origin = { strategy: 'google', createdVia: 'oauth' };

    const res = await verifySetupAs({ id: 'u1', mfaPending: true, mfaSignIn: origin });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.logSecondFactorSignIn).toHaveBeenCalledTimes(1);
    expect(mocks.logSecondFactorSignIn).toHaveBeenCalledWith(expect.anything(), 'u1', origin);
    expect(mocks.issueBrowserSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'u1', {
      createdVia: 'oauth',
      tokenVersion: 4,
    });
  });

  it('mints the registration session only after successful MFA setup, preserving OTC origin', async () => {
    const origin = { strategy: 'otc', createdVia: 'otc-registration' };
    expect(mocks.issueBrowserSession).not.toHaveBeenCalled();
    const response = await verifySetupAs({ id: 'u1', mfaPending: true, mfaSignIn: origin });
    expect(response._getStatusCode()).toBe(200);
    expect(mocks.verifyMFASetup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.issueBrowserSession.mock.invocationCallOrder[0]
    );
    expect(mocks.issueBrowserSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'u1', {
      createdVia: 'otc-registration',
      tokenVersion: 4,
    });
    expect(mocks.logSecondFactorSignIn).toHaveBeenCalledWith(expect.anything(), 'u1', origin);
  });

  it('records no sign-in when an existing session enrolls (no origin)', async () => {
    const res = await verifySetupAs({ id: 'u1' });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.logAuthAudit).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', event: 'mfa_enrolled' });
    // Judged on the user as read before enrolling, not on the enrolled result.
    expect(mocks.recordForcedEnrollmentStep).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'u1', mfa: { totpEnabled: false } },
      'mfa_enrollment_completed'
    );
    expect(mocks.logSecondFactorSignIn).not.toHaveBeenCalled();
    expect(mocks.issueBrowserSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'u1', {
      createdVia: 'mfa-setup',
      tokenVersion: 4,
    });
  });
});

describe('POST /api/auth/mfa/verify-setup - orphan passkey purge', () => {
  const setupAt = new Date('2026-01-02T03:04:05.000Z');

  it('bounds the purge at setupAt when the user has no factor', async () => {
    mocks.findByIdWithMfaSecrets.mockResolvedValue({ id: 'u1', mfa: { totpEnabled: false, setupAt } });

    const res = await verifySetupAs({ id: 'u1' });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.removeAllForUser).toHaveBeenCalledTimes(1);
    expect(mocks.removeAllForUser).toHaveBeenCalledWith('u1', { createdBefore: setupAt });
  });

  it('purges unbounded when no setupAt is recorded', async () => {
    mocks.findByIdWithMfaSecrets.mockResolvedValue({ id: 'u1', mfa: { totpEnabled: false } });

    const res = await verifySetupAs({ id: 'u1' });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.removeAllForUser).toHaveBeenCalledTimes(1);
    expect(mocks.removeAllForUser).toHaveBeenCalledWith('u1', undefined);
  });
});
