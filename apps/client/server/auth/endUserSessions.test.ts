import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRevokeUserSessions, mockRevokeTrustedDevices, mockLogAuthAudit } = vi.hoisted(() => ({
  mockRevokeUserSessions: vi.fn(),
  mockRevokeTrustedDevices: vi.fn(),
  mockLogAuthAudit: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { name: 'users' },
  authSessionRepository: { name: 'authSessions' },
  trustedDeviceRepository: { revokeAllForUser: (...a: unknown[]) => mockRevokeTrustedDevices(...a) },
}));
vi.mock('@bike4mind/services', () => ({
  userService: { revokeUserSessions: (...a: unknown[]) => mockRevokeUserSessions(...a) },
}));
vi.mock('@server/utils/authAudit', () => ({
  logAuthAudit: (...a: unknown[]) => mockLogAuthAudit(...a),
}));

import { endAllUserSessions } from './endUserSessions';

// any: only the logger is read off the request here, plus whatever logAuthAudit (mocked) needs.
const req = { logger: { log: vi.fn() } } as any;

describe('endAllUserSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevokeUserSessions.mockResolvedValue(7);
    mockRevokeTrustedDevices.mockResolvedValue(0);
  });

  it('revokes every session and returns the new token version', async () => {
    const tokenVersion = await endAllUserSessions(req, 'user-1', { reason: 'password_changed' });

    expect(tokenVersion).toBe(7);
    expect(mockRevokeUserSessions).toHaveBeenCalledWith('user-1', {
      db: { users: { name: 'users' }, authSessions: { name: 'authSessions' } },
      logger: req.logger,
    });
  });

  it('drops trusted devices too, so no device keeps skipping the second factor', async () => {
    await endAllUserSessions(req, 'user-1', { reason: 'email_changed' });

    expect(mockRevokeTrustedDevices).toHaveBeenCalledWith('user-1');
  });

  it('audits the revoke with its reason and actor', async () => {
    await endAllUserSessions(req, 'user-1', { reason: 'account_blocked', actorUserId: 'admin-1' });

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
    await endAllUserSessions(req, 'user-1', { reason: 'password_changed' });

    expect(mockLogAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'trusted_device_revoked',
      actorUserId: undefined,
      metadata: { revoked: 2, scope: 'all', reason: 'password_changed' },
    });
  });

  it('fails loudly when the session revoke fails', async () => {
    mockRevokeUserSessions.mockRejectedValue(new Error('db down'));

    await expect(endAllUserSessions(req, 'user-1', { reason: 'password_changed' })).rejects.toThrow('db down');
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
  });
});
