import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Trusts are deliberately not keyed on tokenVersion, so nothing revokes them implicitly.
// These cases pin the two remediation paths that MUST drop them explicitly: a user
// turning MFA off (no second factor left to skip) and an admin force-resetting a
// compromised user's MFA (the attacker's cookie would otherwise outlive the reset).

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const mockLogAuthAudit = vi.fn((..._args: any[]) => Promise.resolve());
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: any[]) => mockLogAuthAudit(...a) }));

const mockClearCookie = vi.fn();
vi.mock('@server/auth/trustedDevice', () => ({ clearTrustedDeviceCookie: (...a: any[]) => mockClearCookie(...a) }));

const mockRevokeAllForUser = vi.fn();
const mockFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: any[]) => mockFindById(...a) },
  adminSettingsRepository: { findBySettingName: vi.fn(() => Promise.resolve(null)) },
  authSessionRepository: {},
  trustedDeviceRepository: { revokeAllForUser: (...a: any[]) => mockRevokeAllForUser(...a) },
}));

const mockDisableMFA = vi.fn();
const mockForceResetMFA = vi.fn();
vi.mock('@bike4mind/services', () => ({
  mfaService: {
    disableMFA: (...a: any[]) => mockDisableMFA(...a),
    forceResetMFA: (...a: any[]) => mockForceResetMFA(...a),
  },
  userService: { revokeUserSessions: vi.fn(() => Promise.resolve()) },
}));

vi.mock('@bike4mind/common', () => ({ redactUserSecretsForSelf: (user: unknown) => user }));

import disableHandler from '@pages/api/auth/mfa/disable';
import forceResetHandler from '@pages/api/auth/mfa/force-reset';

const makeReqRes = (user: unknown, body?: unknown) => {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = user;
  (req as any).body = body ?? {};
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
};

const revokedEvents = () =>
  mockLogAuthAudit.mock.calls.filter(([, payload]: any[]) => payload.event === 'trusted_device_revoked');

beforeEach(() => {
  vi.clearAllMocks();
  mockRevokeAllForUser.mockResolvedValue(2);
});

describe('/api/auth/mfa/disable', () => {
  beforeEach(() => {
    mockFindById.mockResolvedValue({ id: 'user-1' });
    mockDisableMFA.mockResolvedValue({ success: true });
  });

  it('revokes every trust and clears this browser cookie', async () => {
    const { req, res } = makeReqRes({ id: 'user-1' });

    await disableHandler(req as any, res as any);

    expect(mockRevokeAllForUser).toHaveBeenCalledWith('user-1');
    expect(mockClearCookie).toHaveBeenCalledWith(res);
    expect(revokedEvents()).toHaveLength(1);
    expect(revokedEvents()[0][1]).toMatchObject({ userId: 'user-1', metadata: { revoked: 2, scope: 'all' } });
  });

  it('skips the audit entry when there was nothing to revoke', async () => {
    mockRevokeAllForUser.mockResolvedValue(0);
    const { req, res } = makeReqRes({ id: 'user-1' });

    await disableHandler(req as any, res as any);

    expect(revokedEvents()).toHaveLength(0);
  });
});

describe('/api/auth/mfa/force-reset', () => {
  beforeEach(() => {
    mockForceResetMFA.mockResolvedValue({ success: true, user: { id: 'target-1' } });
  });

  it("revokes the target user's trusts so a stolen cookie cannot outlive the reset", async () => {
    const { req, res } = makeReqRes({ id: 'admin-1', isAdmin: true }, { userId: 'target-1' });

    await forceResetHandler(req as any, res as any);

    expect(mockRevokeAllForUser).toHaveBeenCalledWith('target-1');
    expect(revokedEvents()[0][1]).toMatchObject({
      userId: 'target-1',
      actorUserId: 'admin-1',
      metadata: { reason: 'mfa_force_reset' },
    });
    // The admin is not the target: clearing the responding browser's cookie would be wrong.
    expect(mockClearCookie).not.toHaveBeenCalled();
  });

  it('revokes nothing for a non-admin caller', async () => {
    const { req, res } = makeReqRes({ id: 'user-9', isAdmin: false }, { userId: 'target-1' });

    await forceResetHandler(req as any, res as any);

    expect(res._getStatusCode()).toBe(403);
    expect(mockRevokeAllForUser).not.toHaveBeenCalled();
  });
});
