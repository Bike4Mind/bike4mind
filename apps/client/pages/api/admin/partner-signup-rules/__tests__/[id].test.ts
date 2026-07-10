import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Same middleware-strip pattern as index.test.ts: capture the handlers registered on the
// baseApi chain so PUT/DELETE can be invoked directly. Everything referenced inside a
// vi.mock factory must live in vi.hoisted (mocks are hoisted above const initialization).
const { handlers, repo, invalidatePartnerRuleCache } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  repo: { update: vi.fn(), findById: vi.fn(), delete: vi.fn() },
  invalidatePartnerRuleCache: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, (fn: (req: unknown, res: unknown) => unknown) => unknown> = {};
    for (const method of ['get', 'post', 'put', 'delete']) {
      chain[method] = (fn: (req: unknown, res: unknown) => unknown) => {
        handlers[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({ partnerSignupRuleRepository: repo }));
// Keep assertKnownEntitlements real (exercises the actual known-key validation); spy only on invalidate.
vi.mock('@server/entitlements/partnerRules', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/entitlements/partnerRules')>()),
  invalidatePartnerRuleCache,
}));

// Importing the route registers handlers.put / handlers.delete via the mocked baseApi.
import '@pages/api/admin/partner-signup-rules/[id]';

type ReqOverrides = { user?: unknown; body?: unknown; query?: unknown };
function makeReqRes(method: string, over: ReqOverrides = {}) {
  const { req, res } = createMocks({ method });
  (req as { user?: unknown }).user = 'user' in over ? over.user : { isAdmin: true, id: 'admin-1' };
  (req as { body?: unknown }).body = over.body ?? {};
  (req as { query?: unknown }).query = over.query ?? { id: 'r1' };
  return { req, res };
}

describe('/api/admin/partner-signup-rules/[id] — update (PUT)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.update.mockResolvedValue({ id: 'r1', domain: 'partner.com', entitlements: ['optihashi:pro'], enabled: true });
  });

  it('rejects a non-admin with 403 (ForbiddenError) and never writes', async () => {
    const { req, res } = makeReqRes('PUT', { user: { isAdmin: false }, body: { enabled: false } });
    await expect(handlers.put(req, res)).rejects.toThrow(/admin access required/i);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a missing id with a 400', async () => {
    const { req, res } = makeReqRes('PUT', { query: {}, body: { enabled: false } });
    await expect(handlers.put(req, res)).rejects.toThrow(/rule id required/i);
    expect(repo.update).not.toHaveBeenCalled();
  });

  // Symmetric to the POST guard: a typo'd key must 400 on the update path too (issue #324).
  it('rejects an unknown entitlement key with a 400 and never writes', async () => {
    const { req, res } = makeReqRes('PUT', { body: { entitlements: ['optihash:pro'] } });
    await expect(handlers.put(req, res)).rejects.toThrow(/unknown entitlement key/i);
    expect(repo.update).not.toHaveBeenCalled();
  });

  // The assert is guarded by `if (data.entitlements)`, so an entitlements-less delta must not trip it.
  it('applies an enabled-only update without touching entitlement validation', async () => {
    const { req, res } = makeReqRes('PUT', { body: { enabled: false } });
    await handlers.put(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', enabled: false }));
    expect(invalidatePartnerRuleCache).toHaveBeenCalledTimes(1);
  });

  it('applies a valid entitlements update (200) and busts the cache', async () => {
    const { req, res } = makeReqRes('PUT', { body: { entitlements: ['optihashi:pro'] } });
    await handlers.put(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', entitlements: ['optihashi:pro'] }));
    expect(invalidatePartnerRuleCache).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the row was deleted between check and write', async () => {
    repo.update.mockResolvedValue(null);
    const { req, res } = makeReqRes('PUT', { body: { enabled: true } });
    await expect(handlers.put(req, res)).rejects.toThrow(/not found/i);
    expect(invalidatePartnerRuleCache).not.toHaveBeenCalled();
  });
});
