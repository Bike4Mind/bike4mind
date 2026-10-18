import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ConflictError } from '@bike4mind/common';

// Middleware is stripped so the handler body runs directly (same pattern as verify.test.ts).
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next?.() }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
const mockLogAuditEvent = vi.fn();
vi.mock('@server/utils/auditLog', () => ({
  logAuditEvent: (...a: unknown[]) => mockLogAuditEvent(...a),
  EmailAuditEvents: {
    EMAIL_CHANGE_SUCCESS: 'success',
    EMAIL_CHANGE_FAILED: 'failed',
    EMAIL_CHANGE_TOKEN_REUSED: 'reused',
    EMAIL_CHANGE_TOKEN_EXPIRED: 'expired',
  },
  calculateTokenAge: vi.fn(() => 0),
}));
vi.mock('@server/entitlements/invalidate', () => ({ pushEntitlementInvalidation: vi.fn() }));

// Runs the change and the session-end decision as the real helper does (its transaction and
// revoke are covered in server/auth/endUserSessions.test.ts); a decided end is recorded.
const mockSessionEnded = vi.fn();
vi.mock('@server/auth/endUserSessions', () => ({
  commitWithSessionEnd: async (
    _req: unknown,
    change: () => Promise<unknown>,
    sessionEndFor: (r: unknown) => unknown
  ) => {
    const result = await change();
    await mockSessionEnded(sessionEndFor(result));
    return result;
  },
}));

const mockReleaseVerifiedPending = vi.fn();
const mockIsEligibleForFreeCredits = vi.fn();
vi.mock('@server/auth/emailVerifiedGrants', () => ({
  releaseVerifiedPendingFreeCredits: (...a: unknown[]) => mockReleaseVerifiedPending(...a),
  isEligibleForFreeCredits: (...a: unknown[]) => mockIsEligibleForFreeCredits(...a),
}));
const mockApplySignupDomainGrant = vi.fn();
vi.mock('@server/entitlements/signupDomainGrant', () => ({
  applySignupDomainGrant: (...a: unknown[]) => mockApplySignupDomainGrant(...a),
}));

const mockFindByPendingToken = vi.fn();
const mockExistsOtherUserWithEmail = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findByPendingEmailToken: (...a: unknown[]) => mockFindByPendingToken(...a),
    existsOtherUserWithEmail: (...a: unknown[]) => mockExistsOtherUserWithEmail(...a),
    update: vi.fn(),
  },
}));

const mockVerifyEmailChange = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: {
    EMAIL_NO_LONGER_AVAILABLE_MESSAGE: 'This email address is no longer available.',
    verifyEmailChange: (...a: unknown[]) => mockVerifyEmailChange(...a),
  },
}));

import handler from '@pages/api/email/verify-change';

const USER = { id: 'user-1', email: 'old@example.com', pendingEmail: 'new@example.com' };

function fire() {
  const { req, res } = createMocks({ method: 'POST', body: { token: 'change-token' } });
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  (req as any).logger = { warn: vi.fn(), log: vi.fn() };
  return { req: req as any, res: res as any };
}

describe('POST /api/email/verify-change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByPendingToken.mockResolvedValue(USER);
    mockVerifyEmailChange.mockResolvedValue('changed');
    mockSessionEnded.mockResolvedValue(undefined);
    mockIsEligibleForFreeCredits.mockResolvedValue(true);
  });

  it('signs the user out everywhere once the new email is confirmed', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockSessionEnded).toHaveBeenCalledWith({ userId: 'user-1', reason: 'email_changed' });
  });

  it('releases the deferred free credits for the user once the change succeeds, without the domain grant', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(mockReleaseVerifiedPending).toHaveBeenCalledTimes(1);
    expect(mockReleaseVerifiedPending).toHaveBeenCalledWith(USER, 'email change (email verified)', req.logger);
    expect(mockApplySignupDomainGrant).not.toHaveBeenCalled();
  });

  it('withholds the deferred free credits when the new address is disposable', async () => {
    mockIsEligibleForFreeCredits.mockResolvedValue(false);
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockIsEligibleForFreeCredits).toHaveBeenCalledWith('new@example.com', req.logger);
    expect(mockReleaseVerifiedPending).not.toHaveBeenCalled();
  });

  it('releases nothing when the new address is unavailable', async () => {
    mockVerifyEmailChange.mockResolvedValue('unavailable');
    const { req, res } = fire();

    await handler(req, res).catch(() => undefined);

    expect(mockReleaseVerifiedPending).not.toHaveBeenCalled();
    expect(mockApplySignupDomainGrant).not.toHaveBeenCalled();
  });

  it('leaves sessions alone when the change itself fails', async () => {
    mockVerifyEmailChange.mockRejectedValue(new Error('Token has expired'));
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toThrow('Token has expired');
    expect(mockSessionEnded).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'expired' }), req.logger);
  });

  it('fails the request, audited as a failed change, when the session end rolls it back', async () => {
    mockSessionEnded.mockRejectedValue(new Error('db down'));
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toThrow('db down');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'failed' }), req.logger);
    expect(mockLogAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'success' }), req.logger);
  });

  it('rejects an unknown token without touching sessions', async () => {
    mockFindByPendingToken.mockResolvedValue(null);
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockSessionEnded).not.toHaveBeenCalled();
  });

  it('wires the availability lookup through to the repository', async () => {
    mockVerifyEmailChange.mockImplementation(
      async (
        _params: unknown,
        { db }: { db: { users: { existsOtherUserWithEmail: (email: string, id?: string) => unknown } } }
      ) => {
        await db.users.existsOtherUserWithEmail('new@example.com', 'user-1');
        return 'changed';
      }
    );
    const { req, res } = fire();
    await handler(req, res);

    expect(mockExistsOtherUserWithEmail).toHaveBeenCalledWith('new@example.com', 'user-1');
  });

  it('audits and surfaces an unavailable address as a 409 with the service message', async () => {
    mockVerifyEmailChange.mockResolvedValue('unavailable');
    const { req, res } = fire();

    const error = await handler(req, res).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).statusCode).toBe(409);
    expect((error as ConflictError).message).toBe('This email address is no longer available.');
    expect(mockSessionEnded).toHaveBeenCalledWith(undefined);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'failed', error: 'This email address is no longer available.' }),
      req.logger
    );
  });

  it('audits the normalized pending address', async () => {
    mockFindByPendingToken.mockResolvedValue({ ...USER, pendingEmail: ' New@B.test ' });
    const { req, res } = fire();

    await handler(req, res);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'success', newEmail: 'new@b.test' }),
      req.logger
    );
  });
});
