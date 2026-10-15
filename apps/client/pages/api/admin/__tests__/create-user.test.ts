import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing the handler.
const mockCreateUser = vi.fn();
const mockSendOTC = vi.fn();
const mockStoreNonce = vi.fn();

vi.mock('@bike4mind/services', () => ({
  userService: {
    createUser: (...args: unknown[]) => mockCreateUser(...args),
    sendOTC: (...args: unknown[]) => mockSendOTC(...args),
  },
}));

vi.mock('@bike4mind/database', () => ({
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

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  BadRequestError: class BadRequestError extends Error {},
}));

vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: vi.fn() } },
}));

vi.mock('@server/utils/mailer/emailHelpers', () => ({
  getLogoUrl: () => 'https://example.com/logo.png',
  buildEmailLogoImg: () => '',
}));

vi.mock('@server/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
}));

vi.mock('jsonwebtoken', () => ({ default: { sign: () => 'signed-token' } }));

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
  });

  it('stores password: null + hasUsablePassword: false for a passwordless shell account', async () => {
    mockCreateUser.mockResolvedValue({ id: 'u1', email: 'shell@example.com', username: 'shell' });

    await runHandler(makeReq({ username: 'shell', email: 'shell@example.com', name: 'Shell User' }), makeRes());

    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({ password: null, hasUsablePassword: false }),
      }),
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
