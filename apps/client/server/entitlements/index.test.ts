import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscriptionRepository } from '@server/models/Subscription';
import {
  getRequestEntitlements,
  getUserEntitlements,
  requestHasEntitlement,
  toEntitlementUser,
  userHasEntitlement,
} from './index';
import type { Request } from 'express';
import type { IUserDocument } from '@bike4mind/common';
import { __registryRows } from '@client/lib/entitlements/registry';

// Minimal req shim - only the fields the entitlement helpers touch.
const makeReq = (user: {
  id: string;
  tags?: string[] | null;
  isAdmin?: boolean;
  email?: string | null;
  emailVerified?: boolean | null;
}) => ({ user }) as unknown as Request;

vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveUserSubscriptions: vi.fn(),
    findActiveSubscriptionsByOwners: vi.fn(async () => []),
  },
}));

const { findPlanHolderOrgIds } = vi.hoisted(() => ({ findPlanHolderOrgIds: vi.fn(async (): Promise<string[]> => []) }));
vi.mock('@bike4mind/database', () => ({ organizationRepository: { findPlanHolderOrgIds } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { warn: vi.fn() } } }));

// Fixture registry: behavior of the real rows is covered by
// lib/entitlements/registry.test.ts; here we test the resolver's wiring and
// gate semantics against controlled mappings (and avoid product literals).
vi.mock('@client/lib/entitlements/registry', async () => {
  const actual = await vi.importActual<typeof import('@client/lib/entitlements/registry')>(
    '@client/lib/entitlements/registry'
  );
  return {
    ...actual,
    resolveEntitlements: (input: {
      tags: readonly string[];
      activePriceIds: readonly string[];
      email?: string | null;
      emailVerified?: boolean | null;
    }) => {
      const keys = new Set<string>();
      for (const tag of input.tags) keys.add(actual.normalizeTag(tag));
      for (const priceId of input.activePriceIds) {
        if (priceId === 'price_pro') keys.add('someproduct:pro');
      }
      // Mirror the real verified-email-domain gate: grant only when verified.
      if (input.emailVerified === true && input.email?.toLowerCase().endsWith('@granted.example')) {
        keys.add('someproduct:domain');
      }
      return [...keys];
    },
  };
});

// Plan price ids are env-dependent, so the ladder read is a fixture; the real mapping is covered by
// lib/userSubscriptions/utils.test.ts.
vi.mock('@client/lib/userSubscriptions/utils', () => ({
  getHighestLadderTier: (subscriptions: readonly { priceId: string }[]) =>
    subscriptions.some(subscription => subscription.priceId === 'price_ladder_pro')
      ? 2
      : subscriptions.some(subscription => subscription.priceId === 'price_ladder_basic')
        ? 1
        : undefined,
}));

// DB-backed partner rules (issue #293) are resolved through this server module. Mock it so
// the resolver test stays a pure unit (no DB); the module's own behavior is covered by
// partnerRules.test.ts. Default: no partner keys, so existing cases are unaffected.
const mockPartnerEntitlements = vi.fn();
vi.mock('@server/entitlements/partnerRules', () => ({
  partnerEntitlementsForEmail: (...args: unknown[]) => mockPartnerEntitlements(...args),
}));

const findActive = subscriptionRepository.findActiveUserSubscriptions as ReturnType<typeof vi.fn>;
const findActiveByOwners = subscriptionRepository.findActiveSubscriptionsByOwners as ReturnType<typeof vi.fn>;

const user = { id: 'u1', tags: ['SomeTag'], isAdmin: false };

describe('getUserEntitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPartnerEntitlements.mockResolvedValue(new Set<string>());
    findPlanHolderOrgIds.mockResolvedValue([]);
    findActiveByOwners.mockResolvedValue([]);
  });

  it('grants keys mapped from active subscription prices, unioned with tag-derived keys', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_pro' }]);

    await expect(getUserEntitlements(user)).resolves.toEqual(expect.arrayContaining(['sometag', 'someproduct:pro']));
    expect(findActive).toHaveBeenCalledWith('u1');
  });

  // The fixture price stands in for an org-owned row: this pins that org rows feed the same
  // price-to-key resolution as owned rows. The real Team price has no key row today.
  it("confers an org row's price-derived keys on a seat member", async () => {
    findActive.mockResolvedValue([]);
    findPlanHolderOrgIds.mockResolvedValue(['org1']);
    findActiveByOwners.mockResolvedValue([{ priceId: 'price_pro', ownerType: 'Organization', ownerId: 'org1' }]);

    await expect(getUserEntitlements(user)).resolves.toContain('someproduct:pro');
    expect(findActiveByOwners).toHaveBeenCalledWith('Organization', ['org1']);
  });

  it('does not grant org plan entitlements to a user outside the org', async () => {
    findActive.mockResolvedValue([]);
    findPlanHolderOrgIds.mockResolvedValue([]);

    await expect(getUserEntitlements(user)).resolves.not.toContain('someproduct:pro');
    expect(findActiveByOwners).not.toHaveBeenCalled();
  });

  describe('plan:paid', () => {
    it.each(['price_ladder_basic', 'price_ladder_pro'])(
      'is granted for an active ladder subscription (%s)',
      async priceId => {
        findActive.mockResolvedValue([{ priceId }]);

        await expect(getUserEntitlements(user)).resolves.toContain('plan:paid');
      }
    );

    // The fixture ladder price stands in for the Team price; the real mapping is lib/userSubscriptions/utils.test.ts.
    it('is granted to a seat member through an org-owned Team subscription row', async () => {
      findActive.mockResolvedValue([]);
      findPlanHolderOrgIds.mockResolvedValue(['org1']);
      findActiveByOwners.mockResolvedValue([
        { priceId: 'price_ladder_pro', ownerType: 'Organization', ownerId: 'org1' },
      ]);

      await expect(getUserEntitlements(user)).resolves.toContain('plan:paid');
    });

    it('is granted for an admin_grant subscription row', async () => {
      findActive.mockResolvedValue([{ priceId: 'price_ladder_pro', source: 'admin_grant' }]);

      await expect(getUserEntitlements(user)).resolves.toContain('plan:paid');
    });

    it('is granted to a credit buyer without a subscription', async () => {
      findActive.mockResolvedValue([]);

      await expect(
        getUserEntitlements({ ...user, lastCreditsPurchasedAt: new Date('2026-10-01T00:00:00Z') })
      ).resolves.toContain('plan:paid');
    });

    it('is granted exactly once to a credit buyer who also subscribes', async () => {
      findActive.mockResolvedValue([{ priceId: 'price_ladder_basic' }]);

      const keys = await getUserEntitlements({ ...user, lastCreditsPurchasedAt: new Date('2026-10-01T00:00:00Z') });

      expect(keys.filter(key => key === 'plan:paid')).toHaveLength(1);
    });

    it('is not granted when lastCreditsPurchasedAt is null', async () => {
      findActive.mockResolvedValue([]);

      await expect(getUserEntitlements({ ...user, lastCreditsPurchasedAt: null })).resolves.not.toContain('plan:paid');
    });

    it('is not granted without a subscription', async () => {
      findActive.mockResolvedValue([]);

      await expect(getUserEntitlements(user)).resolves.not.toContain('plan:paid');
    });

    it('is not granted for a plan off the ladder', async () => {
      findActive.mockResolvedValue([{ priceId: 'price_standalone' }]);

      await expect(getUserEntitlements(user)).resolves.not.toContain('plan:paid');
    });

    it('is not granted by a passthrough tag', async () => {
      findActive.mockResolvedValue([]);

      await expect(getUserEntitlements({ id: 'u-tag', tags: ['plan:paid'] })).resolves.not.toContain('plan:paid');
    });

    it('is granted exactly once when a tag and a ladder subscription both name it', async () => {
      findActive.mockResolvedValue([{ priceId: 'price_ladder_basic' }]);

      const keys = await getUserEntitlements({ id: 'u-both', tags: ['plan:paid'] });

      expect(keys.filter(key => key === 'plan:paid')).toHaveLength(1);
    });
  });

  it('grants nothing from unmapped prices; tag passthrough (plus baseline) still applies', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_unmapped' }]);

    await expect(getUserEntitlements(user)).resolves.toEqual(['sometag', 'base']);
  });

  it('handles a user with null tags and no subscriptions (still holds the baseline key)', async () => {
    findActive.mockResolvedValue([]);

    await expect(getUserEntitlements({ id: 'u2', tags: null })).resolves.toEqual(['base']);
  });

  it('always grants the reserved baseline `base` key to every authenticated user', async () => {
    findActive.mockResolvedValue([]);

    // A tag-less, subscription-less account (e.g. a fresh OAuth/SSO signup) still
    // holds `base`, which is what lets it reach base models gated on `base`.
    await expect(getUserEntitlements({ id: 'u-base', tags: [] })).resolves.toContain('base');
  });

  it('grants domain-derived keys for a verified email, unioned with tag-derived keys', async () => {
    findActive.mockResolvedValue([]);

    await expect(
      getUserEntitlements({ id: 'u4', tags: ['SomeTag'], email: 'person@granted.example', emailVerified: true })
    ).resolves.toEqual(expect.arrayContaining(['sometag', 'someproduct:domain']));
  });

  it('does not grant domain-derived keys when the email is unverified', async () => {
    findActive.mockResolvedValue([]);

    await expect(
      getUserEntitlements({ id: 'u5', tags: [], email: 'person@granted.example', emailVerified: false })
    ).resolves.toEqual(['base']);
  });

  it('unions DB-backed partner-rule keys on top of the registry grants (issue #293)', async () => {
    findActive.mockResolvedValue([]);
    mockPartnerEntitlements.mockResolvedValue(new Set(['partnerproduct:pro']));

    await expect(
      getUserEntitlements({ id: 'u6', tags: ['SomeTag'], email: 'person@partner.com', emailVerified: true })
    ).resolves.toEqual(expect.arrayContaining(['sometag', 'partnerproduct:pro']));
    expect(mockPartnerEntitlements).toHaveBeenCalledWith('person@partner.com', true);
  });

  it('resolves subscription-derived keys from a preloaded list without querying the repository', async () => {
    await expect(getUserEntitlements(user, [{ priceId: 'price_pro' }])).resolves.toEqual(
      expect.arrayContaining(['sometag', 'someproduct:pro'])
    );
    expect(findActive).not.toHaveBeenCalled();
  });

  it('treats a preloaded empty list as authoritative (no repository fallback)', async () => {
    await expect(getUserEntitlements(user, [])).resolves.toEqual(['sometag', 'base']);
    expect(findActive).not.toHaveBeenCalled();
  });

  // Implied rows come from the real registry (the mock spreads it), so these assert the
  // wiring: implications apply after EVERY source, not just the pure registry ones.
  it('applies implied entitlements to a tag-derived implying key', async () => {
    findActive.mockResolvedValue([]);
    for (const row of __registryRows.impliedRows) {
      const keys = await getUserEntitlements({ id: 'u7', tags: [row.ifHeld] });
      expect(keys).toEqual([row.ifHeld, 'base', ...row.alsoGrant]);
    }
  });

  it('applies implied entitlements to a partner-rule-derived implying key', async () => {
    findActive.mockResolvedValue([]);
    for (const row of __registryRows.impliedRows) {
      mockPartnerEntitlements.mockResolvedValue(new Set([row.ifHeld]));
      const keys = await getUserEntitlements({ id: 'u8', tags: [], email: 'p@partner.com', emailVerified: true });
      expect(keys).toEqual(expect.arrayContaining([row.ifHeld, ...row.alsoGrant]));
    }
  });

  it('skips a non-string key from a malformed source instead of throwing', async () => {
    findActive.mockResolvedValue([]);
    mockPartnerEntitlements.mockResolvedValue(new Set([123, 'Partner:Key']));
    const keys = await getUserEntitlements({ id: 'u10', tags: [], email: 'p@partner.com', emailVerified: true });
    expect(keys).toEqual(['partner:key', 'base']);
  });

  it('returns no implied key when the implying key is not held', async () => {
    findActive.mockResolvedValue([]);
    const keys = await getUserEntitlements({ id: 'u9', tags: [] });
    for (const row of __registryRows.impliedRows) {
      for (const key of row.alsoGrant) expect(keys).not.toContain(key);
    }
  });
});

describe('userHasEntitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants when an active subscription maps to the key', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_pro' }]);

    await expect(userHasEntitlement(user, 'someproduct:pro')).resolves.toBe(true);
  });

  it('denies when no subscription or tag grants the key (canceled subs never reach the resolver)', async () => {
    // findActiveUserSubscriptions filters status === 'active' at the query -
    // a canceled/past_due/trialing sub is simply absent from this result.
    findActive.mockResolvedValue([]);

    await expect(userHasEntitlement(user, 'someproduct:pro')).resolves.toBe(false);
  });

  it('normalizes the requested key before comparing', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_pro' }]);

    await expect(userHasEntitlement(user, '  SomeProduct:PRO ')).resolves.toBe(true);
  });

  it('bypasses for admins without querying subscriptions', async () => {
    await expect(userHasEntitlement({ id: 'a1', isAdmin: true }, 'anything')).resolves.toBe(true);
    expect(findActive).not.toHaveBeenCalled();
  });
});

describe('getRequestEntitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findPlanHolderOrgIds.mockResolvedValue([]);
    findActiveByOwners.mockResolvedValue([]);
  });

  it('resolves and memoizes the list on req.entitlements (one subscription query per request)', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_pro' }]);
    const req = makeReq(user);

    const first = await getRequestEntitlements(req);
    const second = await getRequestEntitlements(req);

    expect(first).toEqual(expect.arrayContaining(['sometag', 'someproduct:pro']));
    expect(second).toBe(first); // same array reference — memoized
    expect(findActive).toHaveBeenCalledTimes(1);
    // Plan-holder resolution must not fill the data-access membership memo.
    expect((req as unknown as { membershipOrgIds?: string[] }).membershipOrgIds).toBeUndefined();
    expect(findPlanHolderOrgIds).toHaveBeenCalledTimes(1);
  });

  // An org-leg failure degrades to the caller's own rows (logged in activeSubscriptions) rather
  // than failing every gated route for every org member; the user-owned keys still resolve.
  it('degrades to user-owned keys when the membership read fails', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_pro' }]);
    findPlanHolderOrgIds.mockRejectedValue(new Error('mongo unavailable'));
    const req = makeReq(user);

    await expect(getRequestEntitlements(req)).resolves.toContain('someproduct:pro');
    expect(findActiveByOwners).not.toHaveBeenCalled();
  });

  it('degrades to user-owned keys when the org-subscription read fails', async () => {
    findActive.mockResolvedValue([]);
    findPlanHolderOrgIds.mockResolvedValue(['org1']);
    findActiveByOwners.mockRejectedValue(new Error('mongo unavailable'));
    const req = makeReq(user);

    await expect(getRequestEntitlements(req)).resolves.not.toContain('someproduct:pro');
  });

  it('does not memoize when the user-owned read fails', async () => {
    findActive.mockRejectedValue(new Error('mongo unavailable'));
    const req = makeReq(user);

    await expect(getRequestEntitlements(req)).rejects.toThrow('mongo unavailable');
    expect((req as unknown as { entitlements?: unknown }).entitlements).toBeUndefined();
  });

  it('memoizes an empty list (??= does not re-query on a valid empty result)', async () => {
    findActive.mockResolvedValue([]);
    const req = makeReq({ id: 'u3', tags: [] });

    await getRequestEntitlements(req);
    await getRequestEntitlements(req);

    expect(findActive).toHaveBeenCalledTimes(1);
  });

  // Fail-closed on an unauthenticated request - returns an empty list (holds nothing)
  // rather than throwing on the getUserEntitlements dereference, and never queries.
  it('returns [] (fail-closed) when the request has no authenticated user', async () => {
    await expect(getRequestEntitlements({} as unknown as Request)).resolves.toEqual([]);
    expect(findActive).not.toHaveBeenCalled();
  });
});

describe('requestHasEntitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants when the memoized list holds the key (normalized)', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_pro' }]);

    await expect(requestHasEntitlement(makeReq(user), '  SomeProduct:PRO ')).resolves.toBe(true);
  });

  it('denies when neither subscription nor tag grants the key', async () => {
    findActive.mockResolvedValue([]);

    await expect(requestHasEntitlement(makeReq(user), 'someproduct:pro')).resolves.toBe(false);
  });

  it('bypasses for admins without querying subscriptions (developer parity is a call-site concern)', async () => {
    await expect(requestHasEntitlement(makeReq({ id: 'a1', isAdmin: true }), 'anything')).resolves.toBe(true);
    expect(findActive).not.toHaveBeenCalled();
  });

  // Fail-closed at the shared choke point: a nullish user denies (not throws) before
  // the downstream getUserEntitlements dereference. baseApi populates req.user in
  // production; this guards the defensive edge every product gate funnels through.
  it('denies (fail-closed) when the request has no authenticated user', async () => {
    await expect(requestHasEntitlement({} as unknown as Request, 'anything')).resolves.toBe(false);
    expect(findActive).not.toHaveBeenCalled();
  });
});

describe('toEntitlementUser', () => {
  // Callers that project the user (model picker, /api/v1/me) must not lose the purchase signal behind plan:paid.
  it('keeps lastCreditsPurchasedAt', () => {
    const purchasedAt = new Date('2026-10-01T00:00:00Z');
    const user = { id: 'u1', tags: [], lastCreditsPurchasedAt: purchasedAt } as unknown as IUserDocument;

    expect(toEntitlementUser(user).lastCreditsPurchasedAt).toBe(purchasedAt);
  });
});
