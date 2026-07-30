import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  allKnownEntitlementKeys,
  grantTagForEntitlement,
  isBypassExemptEntitlement,
  resolveEntitlements,
  EMBED_WHITELABEL_ENTITLEMENT_KEY,
  PRICE_ENTITLEMENTS,
} from '@client/lib/entitlements/registry';

const { mockUserFind, mockSubs, mockPartnerKeys } = vi.hoisted(() => ({
  mockUserFind: vi.fn(),
  mockSubs: vi.fn(),
  mockPartnerKeys: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
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

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
}));

vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveUserSubscriptions: (...a: unknown[]) => mockSubs(...a) },
}));

vi.mock('@server/entitlements/partnerRules', () => ({
  partnerEntitlementsForEmail: (...a: unknown[]) => mockPartnerKeys(...a),
}));

import handler from '../entitlements';

const ADMIN = { id: 'admin1', isAdmin: true };

const run = ({ user, userId = 'u1' }: { user?: unknown; userId?: string } = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockUserFind.mockReset();
  mockSubs.mockReset().mockResolvedValue([]);
  mockPartnerKeys.mockReset().mockResolvedValue(new Set());
});

describe('GET /api/admin/users/:userId/entitlements', () => {
  it('rejects non-admins before touching any data source', async () => {
    const { promise } = run({ user: { id: 'u2', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (no req.user)', async () => {
    const { promise } = run();
    await expect(promise).rejects.toThrow();
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('rejects when the target user does not exist', async () => {
    mockUserFind.mockResolvedValue(null);
    const { promise } = run({ user: ADMIN });
    await expect(promise).rejects.toThrow();
  });

  it('returns every known entitlement key, held=false with no sources, for a bare user', async () => {
    mockUserFind.mockResolvedValue({ id: 'u1', tags: [], isAdmin: false, email: null, emailVerified: false });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const body = res._getJSONData();
    const keys = body.entitlements.map((r: { key: string }) => r.key);
    expect(new Set(keys)).toEqual(new Set(allKnownEntitlementKeys()));
    for (const row of body.entitlements) {
      expect(row.held).toBe(false);
      expect(row.sources).toEqual([]);
    }
  });

  it('marks the granting tag as a source and sets grantTag/held for a tag-granted key', async () => {
    const key = allKnownEntitlementKeys().find(k => grantTagForEntitlement(k));
    if (!key) throw new Error('fixture assumption: at least one tag-granted key must exist in the real registry');
    const grantTag = grantTagForEntitlement(key)!;

    mockUserFind.mockResolvedValue({ id: 'u1', tags: [grantTag], isAdmin: false, email: null, emailVerified: false });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const row = res._getJSONData().entitlements.find((r: { key: string }) => r.key === key);
    expect(row.held).toBe(true);
    expect(row.grantTag).toBe(grantTag);
    expect(row.sources).toEqual([{ type: 'tag', detail: grantTag }]);
  });

  it('a key with no tag-based grant path reports grantTag: undefined', async () => {
    const key = allKnownEntitlementKeys().find(k => !grantTagForEntitlement(k));
    if (!key) return; // every known key happens to have a tag grant today - nothing to assert
    mockUserFind.mockResolvedValue({ id: 'u1', tags: [], isAdmin: false, email: null, emailVerified: false });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const row = res._getJSONData().entitlements.find((r: { key: string }) => r.key === key);
    expect(row.grantTag).toBeUndefined();
  });

  it('sets admin-bypass as a source and held=true for every NON-exempt key when the target user isAdmin', async () => {
    mockUserFind.mockResolvedValue({ id: 'u1', tags: [], isAdmin: true, email: null, emailVerified: false });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const body = res._getJSONData();
    const nonExempt = body.entitlements.filter((r: { key: string }) => !isBypassExemptEntitlement(r.key));
    expect(nonExempt.length).toBeGreaterThan(0);
    for (const row of nonExempt) {
      expect(row.held).toBe(true);
      expect(row.sources).toEqual(expect.arrayContaining([{ type: 'admin-bypass', detail: 'Super Admin' }]));
    }
  });

  it('does NOT attribute a bypass-exempt key (embed white-label) to admin-bypass, even for an admin', async () => {
    mockUserFind.mockResolvedValue({ id: 'u1', tags: [], isAdmin: true, email: null, emailVerified: false });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const row = res
      ._getJSONData()
      .entitlements.find((r: { key: string }) => r.key === EMBED_WHITELABEL_ENTITLEMENT_KEY);
    expect(row).toBeDefined();
    expect(row.held).toBe(false);
    expect(row.sources).toEqual([]);
  });

  it('sets developer-bypass as a source and held=true for every NON-exempt key when the target user has a developer tag', async () => {
    mockUserFind.mockResolvedValue({
      id: 'u1',
      tags: ['Developer'],
      isAdmin: false,
      email: null,
      emailVerified: false,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const body = res._getJSONData();
    const nonExempt = body.entitlements.filter((r: { key: string }) => !isBypassExemptEntitlement(r.key));
    expect(nonExempt.length).toBeGreaterThan(0);
    for (const row of nonExempt) {
      expect(row.held).toBe(true);
      expect(row.sources).toEqual(expect.arrayContaining([{ type: 'developer-bypass', detail: 'Developer tag' }]));
    }
  });

  it('does NOT attribute embed white-label to developer-bypass; a developer-tagged user holds it only via the literal tag', async () => {
    // The reported bug: a Developer-tagged user without the embed comp tag was shown
    // "Held / Developer tag" while the embed gate (owner-scoped, no bypass) denies it.
    mockUserFind.mockResolvedValue({
      id: 'u1',
      tags: ['Developer'],
      isAdmin: false,
      email: null,
      emailVerified: false,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const body = res._getJSONData();
    const embedRow = body.entitlements.find((r: { key: string }) => r.key === EMBED_WHITELABEL_ENTITLEMENT_KEY);
    expect(embedRow.held).toBe(false);
    expect(embedRow.sources).toEqual([]);
    // Targeted, not blanket: a non-exempt key for the SAME user still reports developer-bypass.
    const other = body.entitlements.find((r: { key: string }) => !isBypassExemptEntitlement(r.key));
    expect(other.sources).toEqual(expect.arrayContaining([{ type: 'developer-bypass', detail: 'Developer tag' }]));
  });

  it('reports embed white-label held via the literal tag only (no bypass noise) even for a developer admin', async () => {
    const grantTag = grantTagForEntitlement(EMBED_WHITELABEL_ENTITLEMENT_KEY);
    if (!grantTag) throw new Error('fixture assumption: embed white-label has a granting comp tag');
    mockUserFind.mockResolvedValue({
      id: 'u1',
      tags: [grantTag, 'Developer'],
      isAdmin: true,
      email: null,
      emailVerified: false,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const embedRow = res
      ._getJSONData()
      .entitlements.find((r: { key: string }) => r.key === EMBED_WHITELABEL_ENTITLEMENT_KEY);
    expect(embedRow.held).toBe(true);
    // Only the tag source - no admin-/developer-bypass, so the client's "revoking
    // the tag alone will not remove access" warning does not fire.
    expect(embedRow.sources).toEqual([{ type: 'tag', detail: grantTag }]);
  });

  it('panel-matches-the-gate: reported embed white-label held equals the owner-scoped gate for every user shape', async () => {
    const grantTag = grantTagForEntitlement(EMBED_WHITELABEL_ENTITLEMENT_KEY)!;
    const matrix = [
      { label: 'plain', tags: [], isAdmin: false },
      { label: 'developer', tags: ['Developer'], isAdmin: false },
      { label: 'admin', tags: [], isAdmin: true },
      { label: 'embed-whitelabel', tags: [grantTag], isAdmin: false },
      { label: 'embed-whitelabel+developer', tags: [grantTag, 'Developer'], isAdmin: false },
    ];
    for (const shape of matrix) {
      mockUserFind.mockResolvedValue({
        id: 'u1',
        tags: shape.tags,
        isAdmin: shape.isAdmin,
        email: null,
        emailVerified: false,
      });
      const { res, promise } = run({ user: ADMIN });
      await promise;
      const embedRow = res
        ._getJSONData()
        .entitlements.find((r: { key: string }) => r.key === EMBED_WHITELABEL_ENTITLEMENT_KEY);
      // The owner-scoped embed gate reduces to getUserEntitlements(owner) -> resolveEntitlements(...).
      const gateHolds = resolveEntitlements({ tags: shape.tags, activePriceIds: [] }).includes(
        EMBED_WHITELABEL_ENTITLEMENT_KEY
      );
      expect(embedRow.held, `held mismatch for ${shape.label}`).toBe(gateHolds);
      expect(
        embedRow.sources.every((s: { type: string }) => s.type !== 'admin-bypass' && s.type !== 'developer-bypass'),
        `bypass source leaked for ${shape.label}`
      ).toBe(true);
    }
  });

  it('surfaces a DB-backed partner rule grant as a domain source', async () => {
    const key = allKnownEntitlementKeys()[0];
    mockPartnerKeys.mockResolvedValue(new Set([key]));
    mockUserFind.mockResolvedValue({
      id: 'u1',
      tags: [],
      isAdmin: false,
      email: 'person@partner.example',
      emailVerified: true,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const row = res._getJSONData().entitlements.find((r: { key: string }) => r.key === key);
    expect(row.held).toBe(true);
    expect(
      row.sources.some(
        (s: { type: string; detail: string }) => s.type === 'domain' && s.detail.includes('partner rule')
      )
    ).toBe(true);
  });

  it('does not surface a domain source from an UNVERIFIED email, even if a partner rule would otherwise match', async () => {
    const key = allKnownEntitlementKeys()[0];
    mockPartnerKeys.mockResolvedValue(new Set()); // real partnerEntitlementsForEmail fails closed on unverified too
    mockUserFind.mockResolvedValue({
      id: 'u1',
      tags: [],
      isAdmin: false,
      email: 'person@partner.example',
      emailVerified: false,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const row = res._getJSONData().entitlements.find((r: { key: string }) => r.key === key);
    expect(row.held).toBe(false);
  });

  it('surfaces an active subscription as a subscription source', async () => {
    const [priceId, keys] = [...PRICE_ENTITLEMENTS.entries()][0] ?? [];
    if (!priceId || !keys?.[0]) return; // no price row configured in this environment
    const key = keys[0];
    mockSubs.mockResolvedValue([{ priceId }]);
    mockUserFind.mockResolvedValue({ id: 'u1', tags: [], isAdmin: false, email: null, emailVerified: false });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const row = res._getJSONData().entitlements.find((r: { key: string }) => r.key === key);
    expect(row.held).toBe(true);
    expect(row.sources.some((s: { type: string }) => s.type === 'subscription')).toBe(true);
  });
});
