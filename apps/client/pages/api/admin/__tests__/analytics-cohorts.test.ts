import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ cohorts: vi.fn(), adminOptions: vi.fn(), used: vi.fn() }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    mocks.adminOptions(options);
    const chain = {
      use: (middleware: unknown) => {
        mocks.used(middleware);
        return chain;
      },
      get: (handler: unknown) => handler,
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => ({ rateLimit: options }),
}));
vi.mock('@server/analytics/analyticsCohorts', () => ({ getAnalyticsCohorts: mocks.cohorts }));
import handler from '../analytics/cohorts';

describe('analytics cohorts route', () => {
  const run = async (query: Record<string, string> = {}) => {
    const { req, res } = createMocks({ query });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    return res;
  };
  const declaredOptions = mocks.adminOptions.mock.calls[0]?.[0];

  beforeEach(() => {
    mocks.cohorts.mockReset();
    mocks.cohorts.mockResolvedValue({ cohorts: [] });
  });

  it('gates GET on a JWT session with the support:read admin permission', () => {
    expect(declaredOptions).toMatchObject({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } });
  });

  it('rate limits the route in its own bucket', () => {
    expect(mocks.used).toHaveBeenCalledWith({
      rateLimit: { limit: 30, windowMs: 60_000, bucket: 'admin-analytics-cohorts' },
    });
  });

  it('applies the defaults (12 weeks, legit only) and never caches', async () => {
    const res = await run();
    expect(mocks.cohorts).toHaveBeenCalledWith({ weeks: 12, signups: 'legit' });
    expect(res._getJSONData()).toEqual({ cohorts: [] });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('passes the weeks and the signups mode through', async () => {
    await run({ weeks: '8', signups: 'all' });
    expect(mocks.cohorts).toHaveBeenCalledWith({ weeks: 8, signups: 'all' });
  });

  it('rejects values outside the supported sets without running the query', async () => {
    for (const query of [{ weeks: '0' }, { weeks: '27' }, { weeks: '1.5' }, { weeks: 'abc' }, { signups: 'bots' }]) {
      expect((await run(query))._getStatusCode(), JSON.stringify(query)).toBe(400);
    }
    expect(mocks.cohorts).not.toHaveBeenCalled();
  });
});
