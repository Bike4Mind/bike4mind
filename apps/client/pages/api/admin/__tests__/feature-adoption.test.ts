import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ get: vi.fn(), options: vi.fn(), middleware: vi.fn() }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    mocks.options(options);
    const chain = {
      use: (middleware: unknown) => {
        mocks.middleware(middleware);
        return chain;
      },
      get: (handler: unknown) => handler,
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: (options: unknown) => options }));
vi.mock('@server/analytics/featureAdoption', () => ({
  getFeatureAdoption: mocks.get,
  FeatureAdoptionQueryError: class extends Error {},
  FeatureAdoptionCapacityError: class extends Error {},
}));
import handler from '../analytics/feature-adoption';
import { FeatureAdoptionCapacityError, FeatureAdoptionQueryError } from '@server/analytics/featureAdoption';
const options = mocks.options.mock.calls[0]?.[0];
async function run(query: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ query });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}
beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockResolvedValue({ features: [] });
});
describe('feature adoption route', () => {
  it('requires the existing JWT support permission and a bounded rate-limit bucket', () => {
    expect(options).toMatchObject({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } });
    expect(mocks.middleware).toHaveBeenCalledWith({ limit: 30, windowMs: 60_000, bucket: 'admin-feature-adoption' });
  });
  it('defaults to external, passes effective filters and prevents shared caching', async () => {
    const res = await run();
    expect(mocks.get).toHaveBeenCalledWith({ accounts: 'external', client: 'all', days: 7 });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    await run({ accounts: 'internal', client: 'api', days: '28', end: '2026-06-14' });
    expect(mocks.get).toHaveBeenLastCalledWith({ accounts: 'internal', client: 'api', days: 28, end: '2026-06-14' });
  });
  it('rejects invalid filters, dates and oversized cohorts without substituting zeros', async () => {
    for (const query of [{ accounts: 'staff' }, { client: 'desktop' }, { days: '999' }, { end: 'bad' }]) {
      expect((await run(query))._getStatusCode()).toBe(400);
    }
    expect(mocks.get).not.toHaveBeenCalled();
    mocks.get.mockRejectedValueOnce(new FeatureAdoptionQueryError('Incomplete day'));
    expect((await run())._getStatusCode()).toBe(400);
    mocks.get.mockRejectedValueOnce(new FeatureAdoptionCapacityError('Choose a shorter period'));
    const res = await run();
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toEqual({ message: 'Choose a shorter period' });
  });
});
