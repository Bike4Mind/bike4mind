import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * `days` is parseInt-ed and then subtracted via setDate, so a non-numeric value becomes NaN
 * and yields an Invalid Date that casts against the Date-typed `createdAt` filter. This
 * route has no local try/catch, so that cast reaches errorHandler as a 500.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  findFilter: undefined as unknown,
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

vi.mock('@bike4mind/database', () => ({
  ModalModel: {
    find: (filter: unknown) => {
      mockRefs.findFilter = filter;
      return { sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) };
    },
  },
}));

vi.mock('@bike4mind/services', () => ({ MODAL_SAFE_DEFAULT_KEY: 'whats-new' }));

import '@pages/api/admin/email/whats-new-content';

const invoke = (query: Record<string, string>) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = { id: 'admin1', isAdmin: true };
  return { req, res };
};

describe('GET /api/admin/email/whats-new-content - days guard', () => {
  beforeEach(() => {
    mockRefs.findFilter = undefined;
  });

  it('rejects a non-numeric days as a 400 before the query runs', async () => {
    const { req, res } = invoke({ days: 'abc' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockRefs.findFilter).toBeUndefined();
  });

  // setDate overflows the Date range in either direction, so a finite-but-huge value passes
  // a Number.isNaN check on the parsed number and still produces an Invalid Date. The guard
  // asserts the constructed date instead.
  it.each([['negative', '-99999999999'], ['positive', '99999999999']])(
    'rejects an out-of-range %s days as a 400 before the query runs',
    async (_label, days) => {
      const { req, res } = invoke({ days });
      await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockRefs.findFilter).toBeUndefined();
    }
  );

  it('still accepts a numeric days and builds a valid date window', async () => {
    const { req, res } = invoke({ days: '7' });
    await mockRefs.getHandler!(req, res);

    const gte = (mockRefs.findFilter as { createdAt: { $gte: Date } }).createdAt.$gte;
    expect(Number.isNaN(gte.getTime())).toBe(false);
  });
});
