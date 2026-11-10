import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ detail: vi.fn(), change: vi.fn() }));
const method = (req: unknown) => (req as { method?: string }).method;
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middleware: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
    const route = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const guard of middleware) await guard(req, res, () => undefined);
        return (method(req) === 'PATCH' ? route.patchHandler : route.handler)(req, res);
      },
      {
        handler: (_req: unknown, _res: unknown): unknown => undefined,
        patchHandler: (_req: unknown, _res: unknown): unknown => undefined,
        use: (guard: (req: unknown, res: unknown, next: () => void) => void) => {
          middleware.push(guard);
          return route;
        },
        get: (handler: (req: unknown, res: unknown) => unknown) => {
          route.handler = handler;
          return route;
        },
        patch: (handler: (req: unknown, res: unknown) => unknown) => {
          route.patchHandler = handler;
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
  campaignWatchDetail: mocks.detail,
  changeCampaignWatch: mocks.change,
}));
import handler from '../[id]';

const watchId = 'a'.repeat(24);
async function call(isAdmin: boolean, method: 'GET' | 'PATCH' = 'GET', body?: unknown) {
  const { req, res } = createMocks({ method, query: { id: watchId }, body: body as Record<string, unknown> });
  Object.assign(req, {
    user: { id: 'operator', isAdmin, adminPermissions: isAdmin ? [] : ['support:read', 'users:moderate'] },
  });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detail.mockResolvedValue({ watch: { id: watchId }, members: [] });
});

describe('GET /api/admin/campaign-watches/[id]', () => {
  it('rejects a support reader without full admin access with 403', async () => {
    await expect(call(false)).rejects.toMatchObject({ statusCode: 403, message: 'Admin access required' });
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('returns uncached watch details for a full administrator', async () => {
    const res = await call(true);
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mocks.detail).toHaveBeenCalledWith(watchId);
    expect(res._getJSONData()).toEqual({ watch: { id: watchId }, members: [] });
  });
});

describe('PATCH /api/admin/campaign-watches/[id]', () => {
  const body = { action: 'check', expectedRevision: 1, reason: 'Reviewed account activity' };

  it('rejects a users:moderate delegate without full admin access with 403', async () => {
    await expect(call(false, 'PATCH', body)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Admin access required',
    });
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('applies the change for a full administrator', async () => {
    mocks.change.mockResolvedValue({ id: watchId, revision: 2 });
    const res = await call(true, 'PATCH', body);
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.change).toHaveBeenCalledWith(expect.anything(), watchId, body);
    expect(res._getJSONData()).toEqual({ id: watchId, revision: 2 });
  });
});
