import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRevokeUserSessions, mockRevokeTrustedDevices, mockLogAuthAudit, mockWithTransaction } = vi.hoisted(() => ({
  mockRevokeUserSessions: vi.fn(),
  mockRevokeTrustedDevices: vi.fn(),
  mockLogAuthAudit: vi.fn(),
  mockWithTransaction: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { name: 'users' },
  authSessionRepository: { name: 'authSessions' },
  realtimeConnectionRepository: { name: 'realtimeConnections' },
  trustedDeviceRepository: { revokeAllForUser: (...a: unknown[]) => mockRevokeTrustedDevices(...a) },
  withTransaction: (fn: () => unknown) => mockWithTransaction(fn),
}));
vi.mock('@bike4mind/services', () => ({
  userService: { revokeUserSessions: (...a: unknown[]) => mockRevokeUserSessions(...a) },
}));
vi.mock('@server/utils/authAudit', () => ({
  logAuthAudit: (...a: unknown[]) => mockLogAuthAudit(...a),
}));

import { commitWithSessionEnd } from './endUserSessions';

// any: only the logger is read off the request here, plus whatever logAuthAudit (mocked) needs.
const req = { logger: { log: vi.fn() } } as any;

/** Records whether each step ran inside the (mocked) transaction callback. */
let inTransaction = false;
const ranInTransaction: Record<string, boolean> = {};

describe('commitWithSessionEnd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inTransaction = false;
    for (const key of Object.keys(ranInTransaction)) delete ranInTransaction[key];
    mockWithTransaction.mockImplementation(async (fn: () => unknown) => {
      inTransaction = true;
      try {
        return await fn();
      } finally {
        inTransaction = false;
      }
    });
    mockRevokeUserSessions.mockImplementation(async () => {
      ranInTransaction.revokeSessions = inTransaction;
      return 7;
    });
    mockRevokeTrustedDevices.mockImplementation(async () => {
      ranInTransaction.revokeDevices = inTransaction;
      return 0;
    });
    mockLogAuthAudit.mockImplementation(async () => {
      ranInTransaction.audit = inTransaction;
    });
  });

  it('commits the change and the revoke in one transaction, then audits', async () => {
    const change = vi.fn(async () => {
      ranInTransaction.change = inTransaction;
      return 'changed';
    });

    const result = await commitWithSessionEnd(req, change, () => ({ userId: 'user-1', reason: 'password_changed' }));

    expect(result).toBe('changed');
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(ranInTransaction).toEqual({ change: true, revokeSessions: true, revokeDevices: true, audit: false });
    expect(mockRevokeUserSessions).toHaveBeenCalledWith('user-1', {
      db: {
        users: { name: 'users' },
        authSessions: { name: 'authSessions' },
        realtimeConnections: { name: 'realtimeConnections' },
      },
      logger: req.logger,
    });
    expect(mockRevokeTrustedDevices).toHaveBeenCalledWith('user-1');
  });

  it('decides from the committed result and revokes nothing when no session end is due', async () => {
    const sessionEndFor = vi.fn(() => undefined);

    await commitWithSessionEnd(req, async () => 'unchanged', sessionEndFor);

    expect(sessionEndFor).toHaveBeenCalledWith('unchanged');
    expect(mockRevokeUserSessions).not.toHaveBeenCalled();
    expect(mockRevokeTrustedDevices).not.toHaveBeenCalled();
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
  });

  it('audits the revoke with its reason and actor', async () => {
    await commitWithSessionEnd(
      req,
      async () => undefined,
      () => ({ userId: 'user-1', reason: 'account_blocked', actorUserId: 'admin-1' })
    );

    expect(mockLogAuthAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'session_revoked',
      actorUserId: 'admin-1',
      metadata: { reason: 'account_blocked' },
    });
  });

  it('audits the trusted-device revoke only when one was dropped', async () => {
    mockRevokeTrustedDevices.mockResolvedValue(2);

    await commitWithSessionEnd(
      req,
      async () => undefined,
      () => ({ userId: 'user-1', reason: 'email_changed' })
    );

    expect(mockLogAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'trusted_device_revoked',
      actorUserId: undefined,
      metadata: { revoked: 2, scope: 'all', reason: 'email_changed' },
    });
  });

  it('fails the whole transaction, unaudited, when the revoke fails', async () => {
    mockRevokeUserSessions.mockRejectedValue(new Error('db down'));

    await expect(
      commitWithSessionEnd(
        req,
        async () => undefined,
        () => ({ userId: 'user-1', reason: 'password_changed' })
      )
    ).rejects.toThrow('db down');
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
  });
});
