import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, NotFoundError } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;

// Runs the `.use` middlewares in order, so adminApi's real permission gate guards the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const middlewares: Middleware[] = [];
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (middleware: Middleware) => (middlewares.push(middleware), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/admin/billingOverview/loadBillingOverview', () => ({
  loadBillingOverview: (...args: unknown[]) => mocks.load(...args),
}));

import handler from '../billing-overview';

const OWNER_ID = 'a'.repeat(24);

const overview = {
  owner: { type: 'user', id: OWNER_ID, name: 'Ada', internal: false },
  window: { range: '90d', from: '2026-08-03T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
  generatedAt: '2026-11-01T00:00:00.000Z',
  subscription: { status: 'ok', standing: 'none', current: null, previous: [] },
  credits: { status: 'unavailable', message: 'The credit balance could not be loaded.' },
  payments: { status: 'ok', totals: [], records: [], truncated: false, eventsRecordedSince: null },
  usage: { status: 'ok', lastSuccessfulAt: null, attribution: [], truncated: false, recordedSince: null, link: null },
  activity: { status: 'ok', items: [], truncated: false },
};

const call = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { ownerType: 'user', ownerId: OWNER_ID, ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = { error: vi.fn() };
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(overview);
});

describe('GET /api/admin/billing-overview', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('rejects a non-admin before reading anything', async () => {
    await expect(call({}, { id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('rejects a delegated admin without a billing read permission', async () => {
    const delegate = { id: 'd1', isAdmin: false, adminPermissions: ['users:moderate'] };
    await expect(call({}, delegate).promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('admits a delegated admin holding support:read', async () => {
    const { res, promise } = call({}, { id: 'd2', isAdmin: false, adminPermissions: ['support:read'] });
    await promise;
    expect(res._getStatusCode()).toBe(200);
  });

  it('rejects an unknown owner type, a malformed id and an unknown range with 400', async () => {
    for (const query of [{ ownerType: 'agent' }, { ownerId: 'nope' }, { range: '7d' }]) {
      const { res, promise } = call(query);
      await promise;
      expect(res._getStatusCode()).toBe(400);
    }
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('defaults the window to 90 days and returns the validated overview, partial sections included', async () => {
    const { res, promise } = call({ ownerType: 'organization' });
    await promise;
    expect(mocks.load).toHaveBeenCalledWith(
      { ownerType: 'organization', ownerId: OWNER_ID, range: '90d' },
      expect.anything()
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData().credits).toEqual({
      status: 'unavailable',
      message: 'The credit balance could not be loaded.',
    });
  });

  it('passes a missing owner through as 404', async () => {
    mocks.load.mockRejectedValue(new NotFoundError('User not found'));
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });
});
