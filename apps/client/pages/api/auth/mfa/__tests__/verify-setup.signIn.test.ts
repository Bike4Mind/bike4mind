import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  findByIdWithMfaSecrets: vi.fn(),
  verifyMFASetup: vi.fn(),
  revokeUserSessions: vi.fn(),
  issueBrowserSession: vi.fn(),
  logAuthAudit: vi.fn(),
  logSecondFactorSignIn: vi.fn(),
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
  passkeyCredentialRepository: { removeAllForUser: vi.fn() },
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: {
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

import handler from '../verify-setup';

async function verifySetupAs(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body: { token: '123456' } });
  (req as any).user = user;
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByIdWithMfaSecrets.mockResolvedValue({ id: 'u1', mfa: { totpEnabled: true } });
  mocks.verifyMFASetup.mockResolvedValue({ user: { id: 'u1' }, backupCodes: ['aaaa-bbbb'] });
  mocks.revokeUserSessions.mockResolvedValue(4);
  mocks.issueBrowserSession.mockResolvedValue({ accessToken: 'full-access' });
  mocks.logAuthAudit.mockResolvedValue(undefined);
  mocks.logSecondFactorSignIn.mockResolvedValue(undefined);
});

describe('POST /api/auth/mfa/verify-setup - sign-in audit', () => {
  it('records the sign-in that enrollment completed when the pending token carries an origin', async () => {
    const origin = { strategy: 'google', createdVia: 'oauth' };

    const res = await verifySetupAs({ id: 'u1', mfaPending: true, mfaSignIn: origin });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.logSecondFactorSignIn).toHaveBeenCalledTimes(1);
    expect(mocks.logSecondFactorSignIn).toHaveBeenCalledWith(expect.anything(), 'u1', origin);
  });

  it('records no sign-in when an existing session enrolls (no origin)', async () => {
    const res = await verifySetupAs({ id: 'u1' });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.logAuthAudit).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', event: 'mfa_enrolled' });
    expect(mocks.logSecondFactorSignIn).not.toHaveBeenCalled();
  });
});
