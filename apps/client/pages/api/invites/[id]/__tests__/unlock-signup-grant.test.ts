import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  middleware: [] as unknown[],
  csrf: vi.fn(() => 'csrf-middleware'),
  rate: vi.fn(() => 'rate-middleware'),
  unlock: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    const chain = {
      use: (middleware: unknown) => {
        h.middleware.push(middleware);
        return chain;
      },
      post: (fn: typeof h.handler) => {
        h.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: h.csrf }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: h.rate }));
vi.mock('@server/credits/orgInviteUnlock', () => ({ unlockSignupGrantFromOrgInvite: h.unlock }));

import '@pages/api/invites/[id]/unlock-signup-grant';

describe('POST /api/invites/[id]/unlock-signup-grant', () => {
  beforeEach(() => {
    h.unlock.mockReset();
    h.unlock.mockResolvedValue({ creditsGranted: 7 });
  });

  it('is jwt-only with CSRF and the same per-user request cap as the eligibility route', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly' });
    expect(h.rate).toHaveBeenCalledExactlyOnceWith({ limit: 5, windowMs: 60000 });
    expect(h.middleware).toEqual(['csrf-middleware', 'rate-middleware']);
  });

  it('releases for the authenticated user and the invite in the path, ignoring any body user id', async () => {
    const res = { json: vi.fn() };
    await h.handler!({ query: { id: 'inv1' }, user: { id: 'u1' }, body: { userId: 'someone-else' } }, res);
    expect(h.unlock).toHaveBeenCalledWith('u1', 'inv1');
    expect(res.json).toHaveBeenCalledWith({ creditsGranted: 7 });
  });

  it.each([undefined, '', ['a', 'b']])('rejects an invalid invite id %j', async id => {
    await expect(h.handler!({ query: { id }, user: { id: 'u1' } }, { json: vi.fn() })).rejects.toThrow(
      'Invalid invite ID'
    );
    expect(h.unlock).not.toHaveBeenCalled();
  });
});
