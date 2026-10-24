import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing the handler.
const mockCreateUser = vi.fn();
const mockSendOTC = vi.fn();
const mockStoreNonce = vi.fn();
const mockEmitSignupFunnelEvents = vi.fn();
const mockRecordSyntheticIdentity = vi.fn();

vi.mock('@bike4mind/services', () => ({
  userService: {
    createUser: (...args: unknown[]) => mockCreateUser(...args),
    sendOTC: (...args: unknown[]) => mockSendOTC(...args),
  },
}));

let inTransaction = false;
let insideTransactionAtAudit: boolean | undefined;
vi.mock('@bike4mind/database', () => ({
  isTransientTransactionError: (error: unknown) =>
    (error as { errorLabels?: string[] })?.errorLabels?.includes('TransientTransactionError') === true,
  withTransaction: async (fn: () => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn();
    } finally {
      inTransaction = false;
    }
  },
  userRepository: {},
  pendingOtcTokenRepository: {
    storeNonce: (...args: unknown[]) => mockStoreNonce(...args),
  },
}));

const mockRequireStepUp = vi.fn();
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: (...args: unknown[]) => mockRequireStepUp(...args) }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (handler: (...args: unknown[]) => unknown) => handler,
  }),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...args: unknown[]) => unknown) => handler,
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  BadRequestError: class BadRequestError extends Error {},
}));

vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: vi.fn() } },
}));

vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', () => ({
  getLogoUrl: () => 'https://example.com/logo.png',
  buildEmailLogoImg: () => '',
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
}));
vi.mock('@server/analytics/funnel', () => ({
  emitSignupFunnelEvents: (...args: unknown[]) => mockEmitSignupFunnelEvents(...args),
  recordSyntheticIdentity: (...args: unknown[]) => mockRecordSyntheticIdentity(...args),
}));

vi.mock('jsonwebtoken', () => ({ default: { sign: () => 'signed-token' } }));

const mockRecordAdminAction = vi.fn();
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => {
    insideTransactionAtAudit = inTransaction;
    return mockRecordAdminAction(...args);
  },
}));

import handler from '../create-user';

const runHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (body: Record<string, unknown>) => ({
  user: { isAdmin: true },
  body,
  logger: { error: vi.fn() },
});

describe('admin/create-user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendOTC.mockResolvedValue({ nonce: null });
    mockRecordSyntheticIdentity.mockResolvedValue(false);
    mockRecordAdminAction.mockResolvedValue(null);
    insideTransactionAtAudit = undefined;
  });

  describe('admin audit', () => {
    const body = { username: 'audited', email: 'audited@example.com', name: 'Audited', initialCredits: 25 };

    it('records user.created against the new user inside the creating transaction', async () => {
      mockCreateUser.mockResolvedValue({ id: 'u-new', email: 'audited@example.com', username: 'audited' });
      const res = makeRes();

      await runHandler(makeReq(body), res);

      expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.created',
          target: { kind: 'user', id: 'u-new', displayName: 'audited@example.com' },
          details: expect.objectContaining({ isAdmin: false, initialCredits: 25 }),
        })
      );
      expect(insideTransactionAtAudit).toBe(true);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('records the storage limit the created user ended up with, not the requested one', async () => {
      mockCreateUser.mockResolvedValue({
        id: 'u-sl',
        email: 'audited@example.com',
        username: 'audited',
        storageLimit: 1000,
      });

      await runHandler(makeReq({ ...body, storageLimit: 5000 }), makeRes());

      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ details: expect.objectContaining({ storageLimit: 1000 }) })
      );
    });

    it('never records the supplied password', async () => {
      mockCreateUser.mockResolvedValue({ id: 'u-pw', email: 'audited@example.com', username: 'audited' });

      await runHandler(makeReq({ ...body, password: 'hunter2secret' }), makeRes());

      expect(JSON.stringify(mockRecordAdminAction.mock.calls[0][1])).not.toContain('hunter2secret');
    });

    it('fails the request and sends no welcome email when the audit write fails', async () => {
      mockCreateUser.mockResolvedValue({ id: 'u-fail', email: 'audited@example.com', username: 'audited' });
      mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));
      const res = makeRes();

      await expect(runHandler(makeReq(body), res)).rejects.toThrow('audit down');

      expect(res.status).not.toHaveBeenCalled();
      expect(mockSendOTC).not.toHaveBeenCalled();
      expect(mockEmitSignupFunnelEvents).not.toHaveBeenCalled();
    });

    it('does not record when the user cannot be created', async () => {
      mockCreateUser.mockRejectedValueOnce(new Error('Email already in use'));

      await expect(runHandler(makeReq(body), makeRes())).rejects.toThrow('Email already in use');

      expect(mockRecordAdminAction).not.toHaveBeenCalled();
    });
  });

  it('passes a transient transaction error through unchanged so withTransaction can retry it', async () => {
    const transient = Object.assign(new Error('write conflict'), { errorLabels: ['TransientTransactionError'] });
    mockCreateUser.mockRejectedValueOnce(transient);

    await expect(
      runHandler(makeReq({ username: 'retry', email: 'retry@example.com', name: 'Retry' }), makeRes())
    ).rejects.toBe(transient);
  });

  it('still returns 201 when post-commit signup analytics fail', async () => {
    mockCreateUser.mockResolvedValue({ id: 'u-funnel', email: 'f@example.com', username: 'funnel', currentCredits: 0 });
    mockEmitSignupFunnelEvents.mockRejectedValueOnce(new Error('funnel down'));
    const req = makeReq({ username: 'funnel', email: 'f@example.com', name: 'Funnel' });
    const res = makeRes();

    await runHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(req.logger.error).toHaveBeenCalledWith(expect.stringContaining('signup analytics'), expect.any(Error));
  });

  it('stores password: null + hasUsablePassword: false for a passwordless shell account', async () => {
    mockCreateUser.mockResolvedValue({ id: 'u1', email: 'shell@example.com', username: 'shell', currentCredits: 0 });

    await runHandler(makeReq({ username: 'shell', email: 'shell@example.com', name: 'Shell User' }), makeRes());

    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({ password: null, hasUsablePassword: false }),
      }),
      expect.any(Object)
    );
    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'u1', isSynthetic: false }),
      method: 'admin',
      emailVerified: false,
      creditsGranted: 0,
    });
  });

  it('passes a synthetic classification into the signup emitter', async () => {
    const user = { id: 'u-synthetic', email: 'seed@test.example', username: 'persona-seed', currentCredits: 50 };
    mockCreateUser.mockResolvedValue(user);
    mockRecordSyntheticIdentity.mockResolvedValue(true);

    await runHandler(makeReq({ username: 'persona-seed', email: 'seed@test.example', name: 'Seed' }), makeRes());

    expect(mockRecordSyntheticIdentity).toHaveBeenCalledWith(user);
    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'u-synthetic', isSynthetic: true }) })
    );
  });

  it('opts in to the reserved test-persona username prefix, which only admins may assign', async () => {
    mockCreateUser.mockResolvedValue({ id: 'u-synthetic', email: 'seed@test.example', username: 'persona-seed' });

    await runHandler(makeReq({ username: 'persona-seed', email: 'seed@test.example', name: 'Seed' }), makeRes());

    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'persona-seed', allowReservedUsername: true }),
      expect.any(Object)
    );
  });

  it('stores the supplied password + hasUsablePassword: true when an admin provides one', async () => {
    mockCreateUser.mockResolvedValue({ id: 'u2', email: 'real@example.com', username: 'real' });

    await runHandler(
      makeReq({ username: 'real', email: 'real@example.com', name: 'Real User', password: 'hunter2secret' }),
      makeRes()
    );

    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({ password: 'hunter2secret', hasUsablePassword: true }),
      }),
      expect.any(Object)
    );
  });

  it('rejects a username outside the allowed characters with the rules message', async () => {
    await expect(
      runHandler(makeReq({ username: '<b>x</b>', email: 'x@example.com', name: 'X' }), makeRes())
    ).rejects.toThrow("username: Usernames can contain letters, numbers, spaces and . _ - ' (up to 64 characters).");
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('passes the username on trimmed', async () => {
    mockCreateUser.mockResolvedValue({ id: 'u3', email: 'trim@example.com', username: 'Trim Me' });

    await runHandler(makeReq({ username: '  Trim Me ', email: 'trim@example.com', name: 'Trim' }), makeRes());

    expect(mockCreateUser).toHaveBeenCalledWith(expect.objectContaining({ username: 'Trim Me' }), expect.any(Object));
  });

  describe('credential and admin-role gate', () => {
    const base = { username: 'new', email: 'new@example.com', name: 'New User' };
    const gated: Array<[string, Record<string, unknown>]> = [['the admin role', { ...base, isAdmin: true }]];

    it.each(gated)('requires recent verification for %s and creates nothing without it', async (_label, body) => {
      mockRequireStepUp.mockRejectedValueOnce(new Error('step_up_required'));
      await expect(runHandler(makeReq(body), makeRes())).rejects.toThrow('step_up_required');
      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it.each(gated)('refuses %s from an API key before any write', async (_label, body) => {
      const req = { ...makeReq(body), apiKeyInfo: { scopes: ['admin'] } };
      await expect(runHandler(req, makeRes())).rejects.toThrow(/signed-in session/);
      expect(mockRequireStepUp).not.toHaveBeenCalled();
      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it.each([
      ['passwordless', base],
      ['password', { ...base, password: 'hunter2secret' }],
    ])('leaves a %s non-admin account ungated, for a session and an API key', async (_label, body) => {
      mockCreateUser.mockResolvedValue({ id: 'u3', email: 'new@example.com', username: 'new' });
      await runHandler(makeReq(body), makeRes());
      await runHandler({ ...makeReq(body), apiKeyInfo: { scopes: ['admin'] } }, makeRes());
      expect(mockRequireStepUp).not.toHaveBeenCalled();
      expect(mockCreateUser).toHaveBeenCalledTimes(2);
    });
  });
});
