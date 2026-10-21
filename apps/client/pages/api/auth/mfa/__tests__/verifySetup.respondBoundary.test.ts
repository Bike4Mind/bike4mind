import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { InternalServerError } from '@bike4mind/common';
import { MfaAttemptRejectedError } from '@bike4mind/auth/mfaService';

const { mockFindWithSecrets, mockRecordFailed, mockVerifyMFASetup, mockIssueSession } = vi.hoisted(() => ({
  mockFindWithSecrets: vi.fn(),
  mockRecordFailed: vi.fn(),
  mockVerifyMFASetup: vi.fn(),
  mockIssueSession: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findByIdWithMfaSecrets: (...a: unknown[]) => mockFindWithSecrets(...a),
    atomicRecordMfaFailedAttempt: (...a: unknown[]) => mockRecordFailed(...a),
  },
  authSessionRepository: {},
  realtimeConnectionRepository: {},
  passkeyCredentialRepository: { removeAllForUser: vi.fn() },
}));
vi.mock('@bike4mind/services', async () => {
  const { isMfaAttemptRejectedError, recordFailedMfaAttempt } =
    await vi.importActual<typeof import('@bike4mind/auth/mfaService')>('@bike4mind/auth/mfaService');
  return {
    mfaService: {
      verifyMFASetup: (...a: unknown[]) => mockVerifyMFASetup(...a),
      isUserLockedOut: (user: { mfa?: { lockedUntil?: Date } }) => !!user?.mfa?.lockedUntil,
      getLockoutTimeRemaining: () => 15,
      isMfaAttemptRejectedError,
      recordFailedMfaAttempt,
      MAX_FAILED_ATTEMPTS: 3,
    },
    userService: { revokeUserSessions: vi.fn().mockResolvedValue(2) },
  };
});
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: (...a: unknown[]) => mockIssueSession(...a),
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));

import handler from '../verify-setup';

const run = () => {
  const { req, res } = createMocks({ method: 'POST', body: { token: '123456' } });
  (req as any).user = { id: 'u1' };
  return { res, promise: (handler as any)(req, res) as Promise<void> };
};

describe('POST /api/auth/mfa/verify-setup - response boundary', () => {
  beforeEach(() => {
    mockFindWithSecrets.mockReset().mockResolvedValue({ id: 'u1', mfa: { totpEnabled: true } });
    mockRecordFailed.mockReset();
    mockVerifyMFASetup.mockReset().mockResolvedValue({ success: true, user: { id: 'u1' } });
    mockIssueSession.mockReset();
  });

  it('returns the setup body on success', async () => {
    mockIssueSession.mockResolvedValue({ accessToken: 'tok' });
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true, accessToken: 'tok' });
    expect(mockRecordFailed).not.toHaveBeenCalled();
  });

  it('surfaces a schema failure after the session is issued as a 500 without booking a failed MFA attempt', async () => {
    mockIssueSession.mockResolvedValue({ accessToken: 12345 });
    const { res, promise } = run();
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(InternalServerError);
    expect(error).toMatchObject({ statusCode: 500 });
    expect(mockIssueSession).toHaveBeenCalled();
    expect(mockRecordFailed).not.toHaveBeenCalled();
    expect(res._isEndCalled()).toBe(false);
  });

  it('responds from attemptState for a rejected code and does not book the attempt again', async () => {
    mockVerifyMFASetup.mockRejectedValue(
      new MfaAttemptRejectedError('Invalid TOTP code.', { id: 'u1', mfa: { failedAttempts: 1 } } as never)
    );
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ attemptsRemaining: 2 });
    expect(mockRecordFailed).not.toHaveBeenCalled();
  });

  it('answers 423 from attemptState when the rejection came from an active lockout', async () => {
    const lockedUntil = new Date(Date.now() + 60_000);
    mockVerifyMFASetup.mockRejectedValue(
      new MfaAttemptRejectedError('Too many failed attempts.', {
        id: 'u1',
        mfa: { failedAttempts: 3, lockedUntil },
      } as never)
    );
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(423);
    expect(mockRecordFailed).not.toHaveBeenCalled();
  });

  it('still books a failed attempt when the setup code is wrong', async () => {
    mockVerifyMFASetup.mockRejectedValue(new Error('Invalid MFA code'));
    mockRecordFailed.mockResolvedValue({ mfa: { failedAttempts: 1 } });
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockRecordFailed).toHaveBeenCalledWith('u1');
  });
});
