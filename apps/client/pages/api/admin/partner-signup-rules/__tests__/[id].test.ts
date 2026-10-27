import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Same middleware-strip pattern as index.test.ts: capture the handlers registered on the
// baseApi chain so PUT/DELETE can be invoked directly. Everything referenced inside a
// vi.mock factory must live in vi.hoisted (mocks are hoisted above const initialization).
const { handlers, repo, invalidatePartnerRuleCache, audit } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  repo: { update: vi.fn(), findById: vi.fn(), delete: vi.fn() },
  invalidatePartnerRuleCache: vi.fn(),
  audit: vi.fn(),
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

vi.mock('@bike4mind/database', () => ({
  partnerSignupRuleRepository: repo,
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: audit }));
// Keep assertKnownEntitlements real (exercises the actual known-key validation); spy only on invalidate.
vi.mock('@server/entitlements/partnerRules', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/entitlements/partnerRules')>()),
  invalidatePartnerRuleCache,
}));

// Importing the route registers handlers.put / handlers.delete via the mocked baseApi.
import '@pages/api/admin/partner-signup-rules/[id]';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';

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

  it('accepts a datalake:<slug> entitlement update (#1669), same as the create route', async () => {
    repo.update.mockResolvedValue({ id: 'r1', domain: 'partner.com', entitlements: ['datalake:acme-legal'] });
    const { req, res } = makeReqRes('PUT', { body: { entitlements: ['datalake:acme-legal'] } });
    await handlers.put(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1', entitlements: ['datalake:acme-legal'] })
    );
  });

  it('rejects a malformed datalake: key (empty slug) with a 400 and never writes', async () => {
    const { req, res } = makeReqRes('PUT', { body: { entitlements: ['datalake:'] } });
    await expect(handlers.put(req, res)).rejects.toThrow(/unknown entitlement key/i);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a subscription for an unknown plan with a 400 and never writes', async () => {
    const body = { subscription: { priceId: 'price_nope', durationMonths: 1 } };
    const { req, res } = makeReqRes('PUT', { body });
    await expect(handlers.put(req, res)).rejects.toThrow(/unknown subscription plan/i);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('sets a catalog-plan subscription and clears it with null', async () => {
    const subscription = { priceId: SUBSCRIPTION_PLANS[0].priceId, durationMonths: 2 };
    const set = makeReqRes('PUT', { body: { subscription } });
    await handlers.put(set.req, set.res);
    expect(repo.update).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'r1', subscription }));

    const { req, res } = makeReqRes('PUT', { body: { subscription: null } });
    await handlers.put(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(repo.update).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'r1', subscription: null }));
  });

  it('keeps a rule editable when its stored plan was removed, but rejects switching to an unknown plan', async () => {
    const stale = { priceId: 'price_removed', durationMonths: 2 };
    repo.findById.mockResolvedValue({ id: 'r1', subscription: stale });

    const same = makeReqRes('PUT', { body: { subscription: stale, enabled: false } });
    await handlers.put(same.req, same.res);
    expect(same.res._getStatusCode()).toBe(200);

    const other = makeReqRes('PUT', { body: { subscription: { priceId: 'price_nope', durationMonths: 2 } } });
    await expect(handlers.put(other.req, other.res)).rejects.toThrow(/unknown subscription plan/i);
  });

  it('returns 404 when the row was deleted between check and write', async () => {
    repo.update.mockResolvedValue(null);
    const { req, res } = makeReqRes('PUT', { body: { enabled: true } });
    await expect(handlers.put(req, res)).rejects.toThrow(/not found/i);
    expect(invalidatePartnerRuleCache).not.toHaveBeenCalled();
  });
});

describe('/api/admin/partner-signup-rules/[id] - admin audit', () => {
  const stored = { id: 'r1', domain: 'partner.com', entitlements: ['optihashi:pro'], enabled: true };

  beforeEach(() => {
    vi.clearAllMocks();
    repo.findById.mockResolvedValue(stored);
    repo.update.mockResolvedValue({ ...stored, enabled: false });
    repo.delete.mockResolvedValue(undefined);
    audit.mockResolvedValue(null);
  });

  it('records a strict .updated entry with the before/after diff of the sent fields', async () => {
    const { req, res } = makeReqRes('PUT', { body: { enabled: false, entitlements: ['optihashi:pro'] } });
    await handlers.put(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.partner_signup_rule.updated',
        target: { kind: 'settings', id: 'r1', displayName: 'partner.com' },
        changes: [{ field: 'enabled', before: true, after: false }],
      })
    );
    expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(audit.mock.invocationCallOrder[0]);
  });

  it('does not report an update as success when the audit write rejects', async () => {
    audit.mockRejectedValueOnce(new Error('audit down'));
    const { req, res } = makeReqRes('PUT', { body: { enabled: false } });
    await expect(handlers.put(req, res)).rejects.toThrow(/audit down/);
    expect(res._isEndCalled()).toBe(false);
    expect(invalidatePartnerRuleCache).not.toHaveBeenCalled();
  });

  it('records a strict .deleted entry after the delete', async () => {
    const { req, res } = makeReqRes('DELETE');
    await handlers.delete(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.partner_signup_rule.deleted',
        target: { kind: 'settings', id: 'r1', displayName: 'partner.com' },
      })
    );
    expect(repo.delete.mock.invocationCallOrder[0]).toBeLessThan(audit.mock.invocationCallOrder[0]);
  });

  it('does not report a delete as success when the audit write rejects', async () => {
    audit.mockRejectedValueOnce(new Error('audit down'));
    const { req, res } = makeReqRes('DELETE');
    await expect(handlers.delete(req, res)).rejects.toThrow(/audit down/);
    expect(res._isEndCalled()).toBe(false);
    expect(invalidatePartnerRuleCache).not.toHaveBeenCalled();
  });

  it('does not audit a delete of a missing rule', async () => {
    repo.findById.mockResolvedValue(null);
    const { req, res } = makeReqRes('DELETE');
    await expect(handlers.delete(req, res)).rejects.toThrow(/not found/i);
    expect(audit).not.toHaveBeenCalled();
  });
});
