import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middleware: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const route = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const guard of middleware) await guard(req, res, () => undefined);
        return handlers[(req as { method: string }).method](req, res);
      },
      {
        use: (guard: (req: unknown, res: unknown, next: () => void) => void) => {
          middleware.push(guard);
          return route;
        },
        get: (handler: (req: unknown, res: unknown) => unknown) => {
          handlers.GET = handler;
          return route;
        },
        post: (handler: (req: unknown, res: unknown) => unknown) => {
          handlers.POST = handler;
          return route;
        },
      }
    );
    return route;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/admin/campaignWatches', () => ({
  listCampaignWatches: mocks.list,
  createCampaignWatch: mocks.create,
}));
import handler from '../index';

const memberId = 'b'.repeat(24);
const watchId = 'a'.repeat(24);
const body = { name: 'Watch', userIds: [memberId], reason: 'Monitor account activity' };
async function call(isAdmin: boolean, method: 'GET' | 'POST', permission: string) {
  const { req, res } = createMocks({ method, query: {}, body });
  Object.assign(req, { user: { id: 'operator', isAdmin, adminPermissions: isAdmin ? [] : [permission] } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
});

describe('GET /api/admin/campaign-watches', () => {
  it('rejects a support:read delegate without full admin access with 403', async () => {
    await expect(call(false, 'GET', 'support:read')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Admin access required',
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lists uncached watches for a full administrator', async () => {
    const res = await call(true, 'GET', 'support:read');
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(res._getJSONData()).toEqual({ items: [], nextCursor: null });
  });
});

describe('POST /api/admin/campaign-watches', () => {
  it('rejects a users:moderate delegate without full admin access with 403', async () => {
    await expect(call(false, 'POST', 'users:moderate')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Admin access required',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns 201 when a full administrator creates a watch', async () => {
    mocks.create.mockResolvedValue({ watch: { id: watchId }, created: true });
    const res = await call(true, 'POST', 'users:moderate');
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual({ watch: { id: watchId }, created: true });
  });

  it('returns 200 when the cohort already has an open watch', async () => {
    mocks.create.mockResolvedValue({ watch: { id: watchId }, created: false });
    const res = await call(true, 'POST', 'users:moderate');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ watch: { id: watchId }, created: false });
  });
});
