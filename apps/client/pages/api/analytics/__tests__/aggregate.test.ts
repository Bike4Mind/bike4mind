import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * analytics/aggregate groups event volumes by organization across tenants, so
 * it must be admin-only. Prove a non-admin is rejected before any aggregation
 * runs, and that an admin still gets data.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const aggregate = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('@bike4mind/database', () => ({ CounterLog: { aggregate } }));

import '@pages/api/analytics/aggregate';

function mocks(user: unknown) {
  const { req, res } = createMocks({ method: 'GET', query: {} });
  (req as any).user = user;
  return { req, res };
}

describe('/api/analytics/aggregate - admin gate', () => {
  beforeEach(() => aggregate.mockClear());

  it('rejects a non-admin before aggregating', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false });
    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(/admin/i);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('runs the aggregation for an admin', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true });
    await mockRefs.getHandler!(req, res);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });
});
