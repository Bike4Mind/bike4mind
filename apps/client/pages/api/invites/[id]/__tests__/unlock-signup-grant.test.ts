import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  unlock: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    return {
      use: () => ({
        post: (fn: typeof h.handler) => {
          h.handler = fn;
          return {};
        },
      }),
    };
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@server/credits/orgInviteUnlock', () => ({ unlockSignupGrantFromOrgInvite: h.unlock }));

import '@pages/api/invites/[id]/unlock-signup-grant';

describe('POST /api/invites/[id]/unlock-signup-grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.unlock.mockResolvedValue({ creditsGranted: 7 });
  });

  it('is jwt-only', () => {
    expect(h.config).toEqual({ auth: 'jwtOnly' });
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
