import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, CREDITS_PAGE_READ } from '@bike4mind/common';

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockHistory = vi.fn();
vi.mock('@server/admin/subscriptionDetail/getAdminSubscriptionHistory', () => ({
  getAdminSubscriptionHistory: (...args: unknown[]) => mockHistory(...args),
}));

import handler from '../history';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const HISTORY = { creditCycles: [], creditCyclesTruncated: false, creditUsageUnavailable: false, seatChanges: null };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call() {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'b'.repeat(24) } });
  Object.assign(req, { user: ADMIN });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/subscriptions/[id]/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistory.mockResolvedValue(HISTORY);
  });

  it('requires JWT auth with admin scope and the credits read permission', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: CREDITS_PAGE_READ },
    });
  });

  it('404s when the subscription does not exist', async () => {
    mockHistory.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the history with no-store caching', async () => {
    const res = await call();
    expect(mockHistory).toHaveBeenCalledWith('b'.repeat(24));
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData()).toEqual(HISTORY);
  });
});
