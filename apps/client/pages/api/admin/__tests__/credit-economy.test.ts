import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CREDITS_PAGE_READ } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ page: vi.fn(), report: vi.fn(), config: vi.fn() }));
vi.mock('@server/admin/creditEconomy', () => ({ readEconomyPage: mocks.page, readEconomyReport: mocks.report }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config: unknown) => {
    mocks.config(config);
    return { get: (fn: unknown) => fn };
  },
}));
import handler from '../credit-economy';
const run = async (query: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'GET', query });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};
const query = { from: '2026-01-01T00:00:00Z', to: '2026-01-10T00:00:00Z' };
beforeEach(() => {
  mocks.page.mockReset().mockResolvedValue({ rows: [], total: 0 });
  mocks.report.mockReset();
});

describe('credit economy API boundary', () => {
  it('requires JWT admin authentication and existing credit read permissions', () => {
    expect(mocks.config).toHaveBeenCalledWith({ auth: 'jwtOnly', adminPermissions: { GET: CREDITS_PAGE_READ } });
  });
  it('validates the date, owner, pagination and view before reading', async () => {
    for (const invalid of [
      { from: 'bad' },
      { to: '2029-01-01T00:00:00Z' },
      { ownerType: 'invalid' },
      { page: '1001' },
      { limit: '101' },
      { view: ['transactions'] },
      { flow: 'anything' },
    ]) {
      await expect(run({ ...query, ...invalid })).rejects.toThrow();
    }
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it('returns a validated server page and disables caching', async () => {
    const res = await run({
      ...query,
      view: 'transactions',
      page: '2',
      limit: '25',
      ownerType: 'Organization',
      flow: 'transfers',
    });
    expect(mocks.page).toHaveBeenCalledWith({
      ...query,
      page: 2,
      limit: 25,
      ownerType: 'Organization',
      flow: 'transfers',
    });
    expect(res._getJSONData()).toEqual({ rows: [], total: 0 });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
  it('rejects an invalid response instead of publishing corrupt analytics', async () => {
    mocks.report.mockResolvedValue({});
    await expect(run(query)).rejects.toThrow();
  });
});
