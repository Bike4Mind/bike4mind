import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscriptionRepository } from '@server/models/Subscription';
import { getRequestEntitlements, getUserEntitlements, requestHasEntitlement, userHasEntitlement } from './index';
import type { Request } from 'express';

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
  },
}));

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

const findActive = subscriptionRepository.findActiveUserSubscriptions as ReturnType<typeof vi.fn>;

const user = { id: 'u1', tags: ['SomeTag'], isAdmin: false };

describe('getUserEntitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants keys mapped from active subscription prices, unioned with tag-derived keys', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_pro' }]);

    await expect(getUserEntitlements(user)).resolves.toEqual(expect.arrayContaining(['sometag', 'someproduct:pro']));
    expect(findActive).toHaveBeenCalledWith('u1');
  });

  it('grants nothing from unmapped prices; tag passthrough still applies', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_unmapped' }]);

    await expect(getUserEntitlements(user)).resolves.toEqual(['sometag']);
  });

  it('handles a user with null tags and no subscriptions', async () => {
    findActive.mockResolvedValue([]);

    await expect(getUserEntitlements({ id: 'u2', tags: null })).resolves.toEqual([]);
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
    ).resolves.toEqual([]);
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
  });

  it('resolves and memoizes the list on req.entitlements (one subscription query per request)', async () => {
    findActive.mockResolvedValue([{ priceId: 'price_pro' }]);
    const req = makeReq(user);

    const first = await getRequestEntitlements(req);
    const second = await getRequestEntitlements(req);

    expect(first).toEqual(expect.arrayContaining(['sometag', 'someproduct:pro']));
    expect(second).toBe(first); // same array reference — memoized
    expect(findActive).toHaveBeenCalledTimes(1);
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
