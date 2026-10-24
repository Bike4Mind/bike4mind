import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockForceResetMFA, mockRemovePasskeys, mockRevokeDevices, mockRecord, mockDeny, mockLogAuthAudit, txEvents } =
  vi.hoisted(() => ({
    mockForceResetMFA: vi.fn(),
    mockRemovePasskeys: vi.fn(),
    mockRevokeDevices: vi.fn(),
    mockRecord: vi.fn(),
    mockDeny: vi.fn(),
    mockLogAuthAudit: vi.fn(),
    txEvents: [] as string[],
  }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/services', () => ({
  mfaService: { forceResetMFA: (...a: unknown[]) => mockForceResetMFA(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  trustedDeviceRepository: { revokeAllForUser: (...a: unknown[]) => mockRevokeDevices(...a) },
  passkeyCredentialRepository: { removeAllForUser: (...a: unknown[]) => mockRemovePasskeys(...a) },
  withTransaction: async (fn: () => Promise<unknown>) => {
    txEvents.push('tx:start');
    const result = await fn();
    txEvents.push('tx:end');
    return result;
  },
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: unknown[]) => mockLogAuthAudit(...a) }));
// parseAdminActionReason and isSameUserId stay real so the 400 is the route's own.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecord(...a),
  denySelfAdminAction: (...a: unknown[]) => mockDeny(...a),
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  redactUserSecretsForSelf: (user: unknown) => user,
}));

import { ForbiddenError } from '@bike4mind/common';
import { secretUserFields, expectSelfUserStripped } from '@server/auth/__tests__/sessionUserSecrets';
import handler from '../force-reset';

const REASON = 'Lost authenticator, identity verified by phone';
const ADMIN = { id: 'admin1', isAdmin: true, name: 'Admin', username: 'admin' };

const post = (body: Record<string, unknown>, user: Record<string, unknown> | undefined = ADMIN) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user, logger: { info: vi.fn(), error: vi.fn() } });
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
};

beforeEach(() => {
  txEvents.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mockForceResetMFA.mockReset().mockResolvedValue({
    success: true,
    user: { id: 'target1', name: 'Target', username: 'target', email: 'target@example.com' },
  });
  mockRemovePasskeys.mockReset().mockResolvedValue(2);
  mockRevokeDevices.mockReset().mockResolvedValue(3);
  mockRecord.mockReset().mockResolvedValue(null);
  mockLogAuthAudit.mockReset().mockResolvedValue(undefined);
  mockDeny.mockReset().mockImplementation(async () => {
    throw new ForbiddenError('Admins cannot perform this action on their own account.');
  });
});

describe('POST /api/auth/mfa/force-reset', () => {
  it('answers 403 for a non-admin and touches nothing', async () => {
    const { res, run } = post({ userId: 'target1', reason: REASON }, { id: 'user1', isAdmin: false });
    await run();

    expect(res._getStatusCode()).toBe(403);
    expect(mockForceResetMFA).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('denies resetting your own MFA with a 403 and a user.mfa.denied entry', async () => {
    const { run } = post({ userId: 'ADMIN1', reason: REASON });

    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.mfa.denied',
        attempted: 'user.mfa.reset',
        message: 'Use Profile > Settings > Security to turn off your own MFA.',
      })
    );
    expect(mockForceResetMFA).not.toHaveBeenCalled();
    expect(mockRemovePasskeys).not.toHaveBeenCalled();
  });

  it('denies an impersonating admin resetting the MFA of the account they impersonate from', async () => {
    const { run } = post({ userId: 'A', reason: REASON }, { ...ADMIN, id: 'B', impersonatedBy: 'A' });

    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.mfa.denied', attempted: 'user.mfa.reset' })
    );
    expect(mockForceResetMFA).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['too short', ' abc '],
    ['too long', 'x'.repeat(501)],
  ])('answers 400 and resets nothing when the reason is %s', async (_label, reason) => {
    const { run } = post({ userId: 'target1', reason });

    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockForceResetMFA).not.toHaveBeenCalled();
    expect(mockRemovePasskeys).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('strips secrets and undeclared fields from the user in the response', async () => {
    mockForceResetMFA.mockResolvedValue({ success: true, user: { id: 'target1', ...secretUserFields() } });
    const { res, run } = post({ userId: 'target1', reason: REASON });
    await run();

    const body = res._getJSONData();
    expect(body.success).toBe(true);
    expectSelfUserStripped(body.user, body, 'target1');
  });

  it('resets inside the transaction and records user.mfa.reset with the reason and counts', async () => {
    mockRemovePasskeys.mockImplementation(async () => {
      txEvents.push('passkeys');
      return 2;
    });
    mockForceResetMFA.mockImplementation(async () => {
      txEvents.push('reset');
      return { success: true, user: { id: 'target1', name: 'Target', username: 'target' } };
    });
    mockRevokeDevices.mockImplementation(async () => {
      txEvents.push('devices');
      return 3;
    });
    mockRecord.mockImplementation(async () => {
      txEvents.push('record');
      return null;
    });
    const { res, run } = post({ userId: 'target1', reason: `  ${REASON}  ` });
    await run();

    expect(txEvents).toEqual(['tx:start', 'passkeys', 'reset', 'devices', 'record', 'tx:end']);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.mfa.reset',
        target: expect.objectContaining({ kind: 'user', id: 'target1', displayName: 'Target' }),
        reason: REASON,
        details: { removedPasskeys: 2, revokedDevices: 3 },
      })
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true, user: { id: 'target1' } });
  });

  it('answers 400 with the service message when the MFA reset fails, and records nothing', async () => {
    mockForceResetMFA.mockRejectedValue(new Error('User does not have MFA enabled'));
    const { res, run } = post({ userId: 'target1', reason: REASON });
    await run();

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'User does not have MFA enabled' });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('propagates an audit write failure instead of turning it into a 400', async () => {
    mockRecord.mockRejectedValue(new Error('audit down'));
    const { res, run } = post({ userId: 'target1', reason: REASON });

    await expect(run()).rejects.toThrow('audit down');
    expect(res._getStatusCode()).not.toBe(400);
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
  });
});
