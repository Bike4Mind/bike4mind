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
vi.mock('@server/utils/errors', () => ({ UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userHasMFAConfigured: (user: any) => user.mfa?.totpEnabled === true },
}));
const mockResolveSecondFactor = vi.fn();
vi.mock('@server/auth/signInSecondFactor', () => ({
  resolveSecondFactor: (...a: any[]) => mockResolveSecondFactor(...a),
}));
const mockIssueBrowserSession = vi.fn().mockResolvedValue({ accessToken: 'session-tok' });
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: (...a: any[]) => mockIssueBrowserSession(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

import { UnauthorizedError } from '@server/utils/errors';
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
  });

  it('refuses an admin with no second factor enrolled, generically, without a session or challenge', async () => {
    mockRefs.userDoc = { ...mockRefs.userDoc, mfa: { totpEnabled: false } };

    const { outcome } = await callHandler();

    expect(outcome).toBeInstanceOf(UnauthorizedError);
    expect((outcome as Error).message).toBe('Invalid credentials');
    expect(mockResolveSecondFactor).not.toHaveBeenCalled();
    expect(mockIssueBrowserSession).not.toHaveBeenCalled();
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
    expect(mockIssueBrowserSession).not.toHaveBeenCalled();
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
