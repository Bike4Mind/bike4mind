import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ config: undefined as unknown, handler: undefined as unknown, unlock: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    const chain = {
      use: () => chain,
      post: (handler: unknown) => {
        h.handler = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@server/credits/activityUnlock', () => ({ unlockSignupGrantFromActivity: h.unlock }));
await import('../signup-grant-activity');

describe('self activity unlock', () => {
  beforeEach(() => vi.clearAllMocks());
  it('requires first-party authentication and ignores claimed user, reason and activity', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly' });
    h.unlock.mockResolvedValue({ creditsGranted: 0, currentCredits: null });
    const json = vi.fn();
    const handler = h.handler as (req: unknown, res: unknown) => Promise<unknown>;
    await handler(
      { user: { id: 'authenticated-user' }, body: { userId: 'victim', reason: 'admin', messages: 999 } },
      { json }
    );
    expect(h.unlock).toHaveBeenCalledExactlyOnceWith('authenticated-user');
    expect(json).toHaveBeenCalledWith({ creditsGranted: 0, currentCredits: null });
  });
});
