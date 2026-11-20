import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CURRENT_POLICY_VERSION, MODERATION_PAGE_READ, missingAdminPermissionMessage } from '@bike4mind/common';

const { mockUserFind, mockIncidents, mockAuth, mockAuthByEvent } = vi.hoisted(() => ({
  mockUserFind: vi.fn(),
  mockIncidents: vi.fn(),
  mockAuth: vi.fn(),
  mockAuthByEvent: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock()
);

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
  imageModerationIncidentRepository: { find: (...a: unknown[]) => mockIncidents(...a) },
  userAuthAuditLogRepository: {
    findByUser: (...a: unknown[]) => mockAuth(...a),
    findByUserAndEvent: (...a: unknown[]) => mockAuthByEvent(...a),
  },
  USER_AUTH_AUDIT_EVENTS: [
    'login_success',
    'logout',
    'password_reset',
    'mfa_enrolled',
    'mfa_disabled',
    'oauth_link',
    'oauth_unlink',
    'session_revoked',
    'session_reuse_revoked',
    'session_recovered',
    'refresh_replay_capped',
    'refresh_recovery_capped',
    'trusted_device_granted',
    'trusted_device_used',
    'trusted_device_revoked',
  ],
}));

import handler from '../compliance';

const run = ({ user, userId = 'u1', event }: { user?: unknown; userId?: string; event?: string } = {}) => {
  const query: Record<string, string> = { userId };
  if (event !== undefined) query.event = event;
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  mockUserFind.mockReset().mockResolvedValue({
    id: 'u1',
    aupAcceptedVersion: null,
    aupAcceptedAt: null,
    ageAttestedAdult: null,
    isBanned: false,
    isModerated: false,
    disputePending: false,
  });
  mockIncidents.mockReset().mockResolvedValue([]);
  mockAuth.mockReset().mockResolvedValue([]);
  mockAuthByEvent.mockReset().mockResolvedValue([]);
});

describe('GET /api/admin/users/:userId/compliance', () => {
  it('declares MODERATION_PAGE_READ for GET', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual(
      expect.objectContaining({ adminPermissions: { GET: MODERATION_PAGE_READ } })
    );
  });

  it('refuses a delegate without a moderation read permission before ANY data source', async () => {
    const { promise } = run({ user: { id: 'u2', isAdmin: false, adminPermissions: ['credits:adjust'] } });
    await expect(promise).rejects.toMatchObject({
      statusCode: 403,
      message: missingAdminPermissionMessage(MODERATION_PAGE_READ),
    });
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockIncidents).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    const { res, promise } = run({ user: { id: 'u2', isAdmin: false, adminPermissions: [permission] } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFind).toHaveBeenCalledTimes(1);
  });

  it('rejects an unauthenticated request (no req.user)', async () => {
    const { promise } = run(); // no user attached
    await expect(promise).rejects.toThrow();
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('returns "never accepted" (isCurrent false) for a user who never accepted the AUP', async () => {
    const { res, promise } = run({ user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.isCurrent).toBe(false);
    expect(body.aupAcceptedVersion).toBeNull();
    expect(body.currentPolicyVersion).toBe(CURRENT_POLICY_VERSION);
    expect(body.flags).toEqual({ isBanned: false, isModerated: false, disputePending: false });
    expect(mockIncidents).toHaveBeenCalledWith({ userId: 'u1' }, { sort: { createdAt: -1 }, limit: 50 });
    expect(mockAuth).toHaveBeenCalledWith('u1', 50);
  });

  it('returns isCurrent true when the user accepted the in-force AUP version', async () => {
    mockUserFind.mockResolvedValue({
      id: 'u1',
      aupAcceptedVersion: CURRENT_POLICY_VERSION,
      aupAcceptedAt: new Date('2026-06-01'),
      ageAttestedAdult: true,
      isBanned: false,
      isModerated: false,
      disputePending: false,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const body = res._getJSONData();
    expect(body.isCurrent).toBe(true);
    expect(body.aupAcceptedVersion).toBe(CURRENT_POLICY_VERSION);
    expect(body.ageAttestedAdult).toBe(true);
    // dates are serialized to ISO strings on the wire
    expect(typeof body.aupAcceptedAt).toBe('string');
  });

  it('returns isCurrent false when the accepted AUP version is stale (e.g. grandfathered)', async () => {
    mockUserFind.mockResolvedValue({
      id: 'u1',
      aupAcceptedVersion: 'grandfathered',
      aupAcceptedAt: new Date('2025-01-01'),
      ageAttestedAdult: true,
      isBanned: false,
      isModerated: false,
      disputePending: false,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const body = res._getJSONData();
    expect(body.aupAcceptedVersion).toBe('grandfathered');
    expect(body.isCurrent).toBe(false);
  });

  it('rejects with "User not found" and hits no data sources when the user is absent', async () => {
    mockUserFind.mockResolvedValue(null);
    const { promise } = run({ user: ADMIN });
    await expect(promise).rejects.toThrow();
    expect(mockIncidents).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('routes to findByUserAndEvent when ?event= is a valid audit event type', async () => {
    mockAuthByEvent.mockResolvedValue([
      {
        event: 'session_reuse_revoked',
        actorIp: '1.2.3.4',
        userAgent: 'ua',
        actorUserId: undefined,
        createdAt: new Date('2026-09-01'),
      },
    ]);
    const { res, promise } = run({ user: ADMIN, event: 'session_reuse_revoked' });
    await promise;
    expect(mockAuthByEvent).toHaveBeenCalledWith('u1', 'session_reuse_revoked', 50);
    expect(mockAuth).not.toHaveBeenCalled();
    const body = res._getJSONData();
    expect(body.recentAuthEvents).toHaveLength(1);
    expect(body.recentAuthEvents[0].event).toBe('session_reuse_revoked');
  });

  it('falls back to findByUser when no ?event= param is provided', async () => {
    const { promise } = run({ user: ADMIN });
    await promise;
    expect(mockAuth).toHaveBeenCalledWith('u1', 50);
    expect(mockAuthByEvent).not.toHaveBeenCalled();
  });

  it('rejects with an error when ?event= is not a valid audit event type', async () => {
    const { promise } = run({ user: ADMIN, event: 'not_a_real_event' });
    await expect(promise).rejects.toThrow();
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockAuthByEvent).not.toHaveBeenCalled();
  });
});
