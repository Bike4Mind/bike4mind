import { describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CREDITS_PAGE_READ } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ load: vi.fn(), options: vi.fn() }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    mocks.options(options);
    const chain = { use: () => chain, get: (handler: unknown) => handler };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@server/admin/subscriptionsList/subscriptionUsage', () => ({ subscriptionUsageDetail: mocks.load }));
import handler from '../subscriptions/usage';

describe('subscription usage route', () => {
  const run = async (query: Record<string, unknown>) => {
    const { req, res } = createMocks({ query });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    return res;
  };
  it('requires the same admin permission as subscriptions', () => {
    expect(mocks.options).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'jwtOnly', adminPermissions: { GET: CREDITS_PAGE_READ } })
    );
  });
  it('rejects malformed or repeated ids before querying', async () => {
    for (const query of [{}, { subscriptionId: 'bad' }, { subscriptionId: ['a', 'b'] }]) {
      expect((await run(query)).statusCode).toBe(400);
    }
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('returns the exact subscription observation without caching', async () => {
    const id = '123456789012345678901234';
    mocks.load.mockResolvedValue({ coverage: 'unknown' });
    const res = await run({ subscriptionId: id });
    expect(mocks.load).toHaveBeenCalledWith(id);
    expect(res._getJSONData()).toEqual({ coverage: 'unknown' });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
