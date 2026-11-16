import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { GatewayTimeoutError } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ summary: vi.fn(), adminOptions: vi.fn(), used: vi.fn() }));
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
vi.mock('@server/analytics/acquisitionConversionSummary', () => ({ getAcquisitionConversion: mocks.summary }));
import { AnalyticsOverviewQueryError } from '@server/analytics/analyticsOverview';
import handler from '../analytics/acquisition';

describe('analytics acquisition route', () => {
  const run = async (query: Record<string, string> = {}) => {
    const { req, res } = createMocks({ query });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    return res;
  };
  const declaredOptions = mocks.adminOptions.mock.calls[0]?.[0];

  beforeEach(() => {
    mocks.summary.mockReset();
    mocks.summary.mockResolvedValue({ status: 'ok' });
  });

  it('gates GET on a JWT session with the support:read admin permission, in its own rate limit bucket', () => {
    expect(declaredOptions).toMatchObject({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } });
    expect(mocks.used).toHaveBeenCalledWith({
      rateLimit: { limit: 20, windowMs: 60_000, bucket: 'admin-analytics-acquisition' },
    });
  });

  it('rejects a bad query without computing anything', async () => {
    for (const query of [
      { touch: 'middle' },
      { window: '120' },
      { window: '14' },
      { followUp: '365' },
      { range: '1y' },
      { range: 'custom', from: '2026-01-01' },
    ]) {
      expect((await run(query))._getStatusCode(), JSON.stringify(query)).toBe(400);
    }
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it('applies the defaults, passes the parsed query through and never caches', async () => {
    const res = await run({ range: '90d', touch: 'last' });
    expect(mocks.summary).toHaveBeenCalledWith(
      expect.objectContaining({ range: '90d', touch: 'last', window: '30', followUp: '90', signups: 'legit' }),
      expect.any(Date)
    );
    expect(res._getJSONData()).toEqual({ status: 'ok' });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('answers a range the server rejects with 400 and its message', async () => {
    mocks.summary.mockRejectedValue(new AnalyticsOverviewQueryError('The end date cannot be after today (UTC).'));
    const res = await run({ range: 'custom', from: '2026-01-01', to: '2099-01-01' });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().message).toBe('The end date cannot be after today (UTC).');
  });

  it('leaves a budget timeout to the admin API error handler', async () => {
    const timeout = new GatewayTimeoutError('The funnel took too long.');
    mocks.summary.mockRejectedValue(timeout);
    await expect(run({ range: '90d' })).rejects.toBe(timeout);
  });
});
