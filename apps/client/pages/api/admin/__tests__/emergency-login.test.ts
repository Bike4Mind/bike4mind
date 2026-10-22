import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  userDoc: null as any,
}));

vi.mock('sst', () => ({ Resource: { EMERGENCY_LOGIN_ENABLED: { value: 'true' } } }));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn().mockResolvedValue(true) } }));
vi.mock('@bike4mind/database', () => ({
  User: { findOne: () => ({ select: () => Promise.resolve(mockRefs.userDoc) }) },
}));
vi.mock('@bike4mind/utils/escapeRegex', () => ({ escapeRegex: (s: string) => s }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_q: any, _s: any, next: any) => next() }));
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_q: any, _s: any, next: any) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userHasMFAConfigured: (user: any) => user.mfa?.totpEnabled === true },
}));
const mockResolveSecondFactor = vi.fn();
vi.mock('@server/auth/signInSecondFactor', () => ({
  resolveSecondFactor: (...a: any[]) => mockResolveSecondFactor(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
const mockRecordForActor = vi.fn();
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionForActor: (...a: unknown[]) => mockRecordForActor(...a),
  toUserActor: (user: { id: string }, scope: string) => ({ kind: 'user', scope, userId: user.id }),
}));

import { UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import '@pages/api/admin/emergency-login';

const callHandler = async () => {
  const { req, res } = createMocks({ method: 'POST', body: { username: 'admin', password: 'pw' } });
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  const outcome = await Promise.resolve(mockRefs.postHandler!(req, res)).then(
    () => null,
    (error: unknown) => error
  );
  return { res, outcome };
};

describe('POST /api/admin/emergency-login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.userDoc = { id: 'u1', name: 'Admin', isAdmin: true, password: 'hash', mfa: { totpEnabled: true } };
    mockResolveSecondFactor.mockResolvedValue({ kind: 'challenge', mfaToken: 'pending-tok', passkeyAvailable: true });
    mockRecordForActor.mockResolvedValue(null);
  });

  describe('admin audit', () => {
    it('records user.emergency_login.succeeded with the matched account as actor and target', async () => {
      const { res } = await callHandler();

      expect(res.statusCode).toBe(200);
      expect(mockRecordForActor).toHaveBeenCalledTimes(1);
      expect(mockRecordForActor).toHaveBeenCalledWith(
        expect.anything(),
        { kind: 'user', scope: 'platform', userId: 'u1' },
        expect.objectContaining({
          action: 'user.emergency_login.succeeded',
          target: expect.objectContaining({ kind: 'user', id: 'u1' }),
        })
      );
      expect(JSON.stringify(mockRecordForActor.mock.calls[0])).not.toContain('pending-tok');
    });

    it('denies the login without returning the pending token when the audit write fails', async () => {
      mockRecordForActor.mockRejectedValueOnce(new Error('audit down'));

      const { res, outcome } = await callHandler();

      expect((outcome as Error).message).toBe('audit down');
      expect(res._getData()).toBe('');
      expect(res.getHeader('X-Emergency-Access')).toBeUndefined();
    });

    it.each([
      ['no_second_factor', { mfa: { totpEnabled: false } }],
      ['not_admin', { isAdmin: false }],
      ['banned', { isBanned: true }],
      ['no_password', { password: undefined }],
    ])('records user.emergency_login.denied (%s) and still answers generically', async (reason, overrides) => {
      mockRefs.userDoc = { ...mockRefs.userDoc, ...overrides };

      const { outcome } = await callHandler();

      expect(outcome).toBeInstanceOf(UnauthorizedError);
      expect((outcome as Error).message).toBe('Invalid credentials');
      expect(mockRecordForActor).toHaveBeenCalledTimes(1);
      expect(mockRecordForActor).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userId: 'u1' }),
        expect.objectContaining({ action: 'user.emergency_login.denied', details: { reason } })
      );
    });

    it('records nothing when no account matches', async () => {
      mockRefs.userDoc = null;

      const { outcome } = await callHandler();

      expect(outcome).toBeInstanceOf(UnauthorizedError);
      expect(mockRecordForActor).not.toHaveBeenCalled();
    });
  });

  it('refuses an admin with no second factor enrolled, generically, without a session or challenge', async () => {
    mockRefs.userDoc = { ...mockRefs.userDoc, mfa: { totpEnabled: false } };

    const { outcome } = await callHandler();

    expect(outcome).toBeInstanceOf(UnauthorizedError);
    expect((outcome as Error).message).toBe('Invalid credentials');
    expect(mockResolveSecondFactor).not.toHaveBeenCalled();
  });

  it('answers an enrolled admin with an MFA challenge carrying only the pending token', async () => {
    const { res, outcome } = await callHandler();

    expect(outcome).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      mfaRequired: true,
      passkeyAvailable: true,
      userId: 'u1',
      accessToken: 'pending-tok',
    });
    expect(mockResolveSecondFactor).toHaveBeenCalledWith(expect.anything(), mockRefs.userDoc, {
      origin: { strategy: 'local', createdVia: 'emergency' },
      honourTrustedDevice: false,
    });
    expect(res.getHeader('set-cookie')).toBeUndefined();
  });

  it.each([
    ['satisfied', { kind: 'satisfied', trustedDevice: null }],
    ['enroll', { kind: 'enroll', mfaToken: 'x' }],
  ])('fails closed when the second-factor step resolves %s instead of a challenge', async (kind, resolved) => {
    mockResolveSecondFactor.mockResolvedValue(resolved);

    const { res, outcome } = await callHandler();

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(kind);
    expect(res.getHeader('set-cookie')).toBeUndefined();
  });

  it('passes the passkey availability through', async () => {
    mockResolveSecondFactor.mockResolvedValue({ kind: 'challenge', mfaToken: 'pending-tok', passkeyAvailable: false });

    const { res } = await callHandler();

    expect(res._getJSONData().passkeyAvailable).toBe(false);
  });

  it('never returns a user object or secrets in the challenge body', async () => {
    const { res } = await callHandler();

    expect(Object.keys(res._getJSONData()).sort()).toEqual([
      'accessToken',
      'mfaRequired',
      'passkeyAvailable',
      'userId',
    ]);
  });
});
