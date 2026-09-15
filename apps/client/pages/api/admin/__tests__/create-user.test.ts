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
});
