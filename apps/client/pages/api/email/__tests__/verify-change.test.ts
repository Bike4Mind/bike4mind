import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

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

const mockEndAllUserSessions = vi.fn();
vi.mock('@server/auth/endUserSessions', () => ({
  endAllUserSessions: (...a: unknown[]) => mockEndAllUserSessions(...a),
}));

const mockFindByPendingToken = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findByPendingEmailToken: (...a: unknown[]) => mockFindByPendingToken(...a),
    update: vi.fn(),
  },
}));

const mockVerifyEmailChange = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: { verifyEmailChange: (...a: unknown[]) => mockVerifyEmailChange(...a) },
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
    mockVerifyEmailChange.mockResolvedValue(undefined);
    mockEndAllUserSessions.mockResolvedValue(1);
  });

  it('signs the user out everywhere once the new email is confirmed', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockEndAllUserSessions).toHaveBeenCalledWith(req, 'user-1', { reason: 'email_changed' });
    expect(mockVerifyEmailChange.mock.invocationCallOrder[0]).toBeLessThan(
      mockEndAllUserSessions.mock.invocationCallOrder[0]
    );
  });

  it('leaves sessions alone when the change itself fails', async () => {
    mockVerifyEmailChange.mockRejectedValue(new Error('Token has expired'));
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toThrow('Token has expired');
    expect(mockEndAllUserSessions).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'expired' }), req.logger);
  });

  it('fails the request without auditing a failed change when only the revoke fails', async () => {
    mockEndAllUserSessions.mockRejectedValue(new Error('db down'));
    const { req, res } = fire();

    await expect(handler(req, res)).rejects.toThrow('db down');
    // The email did change, so the audit trail must not record the change as failed.
    expect(mockLogAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'failed' }), req.logger);
  });

  it('rejects an unknown token without touching sessions', async () => {
    mockFindByPendingToken.mockResolvedValue(null);
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockEndAllUserSessions).not.toHaveBeenCalled();
  });
});
