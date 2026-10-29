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
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
// logAuditEvent writes a CounterLog row; an own email change must never reach it.
const mockLogAuditEvent = vi.fn();
vi.mock('@server/utils/auditLog', () => ({
  logAuditEvent: (...a: unknown[]) => mockLogAuditEvent(...a),
  calculateTokenAge: vi.fn(() => 0),
}));
const mockLogAuthAudit = vi.fn();
vi.mock('@server/utils/authAudit', () => ({
  logAuthAudit: (...a: unknown[]) => mockLogAuthAudit(...a),
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
    expect(mockLogAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'email_change_failed',
      metadata: {
        reason: 'token_expired',
        oldEmail: 'old@example.com',
        newEmail: 'new@example.com',
        tokenAge: undefined,
        error: 'Token has expired',
      },
    });
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('audits a reused token as a failed change with its reason', async () => {
    mockVerifyEmailChange.mockRejectedValue(new Error('This link has already been used'));
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toThrow('already been used');
    expect(mockLogAuthAudit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        event: 'email_change_failed',
        metadata: expect.objectContaining({ reason: 'token_reused' }),
      })
    );
  });

  it('fails the request, audited as a failed change, when the session end rolls it back', async () => {
    mockSessionEnded.mockRejectedValue(new Error('db down'));
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toThrow('db down');
    expect(mockLogAuthAudit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ event: 'email_change_failed', metadata: expect.objectContaining({ reason: 'error' }) })
    );
    expect(mockLogAuthAudit).not.toHaveBeenCalledWith(
      req,
      expect.objectContaining({ event: 'email_change_confirmed' })
    );
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
    expect(mockLogAuthAudit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        event: 'email_change_failed',
        metadata: expect.objectContaining({ error: 'This email address is no longer available.' }),
      })
    );
  });

  it('audits the normalized pending address', async () => {
    mockFindByPendingToken.mockResolvedValue({ ...USER, pendingEmail: ' New@B.test ' });
    const { req, res } = fire();

    await handler(req, res);

    expect(mockLogAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'email_change_confirmed',
      metadata: { oldEmail: 'old@example.com', newEmail: 'new@b.test', tokenAge: undefined },
    });
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });
});
