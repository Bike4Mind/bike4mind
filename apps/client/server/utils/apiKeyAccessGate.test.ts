import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CreditHolderType, ForbiddenError } from '@bike4mind/common';

// Price ids are read from env when the plan constants load, so set them before any import:
// the real SUBSCRIPTION_PLANS / TEAM_PLAN then carry these ids, and the gate resolves them
// through the real getEntitlingPlanByPriceId.
const PRICE = vi.hoisted(() => {
  const ids = { basic: 'price_test_professional', team: 'price_test_team', standalone: 'price_test_libonc' };
  process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST = ids.basic;
  process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST = ids.team;
  process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_TEST = ids.standalone;
  return ids;
});

const { getSettingsMapMock, getActiveSubscriptionsForUserMock, findActiveSubscriptionsByOwnersMock, findBySidMock } =
  vi.hoisted(() => ({
    getSettingsMapMock: vi.fn<(...args: unknown[]) => Promise<Record<string, string>>>(),
    getActiveSubscriptionsForUserMock: vi.fn(),
    findActiveSubscriptionsByOwnersMock: vi.fn(),
    findBySidMock: vi.fn(),
  }));

vi.unmock('@server/utils/apiKeyAccessGate');
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  authSessionRepository: { findBySid: findBySidMock },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...args: unknown[]) => getSettingsMapMock(...args),
}));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwners: findActiveSubscriptionsByOwnersMock },
}));
vi.mock('@server/entitlements/activeSubscriptions', () => ({
  getActiveSubscriptionsForUser: getActiveSubscriptionsForUserMock,
  getRequestActiveSubscriptions: vi.fn(),
}));

import {
  API_KEY_ACCESS_DENIED_MESSAGE,
  CLI_ACCESS_DENIED_MESSAGE,
  assertApiKeyAccessAllowed,
  assertCliSessionAllowed,
  clearApiKeyAccessModeCache,
  isApiKeyAccessAllowed,
} from '@server/utils/apiKeyAccessGate';

const USER = { id: 'user-1', isAdmin: false, tags: [] };
const ADMIN = { id: 'admin-1', isAdmin: true, tags: [] };
const DEV = { id: 'dev-1', tags: ['developer'] };

const setMode = (mode: string | undefined) =>
  getSettingsMapMock.mockResolvedValue(mode === undefined ? {} : { apiKeyAccess: mode });
const subscribedTo = (...priceIds: string[]) =>
  getActiveSubscriptionsForUserMock.mockResolvedValue(priceIds.map(priceId => ({ priceId })));

beforeEach(() => {
  vi.clearAllMocks();
  clearApiKeyAccessModeCache();
  subscribedTo();
  findActiveSubscriptionsByOwnersMock.mockResolvedValue([]);
});

describe('isApiKeyAccessAllowed', () => {
  // [mode, plan, expected]. Basic = Professional, Pro = Team (org seat), standalone = tier-less plan.
  const matrix: [string, keyof typeof PRICE | 'none', boolean][] = [
    ['all', 'none', true],
    ['all', 'basic', true],
    ['paid', 'none', false],
    ['paid', 'basic', true],
    ['paid', 'team', true],
    ['paid', 'standalone', true],
    ['disabled', 'basic', false],
    ['disabled', 'team', false],
    ['disabled', 'none', false],
  ];

  it.each(matrix)('mode=%s plan=%s -> %s', async (mode, plan, expected) => {
    setMode(mode);
    if (plan === 'none') subscribedTo();
    else subscribedTo(PRICE[plan]);
    expect(await isApiKeyAccessAllowed(USER)).toBe(expected);
  });

  it('denies an unknown price id under paid', async () => {
    setMode('paid');
    subscribedTo('price_unknown');
    expect(await isApiKeyAccessAllowed(USER)).toBe(false);
  });

  it.each([
    ['admin', ADMIN],
    ['developer-tagged', DEV],
  ])('lets an %s through under disabled without reading anything', async (_label, user) => {
    setMode('disabled');
    expect(await isApiKeyAccessAllowed(user)).toBe(true);
    expect(getSettingsMapMock).not.toHaveBeenCalled();
  });

  it('exempts an admin-provisioned key for a free owner, even under disabled', async () => {
    setMode('disabled');
    expect(await isApiKeyAccessAllowed(USER, { createdByUserId: 'admin-1' })).toBe(true);
  });

  describe('setting resolution (real getSettingsValue)', () => {
    it('defaults to paid on hosted when unset', async () => {
      setMode(undefined);
      expect(await isApiKeyAccessAllowed(USER)).toBe(false);
      clearApiKeyAccessModeCache();
      subscribedTo(PRICE.basic);
      expect(await isApiKeyAccessAllowed(USER)).toBe(true);
    });

    it('resolves an invalid stored value to the default (paid), failing closed', async () => {
      setMode('PAID');
      expect(await isApiKeyAccessAllowed(USER)).toBe(false);
    });

    it('reads the setting outside the shared settings cache', async () => {
      setMode('all');
      await isApiKeyAccessAllowed(USER);
      expect(getSettingsMapMock).toHaveBeenCalledWith(expect.anything(), {
        skipCache: true,
        names: ['apiKeyAccess'],
      });
    });
  });

  describe('30 s in-process cache', () => {
    afterEach(() => vi.useRealTimers());

    it('serves the cached mode within the TTL and rereads after it', async () => {
      vi.useFakeTimers();
      setMode('all');
      expect(await isApiKeyAccessAllowed(USER)).toBe(true);
      setMode('disabled');
      expect(await isApiKeyAccessAllowed(USER)).toBe(true);
      expect(getSettingsMapMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_001);
      expect(await isApiKeyAccessAllowed(USER)).toBe(false);
      expect(getSettingsMapMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('org-billed keys under paid', () => {
    const orgBilling = { billingOwnerType: CreditHolderType.Organization, organizationId: 'org-1' };

    beforeEach(() => setMode('paid'));

    it('admits a free minter when the paying org holds the Team plan', async () => {
      findActiveSubscriptionsByOwnersMock.mockResolvedValue([{ priceId: PRICE.team }]);
      expect(await isApiKeyAccessAllowed(USER, orgBilling)).toBe(true);
      expect(findActiveSubscriptionsByOwnersMock).toHaveBeenCalledWith('Organization', ['org-1']);
    });

    it('denies when the paying org has no paid plan', async () => {
      expect(await isApiKeyAccessAllowed(USER, orgBilling)).toBe(false);
    });

    it('does not consult an org for a user-billed key', async () => {
      expect(await isApiKeyAccessAllowed(USER, { billingOwnerType: CreditHolderType.User })).toBe(false);
      expect(findActiveSubscriptionsByOwnersMock).not.toHaveBeenCalled();
    });

    it('never admits an org-billed key under disabled', async () => {
      clearApiKeyAccessModeCache();
      setMode('disabled');
      findActiveSubscriptionsByOwnersMock.mockResolvedValue([{ priceId: PRICE.team }]);
      expect(await isApiKeyAccessAllowed(USER, orgBilling)).toBe(false);
    });
  });

  describe('request memo', () => {
    beforeEach(() => setMode('paid'));

    it('reads strictly and seeds req.activeSubscriptions for the rest of the request', async () => {
      subscribedTo(PRICE.basic);
      const req: { user?: { id: string }; activeSubscriptions?: unknown[] } = {};
      expect(await isApiKeyAccessAllowed(USER, undefined, req)).toBe(true);
      expect(getActiveSubscriptionsForUserMock).toHaveBeenCalledWith('user-1', { strict: true });
      expect(req.activeSubscriptions).toEqual([{ priceId: PRICE.basic }]);
    });

    it('reuses an existing memo for the same user', async () => {
      const req = { user: { id: 'user-1' }, activeSubscriptions: [{ priceId: PRICE.team }] };
      expect(await isApiKeyAccessAllowed(USER, undefined, req as never)).toBe(true);
      expect(getActiveSubscriptionsForUserMock).not.toHaveBeenCalled();
    });
  });

  describe('read errors fail closed', () => {
    it('propagates a setting read failure instead of allowing', async () => {
      getSettingsMapMock.mockRejectedValue(new Error('db down'));
      await expect(isApiKeyAccessAllowed(USER)).rejects.toThrow('db down');
    });

    it('propagates a subscription (including org-leg) read failure under paid instead of allowing', async () => {
      setMode('paid');
      getActiveSubscriptionsForUserMock.mockRejectedValue(new Error('org leg down'));
      await expect(isApiKeyAccessAllowed(USER)).rejects.toThrow('org leg down');
    });
  });
});

describe('assertApiKeyAccessAllowed', () => {
  it('throws ForbiddenError with the paid-subscription message on deny', async () => {
    setMode('paid');
    const error = await assertApiKeyAccessAllowed(USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toBe(API_KEY_ACCESS_DENIED_MESSAGE);
  });

  it('resolves on allow', async () => {
    setMode('paid');
    subscribedTo(PRICE.basic);
    await expect(assertApiKeyAccessAllowed(USER)).resolves.toBeUndefined();
  });
});

describe('assertCliSessionAllowed', () => {
  beforeEach(() => setMode('paid'));

  it('refuses a device-flow (CLI) session the setting denies', async () => {
    findBySidMock.mockResolvedValue({ createdVia: 'device', clientId: 'b4m-cli' });
    const error = await assertCliSessionAllowed(USER, 'sid-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toBe(CLI_ACCESS_DENIED_MESSAGE);
  });

  it('refuses a desktop session identified only by its client id', async () => {
    findBySidMock.mockResolvedValue({ createdVia: 'legacy-migration', clientId: 'b4m-desktop' });
    await expect(assertCliSessionAllowed(USER, 'sid-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('leaves browser sessions alone without reading subscriptions', async () => {
    findBySidMock.mockResolvedValue({ createdVia: 'otc', clientId: null });
    await expect(assertCliSessionAllowed(USER, 'sid-1')).resolves.toBeUndefined();
    expect(getActiveSubscriptionsForUserMock).not.toHaveBeenCalled();
  });

  it('admits a CLI session for a subscriber, including a standalone plan', async () => {
    findBySidMock.mockResolvedValue({ createdVia: 'device', clientId: 'b4m-cli' });
    subscribedTo(PRICE.standalone);
    await expect(assertCliSessionAllowed(USER, 'sid-1')).resolves.toBeUndefined();
  });

  it('admits every CLI session under all', async () => {
    setMode('all');
    findBySidMock.mockResolvedValue({ createdVia: 'device', clientId: 'b4m-cli' });
    await expect(assertCliSessionAllowed(USER, 'sid-1')).resolves.toBeUndefined();
  });

  it('skips the session read for admins and for tokens without a sid', async () => {
    await assertCliSessionAllowed(ADMIN, 'sid-1');
    await assertCliSessionAllowed(USER, undefined);
    expect(findBySidMock).not.toHaveBeenCalled();
  });
});
