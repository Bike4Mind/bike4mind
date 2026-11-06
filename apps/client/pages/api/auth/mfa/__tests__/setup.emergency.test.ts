import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  findByIdWithMfaSecrets: vi.fn(),
  setupMFA: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_q: any, _s: any, next: any) => next(),
}));
vi.mock('@bike4mind/database', () => ({ userRepository: { findByIdWithMfaSecrets: mocks.findByIdWithMfaSecrets } }));
vi.mock('@bike4mind/services', () => ({ mfaService: { setupMFA: mocks.setupMFA } }));
vi.mock('@server/auth/signInSecondFactor', () => ({
  readSignInOrigin: (user: { mfaSignIn?: unknown } | undefined) => user?.mfaSignIn,
}));

import handler from '../setup';

async function setupAs(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = user;
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByIdWithMfaSecrets.mockResolvedValue({ id: 'u1', mfa: { totpEnabled: false } });
  mocks.setupMFA.mockResolvedValue({ secret: 's' });
});

describe('POST /api/auth/mfa/setup - emergency sign-in', () => {
  it('refuses enrollment for an emergency pending token, without starting setup', async () => {
    const res = await setupAs({
      id: 'u1',
      mfaPending: true,
      mfaSignIn: { strategy: 'local', createdVia: 'emergency' },
    });

    expect(res._getStatusCode()).toBe(403);
    expect(mocks.setupMFA).not.toHaveBeenCalled();
  });

  it('still starts setup for an ordinary sign-in', async () => {
    const res = await setupAs({ id: 'u1', mfaPending: true, mfaSignIn: { strategy: 'local', createdVia: 'password' } });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.setupMFA).toHaveBeenCalledTimes(1);
  });

  it('hands setup the user with its pending secret so a repeat call can re-serve it', async () => {
    const pendingUser = { id: 'u1', mfa: { totpEnabled: false, totpSecret: 'PENDING', setupAt: new Date() } };
    mocks.findByIdWithMfaSecrets.mockResolvedValue(pendingUser);

    await setupAs({ id: 'u1' });

    expect(mocks.findByIdWithMfaSecrets).toHaveBeenCalledWith('u1');
    expect(mocks.setupMFA).toHaveBeenCalledWith(expect.objectContaining({ user: pendingUser }), expect.anything());
  });
});
