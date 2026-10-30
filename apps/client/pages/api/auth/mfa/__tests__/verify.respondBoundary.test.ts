import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { InternalServerError } from '@bike4mind/common';
import { MfaAttemptRejectedError } from '@bike4mind/auth/mfaService';
import { secretUserFields, expectSelfUserStripped } from '@server/auth/__tests__/sessionUserSecrets';

const { mockFindWithSecrets, mockRecordFailed, mockVerifyMFA, mockCompleteMfaLogin } = vi.hoisted(() => ({
  mockFindWithSecrets: vi.fn(),
  mockRecordFailed: vi.fn(),
  mockVerifyMFA: vi.fn(),
  mockCompleteMfaLogin: vi.fn(),
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
}));
vi.mock('@bike4mind/services', async () => {
  const { isMfaAttemptRejectedError, recordFailedMfaAttempt } =
    await vi.importActual<typeof import('@bike4mind/auth/mfaService')>('@bike4mind/auth/mfaService');
  return {
    mfaService: {
      verifyMFA: (...a: unknown[]) => mockVerifyMFA(...a),
      isUserLockedOut: (user: { mfa?: { lockedUntil?: Date } }) => !!user?.mfa?.lockedUntil,
      getLockoutTimeRemaining: () => 15,
      isMfaAttemptRejectedError,
      recordFailedMfaAttempt,
      MAX_FAILED_ATTEMPTS: 3,
    },
  };
});
vi.mock('@server/auth/completeMfaLogin', () => ({
  completeMfaLogin: (...a: unknown[]) => mockCompleteMfaLogin(...a),
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  redactUserSecretsForSelf: (user: unknown) => user,
}));

import handler from '../verify';

const run = () => {
  const { req, res } = createMocks({ method: 'POST', body: { token: '123456' } });
  (req as any).user = { id: 'u1' };
  return { res, promise: (handler as any)(req, res) as Promise<void> };
};

describe('POST /api/auth/mfa/verify - response boundary', () => {
  beforeEach(() => {
    mockFindWithSecrets.mockReset().mockResolvedValue({ id: 'u1', mfa: { totpEnabled: true } });
    mockRecordFailed.mockReset();
    mockVerifyMFA.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    mockCompleteMfaLogin.mockReset();
  });

  it('returns the login body on success', async () => {
    mockCompleteMfaLogin.mockResolvedValue({ accessToken: 'tok', deviceRemembered: false });
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ verified: true, accessToken: 'tok', deviceRemembered: false });
    expect(mockRecordFailed).not.toHaveBeenCalled();
  });

  it('strips secrets and undeclared fields from the user in the response', async () => {
    mockVerifyMFA.mockResolvedValue({ user: { id: 'u1', ...secretUserFields() } });
    mockCompleteMfaLogin.mockResolvedValue({ accessToken: 'tok', deviceRemembered: false });
    const { res, promise } = run();
    await promise;
    const body = res._getJSONData();
    expect(body.accessToken).toBe('tok');
    expectSelfUserStripped(body.user, body, 'u1');
  });

  it('surfaces a schema failure after a successful login as a 500 without booking a failed MFA attempt', async () => {
    mockCompleteMfaLogin.mockResolvedValue({ accessToken: 12345, deviceRemembered: false });
    const { res, promise } = run();
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(InternalServerError);
    expect(error).toMatchObject({ statusCode: 500 });
    expect(mockCompleteMfaLogin).toHaveBeenCalled();
    expect(mockRecordFailed).not.toHaveBeenCalled();
    expect(res._isEndCalled()).toBe(false);
  });

  it('responds from attemptState for a rejected code and does not book the attempt again', async () => {
    mockVerifyMFA.mockRejectedValue(
      new MfaAttemptRejectedError('Invalid TOTP or backup code.', { id: 'u1', mfa: { failedAttempts: 1 } } as never)
    );
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ attemptsRemaining: 2 });
    expect(mockRecordFailed).not.toHaveBeenCalled();
  });

  it('answers 423 from attemptState when the rejection came from an active lockout', async () => {
    const lockedUntil = new Date(Date.now() + 60_000);
    mockVerifyMFA.mockRejectedValue(
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

  it('still books a failed attempt when the MFA check itself fails', async () => {
    mockVerifyMFA.mockRejectedValue(new Error('Invalid code'));
    mockRecordFailed.mockResolvedValue({ mfa: { failedAttempts: 1 } });
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockRecordFailed).toHaveBeenCalledWith('u1');
  });
});
