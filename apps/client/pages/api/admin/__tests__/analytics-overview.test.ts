import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ overview: vi.fn(), adminOptions: vi.fn() }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    mocks.adminOptions(options);
    const chain = { use: () => chain, get: (handler: unknown) => handler };
    return chain;
  },
}));
vi.mock('@server/analytics/analyticsOverview', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/analytics/analyticsOverview')>()),
  getAnalyticsOverview: mocks.overview,
}));
import { AnalyticsOverviewQueryError } from '@server/analytics/analyticsOverview';
import handler from '../analytics/overview';

describe('analytics overview route', () => {
  const run = async (query: Record<string, string> = {}) => {
    const { req, res } = createMocks({ query });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    return res;
  };
  const declaredOptions = mocks.adminOptions.mock.calls[0]?.[0];

  beforeEach(() => {
    mocks.overview.mockReset();
    mocks.overview.mockResolvedValue({ window: { range: '28d' } });
  });

  it('gates GET on the support:read admin permission', () => {
    expect(declaredOptions).toMatchObject({ adminPermissions: { GET: 'support:read' } });
  });

  it('rejects values outside the supported sets', async () => {
    for (const query of [
      { range: '1y' },
      { compare: 'yes' },
      { signups: 'bots' },
      { accounts: 'staff' },
      { range: 'custom', from: '2026-01-01' },
    ]) {
      expect((await run(query))._getStatusCode(), JSON.stringify(query)).toBe(400);
    }
    const badDate = await run({ range: 'custom', from: '01/02/2026', to: '2026-02-01' });
    expect(badDate._getJSONData().message).toBe('Dates must be YYYY-MM-DD.');
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('applies the defaults and never caches', async () => {
    const res = await run();
    expect(mocks.overview).toHaveBeenCalledWith({
      range: '28d',
      compare: 'prev',
      signups: 'legit',
      accounts: 'external',
    });
    expect(res._getJSONData()).toEqual({ window: { range: '28d' } });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('passes a custom range through', async () => {
    await run({
      range: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      compare: 'off',
      signups: 'all',
      accounts: 'internal',
    });
    expect(mocks.overview).toHaveBeenCalledWith({
      range: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      compare: 'off',
      signups: 'all',
      accounts: 'internal',
    });
  });

  it('answers a range the server module rejects with 400 and its message', async () => {
    mocks.overview.mockRejectedValue(new AnalyticsOverviewQueryError('The end date cannot be after today (UTC).'));
    const res = await run({ range: 'custom', from: '2026-01-01', to: '2099-01-01' });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().message).toBe('The end date cannot be after today (UTC).');
  });
});
