import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

// Captures the config so a test can assert requiredScopes: the scope gate lives in
// apiKeyAuth (real middleware, not exercised here), so asserting the handler is
// registered with it is the only guard available at this level.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'PUT']?.(req, res),
      {
        use: () => chain,
        put: (fn: (req: unknown, res: unknown) => unknown) => ((h.PUT = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockUserFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  userRepository: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  withTransaction: (fn: (session: unknown) => Promise<unknown>) => fn(undefined),
}));

const mockFindByStripeSubId = vi.fn();
const mockUpdateByStripeSubId = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findByStripeSubscriptionId: (...a: unknown[]) => mockFindByStripeSubId(...a),
    updateByStripeSubscriptionId: (...a: unknown[]) => mockUpdateByStripeSubId(...a),
  },
}));

vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import handler from '../credits';

function call(options: { isAdmin?: boolean; body?: object; userId?: string; subscriptionId?: string }) {
  const { req, res } = createMocks({
    method: 'PUT',
    query: { userId: options.userId ?? 'u1', subscriptionId: options.subscriptionId ?? 'sub_123' },
    body: options.body ?? { creditsPerCycle: 5000 },
  });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('PUT /api/admin/users/[userId]/subscriptions/[subscriptionId]/credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'u1' });
    mockFindByStripeSubId.mockResolvedValue({ id: 'sub-1', ownerType: 'User', ownerId: 'u1' });
    mockUpdateByStripeSubId.mockResolvedValue(undefined);
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a non-admin', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockUpdateByStripeSubId).not.toHaveBeenCalled();
  });

  it('updates the credit rate for an individual subscription for an admin', async () => {
    const { res, run } = call({});
    await run();
    expect(mockUpdateByStripeSubId).toHaveBeenCalledWith('sub_123', { customCreditsPerCycle: 5000 });
    expect(res._getJSONData()).toMatchObject({ success: true, creditsPerCycle: 5000 });
  });
});
