import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: undefined as unknown,
  handler: undefined as undefined | ((request: unknown, response: unknown) => Promise<unknown>),
  middleware: [] as unknown[],
  csrf: vi.fn(() => 'csrf-middleware'),
  rate: vi.fn(() => 'rate-middleware'),
  eligibility: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    mocks.config = config;
    const chain = {
      use: (middleware: unknown) => {
        mocks.middleware.push(middleware);
        return chain;
      },
      post: (handler: typeof mocks.handler) => {
        mocks.handler = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: mocks.csrf }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: mocks.rate }));
vi.mock('@server/credits/signupGrantEligibility', () => ({ checkSignupGrantEligibility: mocks.eligibility }));
await import('../signup-grant-eligibility');

describe('self signup grant eligibility', () => {
  beforeEach(() => {
    mocks.eligibility.mockReset();
  });

  it('requires first-party authentication, CSRF and a per-user request cap', () => {
    expect(mocks.config).toEqual({ auth: 'jwtOnly' });
    expect(mocks.csrf).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.rate).toHaveBeenCalledExactlyOnceWith({ limit: 5, windowMs: 60000 });
    expect(mocks.middleware).toEqual(['csrf-middleware', 'rate-middleware']);
  });

  it('ignores request-supplied recipients and identities and returns the authenticated grant result', async () => {
    mocks.eligibility.mockResolvedValue({ creditsGranted: 28, currentCredits: 40 });
    const json = vi.fn();
    await mocks.handler!(
      { user: { id: 'authenticated-user' }, body: { userId: 'victim', inviteId: 'forged', messages: 999 } },
      { json }
    );
    expect(mocks.eligibility).toHaveBeenCalledExactlyOnceWith('authenticated-user');
    expect(json).toHaveBeenCalledWith({ creditsGranted: 28, currentCredits: 40 });
  });
});
