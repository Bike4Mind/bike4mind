import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/admin/organizations/grants: the Subscription query result goes through the response
 * schema, so a lean document carrying keys outside the .select() projection (e.g. `_id`, `__v`)
 * must not reach the client.
 */

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      { use: () => chain, get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain) }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

const mockLean = vi.hoisted(() => vi.fn());
const mockFind = vi.hoisted(() => vi.fn());
vi.mock('@server/models/Subscription', () => ({ Subscription: { find: mockFind } }));

import handler from '../grants';

function call(isAdmin: boolean) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = { isAdmin, id: 'admin-1' };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('GET /api/admin/organizations/grants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const query = { select: vi.fn(), limit: vi.fn(), lean: mockLean };
    query.select.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    mockFind.mockReturnValue(query);
  });

  it('strips keys outside the grant summary and keeps the declared ones', async () => {
    mockLean.mockResolvedValue([
      {
        id: 'sub-1',
        ownerId: 'org-1',
        grantedBy: 'admin-1',
        grantedReason: 'sales',
        quantity: 5,
        periodEndsAt: '2027-01-01T00:00:00.000Z',
        _id: 'raw-object-id',
        __v: 1,
        notInSchema: 'secret',
      },
    ]);
    const { res, run } = call(true);
    await run();

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toMatchObject({ truncated: false, limit: 500 });
    expect(body.grants).toEqual([
      {
        id: 'sub-1',
        ownerId: 'org-1',
        grantedBy: 'admin-1',
        grantedReason: 'sales',
        quantity: 5,
        periodEndsAt: '2027-01-01T00:00:00.000Z',
      },
    ]);
    for (const key of ['_id', '__v', 'notInSchema']) {
      expect(body.grants[0]).not.toHaveProperty(key);
    }
  });

  it('rejects a non-admin before querying', async () => {
    const { run } = call(false);

    await expect(run()).rejects.toMatchObject({ statusCode: 403 });
    expect(mockFind).not.toHaveBeenCalled();
  });
});
