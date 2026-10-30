import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: undefined as unknown,
  handler: undefined as undefined | ((request: unknown, response: unknown) => Promise<unknown>),
  middleware: [] as unknown[],
  csrf: vi.fn(() => 'csrf-middleware'),
  rate: vi.fn(() => 'rate-middleware'),
  heartbeat: vi.fn(),
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
vi.mock('@server/credits/recordActiveSession', () => ({ recordHeartbeat: mocks.heartbeat }));
await import('../active-session');

describe('active session heartbeat route', () => {
  beforeEach(() => mocks.heartbeat.mockReset());

  it('requires a first-party session (no API key), CSRF and a per-user request cap', () => {
    expect(mocks.config).toEqual({ auth: 'jwtOnly' });
    expect(mocks.csrf).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.rate).toHaveBeenCalledExactlyOnceWith({ limit: 6, windowMs: 60000 });
    expect(mocks.middleware).toEqual(['csrf-middleware', 'rate-middleware']);
  });

  it('records for the authenticated user only, ignoring any body', async () => {
    const result = { creditsGranted: 0, paidToday: false, withheld: false, activeSeconds: 60, requiredSeconds: 600 };
    mocks.heartbeat.mockResolvedValue(result);
    const json = vi.fn();
    await mocks.handler!({ user: { id: 'me' }, body: { userId: 'victim', seconds: 9999 } }, { json });
    expect(mocks.heartbeat).toHaveBeenCalledExactlyOnceWith('me');
    expect(json).toHaveBeenCalledWith(result);
  });
});
