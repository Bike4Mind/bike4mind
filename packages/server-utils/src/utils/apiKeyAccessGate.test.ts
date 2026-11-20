import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: (_, key) => ({ value: `test-${String(key)}` }) }),
}));
import { CreditHolderType, OAUTH_DEVICE_CLIENT_IDS, settingsMap } from '@bike4mind/common';
import type { ActiveSubscriptionsRequest } from '../entitlements/activeSubscriptions';

const { getSettingsMapMock, findActiveUserSubscriptions, findActiveSubscriptionsByOwners, findPlanHolderOrgIds } =
  vi.hoisted(() => {
    return {
      getSettingsMapMock: vi.fn<(...args: unknown[]) => Promise<Record<string, string>>>(),
      findActiveUserSubscriptions: vi.fn(),
      findActiveSubscriptionsByOwners: vi.fn(),
      findPlanHolderOrgIds: vi.fn(),
    };
  });

const { findBySidMock, findByClientIds } = vi.hoisted(() => ({ findBySidMock: vi.fn(), findByClientIds: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  authSessionRepository: { findBySid: findBySidMock },
  oauthClientRepository: { findByClientIds },
  organizationRepository: { findPlanHolderOrgIds },
}));
vi.mock('@bike4mind/utils', async () => {
  const { getSettingsValue } = await import('../../../../b4m-core/utils/src/settings');
  return { getSettingsMap: getSettingsMapMock, getSettingsValue };
});
vi.mock('../models/Subscription', () => ({
  subscriptionRepository: { findActiveUserSubscriptions, findActiveSubscriptionsByOwners },
}));

const USER = { id: 'user-1', isAdmin: false, tags: [] };
const ADMIN = { id: 'admin-1', isAdmin: true, tags: [] };
const CREDIT_BUYER = { ...USER, lastCreditsPurchasedAt: new Date('2026-10-01T00:00:00Z') };
const ORG_BILLING = { billingOwnerType: CreditHolderType.Organization, organizationId: 'org-1' };
const setMode = (mode: string | undefined) =>
  getSettingsMapMock.mockResolvedValue(mode === undefined ? {} : { apiKeyAccess: mode });

let gate: typeof import('./apiKeyAccessGate');
let plans: typeof import('../lib/userSubscriptions/constants');
// Re-read after vi.resetModules(): this package inlines @bike4mind/common, so the gate throws the
// fresh module's class and a top-level import would fail toBeInstanceOf.
let ForbiddenError: typeof import('@bike4mind/common').ForbiddenError;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  setMode('paid');
  findActiveUserSubscriptions.mockResolvedValue([]);
  findPlanHolderOrgIds.mockResolvedValue([]);
  findActiveSubscriptionsByOwners.mockResolvedValue([]);
  gate = await import('./apiKeyAccessGate');
  plans = await import('../lib/userSubscriptions/constants');
  ({ ForbiddenError } = await import('@bike4mind/common'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isApiKeyAccessAllowed', () => {
  it.each([
    ['all', true],
    ['paid', false],
    ['disabled', false],
  ] as const)('mode=%s free user -> %s', async (mode, allowed) => {
    setMode(mode);
    expect(await gate.isApiKeyAccessAllowed(USER)).toBe(allowed);
    if (mode !== 'paid') expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
  });

  it.each(['all', 'paid', 'disabled'])('preserves admin and developer bypass under %s', async mode => {
    setMode(mode);
    expect(await gate.isApiKeyAccessAllowed(ADMIN)).toBe(true);
    expect(await gate.isApiKeyAccessAllowed({ ...USER, tags: ['developer'] })).toBe(true);
    expect(getSettingsMapMock).not.toHaveBeenCalled();
    expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
  });

  it('preserves trusted admin-provisioned keys even when the switch is disabled', async () => {
    setMode('disabled');
    expect(await gate.isApiKeyAccessAllowed(USER, { createdByUserId: 'admin-1' })).toBe(true);
    expect(getSettingsMapMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'PAID', '', 'invalid'])('uses the real settings default for stored %s', async stored => {
    setMode(stored);
    expect(await gate.isApiKeyAccessAllowed(USER)).toBe(settingsMap.apiKeyAccess.defaultValue === 'all');
  });

  it.each(['basic', 'standalone', 'team'] as const)('admits a real %s plan independently of rate tier', async kind => {
    const plan =
      kind === 'team'
        ? plans.TEAM_PLAN
        : plans.SUBSCRIPTION_PLANS.find(row =>
            kind === 'standalone' ? row.tier === undefined : row.tier !== undefined
          );
    expect(plan?.priceId).toBeTruthy();
    if (!plan) throw new Error('Missing test plan');
    findActiveUserSubscriptions.mockResolvedValue([{ priceId: plan.priceId }]);
    expect(await gate.isApiKeyAccessAllowed(USER)).toBe(true);
    const { ladderRateTier } = await import('./userRateTier');
    expect(ladderRateTier([{ priceId: plan.priceId }])).toBe(
      kind === 'standalone' ? 'free' : kind === 'team' ? 'pro' : 'basic'
    );
    expect(findActiveUserSubscriptions).toHaveBeenCalledWith(USER.id);
  });

  it.each(['basic', 'standalone', 'team'] as const)('disables access even for a real %s subscriber', async kind => {
    const plan =
      kind === 'team'
        ? plans.TEAM_PLAN
        : plans.SUBSCRIPTION_PLANS.find(row =>
            kind === 'standalone' ? row.tier === undefined : row.tier !== undefined
          );
    if (!plan?.priceId) throw new Error('Missing test plan');
    setMode('disabled');
    findActiveUserSubscriptions.mockResolvedValue([{ priceId: plan.priceId }]);

    expect(await gate.isApiKeyAccessAllowed(USER)).toBe(false);
    expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
    expect(findPlanHolderOrgIds).not.toHaveBeenCalled();
  });

  it('admits a credit buyer with no subscription without reading subscriptions', async () => {
    expect(await gate.isApiKeyAccessAllowed(CREDIT_BUYER)).toBe(true);
    expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
  });

  it('does not treat a null purchase date as a purchase', async () => {
    expect(await gate.isApiKeyAccessAllowed({ ...USER, lastCreditsPurchasedAt: null })).toBe(false);
  });

  it('refuses a credit buyer when the switch is disabled', async () => {
    setMode('disabled');
    expect(await gate.isApiKeyAccessAllowed(CREDIT_BUYER)).toBe(false);
  });

  it.each(['', 'price_unknown', '__proto__', 'constructor', 'toString'])(
    'does not treat unresolved price %s as paid',
    async priceId => {
      findActiveUserSubscriptions.mockResolvedValue([{ priceId }]);
      expect(await gate.isApiKeyAccessAllowed(USER)).toBe(false);
    }
  );

  it('admits an org seat using the real Team price', async () => {
    findPlanHolderOrgIds.mockResolvedValue(['org-1']);
    findActiveSubscriptionsByOwners.mockResolvedValue([{ priceId: plans.TEAM_PLAN.priceId }]);
    expect(await gate.isApiKeyAccessAllowed(USER)).toBe(true);
    expect(findPlanHolderOrgIds).toHaveBeenCalledWith(USER.id);
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', ['org-1']);
  });

  it('admits an org-billed key backed by a real standalone plan', async () => {
    const standalone = plans.SUBSCRIPTION_PLANS.find(plan => plan.tier === undefined);
    expect(standalone?.priceId).toBeTruthy();
    findActiveSubscriptionsByOwners.mockResolvedValue([{ priceId: standalone?.priceId }]);
    expect(await gate.isApiKeyAccessAllowed(USER, ORG_BILLING)).toBe(true);
    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', ['org-1']);
  });

  it('denies org-billed keys when no paying plan exists', async () => {
    expect(await gate.isApiKeyAccessAllowed(USER, ORG_BILLING)).toBe(false);
  });

  it('never admits an org-billed key under disabled', async () => {
    setMode('disabled');
    findActiveSubscriptionsByOwners.mockResolvedValue([{ priceId: plans.TEAM_PLAN.priceId }]);
    expect(await gate.isApiKeyAccessAllowed(USER, ORG_BILLING)).toBe(false);
    expect(findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
  });

  it('does not consult an org for a user-billed key', async () => {
    expect(await gate.isApiKeyAccessAllowed(USER, { billingOwnerType: CreditHolderType.User })).toBe(false);
    expect(findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
  });

  it('seeds the authenticated request memo for the rate limiter and entitlement gate', async () => {
    findActiveUserSubscriptions.mockResolvedValue([{ priceId: plans.PROFESSIONAL_PRICE_ID }]);
    const req: ActiveSubscriptionsRequest = {};
    expect(await gate.isApiKeyAccessAllowed(USER, undefined, req)).toBe(true);
    req.user = USER as unknown as NonNullable<ActiveSubscriptionsRequest['user']>;
    const { resolveUserRateTier } = await import('./userRateTier');
    expect(await resolveUserRateTier(USER, req)).toBe('basic');
    const { getRequestActiveSubscriptions } = await import('../entitlements/activeSubscriptions');
    expect(await getRequestActiveSubscriptions(req)).toBe(req.activeSubscriptions);
    expect(await gate.isApiKeyAccessAllowed(USER, undefined, req)).toBe(true);
    expect(findActiveUserSubscriptions).toHaveBeenCalledTimes(1);
    expect(findPlanHolderOrgIds).toHaveBeenCalledTimes(1);
  });

  it('does not reuse or overwrite a different authenticated user memo', async () => {
    const rows = [{ priceId: plans.PROFESSIONAL_PRICE_ID }] as ActiveSubscriptionsRequest['activeSubscriptions'];
    const req: ActiveSubscriptionsRequest = {
      user: { id: 'someone-else' } as unknown as NonNullable<ActiveSubscriptionsRequest['user']>,
      activeSubscriptions: rows,
      activeSubscriptionsStrict: true,
    };
    expect(await gate.isApiKeyAccessAllowed(USER, undefined, req)).toBe(false);
    expect(req.activeSubscriptions).toBe(rows);
  });

  it('does not trust a possibly degraded request memo for authorization', async () => {
    const req: ActiveSubscriptionsRequest = {
      user: USER as unknown as NonNullable<ActiveSubscriptionsRequest['user']>,
      activeSubscriptions: [],
    };
    findPlanHolderOrgIds.mockRejectedValue(new Error('org lookup down'));
    await expect(gate.isApiKeyAccessAllowed(USER, undefined, req)).rejects.toThrow('org lookup down');
    expect(req.activeSubscriptionsStrict).toBeUndefined();
  });

  describe('settings TTL', () => {
    it('reuses the fresh setting and applies a flip at the 30-second expiry', async () => {
      setMode('all');
      expect(await gate.isApiKeyAccessAllowed(USER)).toBe(true);
      setMode('disabled');
      vi.advanceTimersByTime(29_999);
      expect(await gate.isApiKeyAccessAllowed(USER)).toBe(true);
      expect(getSettingsMapMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(await gate.isApiKeyAccessAllowed(USER)).toBe(false);
      expect(getSettingsMapMock).toHaveBeenCalledTimes(2);
      expect(getSettingsMapMock).toHaveBeenLastCalledWith(expect.anything(), {
        skipCache: true,
        names: ['apiKeyAccess'],
      });
    });

    it('allows an explicit cache clear to apply the next setting without waiting for expiry', async () => {
      setMode('all');
      expect(await gate.isApiKeyAccessAllowed(USER)).toBe(true);
      setMode('disabled');
      gate.clearApiKeyAccessModeCache();
      expect(await gate.isApiKeyAccessAllowed(USER)).toBe(false);
      expect(getSettingsMapMock).toHaveBeenCalledTimes(2);
    });

    it('fails closed after expiry and retries a failed refresh', async () => {
      setMode('all');
      expect(await gate.isApiKeyAccessAllowed(USER)).toBe(true);
      getSettingsMapMock.mockRejectedValueOnce(new Error('settings down'));
      vi.advanceTimersByTime(30_000);
      await expect(gate.isApiKeyAccessAllowed(USER)).rejects.toThrow('settings down');
      setMode('disabled');
      expect(await gate.isApiKeyAccessAllowed(USER)).toBe(false);
      expect(getSettingsMapMock).toHaveBeenCalledTimes(3);
    });

    it('shares an in-flight settings refresh between concurrent callers', async () => {
      const pending = Promise.withResolvers<Record<string, string>>();
      getSettingsMapMock.mockReturnValue(pending.promise);
      const first = gate.isApiKeyAccessAllowed(USER);
      const second = gate.isApiKeyAccessAllowed(USER);
      expect(getSettingsMapMock).toHaveBeenCalledTimes(1);
      pending.resolve({ apiKeyAccess: 'all' });
      expect(await Promise.all([first, second])).toEqual([true, true]);
    });
  });

  describe('read failures', () => {
    it('propagates a settings failure', async () => {
      getSettingsMapMock.mockRejectedValue(new Error('settings down'));
      await expect(gate.isApiKeyAccessAllowed(USER)).rejects.toThrow('settings down');
    });
    it('propagates user subscription failures', async () => {
      findActiveUserSubscriptions.mockRejectedValue(new Error('subscriptions down'));
      await expect(gate.isApiKeyAccessAllowed(USER)).rejects.toThrow('subscriptions down');
    });
    it('propagates org lookup failures', async () => {
      findPlanHolderOrgIds.mockRejectedValue(new Error('org lookup down'));
      await expect(gate.isApiKeyAccessAllowed(USER)).rejects.toThrow('org lookup down');
    });
    it('propagates org seat subscription failures', async () => {
      findPlanHolderOrgIds.mockResolvedValue(['org-1']);
      findActiveSubscriptionsByOwners.mockRejectedValue(new Error('org subscriptions down'));
      await expect(gate.isApiKeyAccessAllowed(USER)).rejects.toThrow('org subscriptions down');
    });
    it('propagates billing org subscription failures', async () => {
      findActiveSubscriptionsByOwners.mockRejectedValue(new Error('billing org down'));
      await expect(gate.isApiKeyAccessAllowed(USER, ORG_BILLING)).rejects.toThrow('billing org down');
    });
  });
});

describe('federated exchange keys', () => {
  const EXCHANGE = { oauthExchangeClientId: 'client-1' };
  const clientRow = (doc: Record<string, unknown> | undefined) =>
    findByClientIds.mockResolvedValue(new Map(doc ? [['client-1', doc]] : []));

  it.each([
    ['unset', {}, true],
    ['true', { unpaidAccountsAllowed: true }, true],
    ['false', { unpaidAccountsAllowed: false }, false],
  ])('paid mode, unpaid owner, flag %s -> %s', async (_label, doc, allowed) => {
    clientRow({ clientId: 'client-1', ...doc });
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(allowed);
    expect(findByClientIds).toHaveBeenCalledWith(['client-1']);
  });

  it('refuses a missing client and ignores isActive and federatedIdp', async () => {
    clientRow(undefined);
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(false);
    clientRow({ clientId: 'client-1', isActive: false });
    gate.clearExchangeClientAdmitsCache();
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(true);
  });

  it('never looks the client up for a paid owner, so a failing lookup cannot affect them', async () => {
    findByClientIds.mockRejectedValue(new Error('db down'));
    expect(await gate.isApiKeyAccessAllowed(CREDIT_BUYER, EXCHANGE)).toBe(true);
    findActiveUserSubscriptions.mockResolvedValue([{ priceId: plans.TEAM_PLAN.priceId }]);
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(true);
    expect(findByClientIds).not.toHaveBeenCalled();
  });

  it('propagates a lookup failure for an unpaid owner and re-queries on the next call', async () => {
    findByClientIds.mockRejectedValueOnce(new Error('db down'));
    await expect(gate.isApiKeyAccessAllowed(USER, EXCHANGE)).rejects.toThrow('db down');
    clientRow({ clientId: 'client-1' });
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(true);
    expect(findByClientIds).toHaveBeenCalledTimes(2);
  });

  it('caches per client for 30 seconds and shares one in-flight lookup', async () => {
    clientRow({ clientId: 'client-1' });
    await Promise.all([
      gate.isApiKeyAccessAllowed(USER, EXCHANGE),
      gate.isApiKeyAccessAllowed(USER, EXCHANGE),
      gate.isApiKeyAccessAllowed(USER, EXCHANGE),
    ]);
    expect(findByClientIds).toHaveBeenCalledTimes(1);
    await gate.isApiKeyAccessAllowed(USER, EXCHANGE);
    expect(findByClientIds).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    clientRow({ clientId: 'client-1', unpaidAccountsAllowed: false });
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(false);
    expect(findByClientIds).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by client, so one client never answers for another', async () => {
    const rows: Record<string, Record<string, unknown>> = {
      'client-1': { clientId: 'client-1', unpaidAccountsAllowed: false },
      'client-2': { clientId: 'client-2' },
    };
    findByClientIds.mockImplementation(async (ids: string[]) => new Map(ids.map(id => [id, rows[id]])));
    const OTHER = { oauthExchangeClientId: 'client-2' };
    expect(await gate.isApiKeyAccessAllowed(USER, OTHER)).toBe(true);
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(false);
    expect(await gate.isApiKeyAccessAllowed(USER, OTHER)).toBe(true);
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(false);
    expect(findByClientIds).toHaveBeenCalledTimes(2);
  });

  it('still refuses under disabled and never consults the client', async () => {
    setMode('disabled');
    clientRow({ clientId: 'client-1' });
    expect(await gate.isApiKeyAccessAllowed(USER, EXCHANGE)).toBe(false);
    expect(findByClientIds).not.toHaveBeenCalled();
  });

  it('leaves a key without the marker paid-only and skips the lookup', async () => {
    clientRow({ clientId: 'client-1' });
    expect(await gate.isApiKeyAccessAllowed(USER, {})).toBe(false);
    expect(await gate.isApiKeyAccessAllowed(USER)).toBe(false);
    expect(findByClientIds).not.toHaveBeenCalled();
  });
});

describe('describeApiKeyAccess', () => {
  it.each(['all', 'paid', 'disabled'] as const)('reports the %s mode with an admin bypass', async mode => {
    setMode(mode);
    expect(await gate.describeApiKeyAccess(ADMIN)).toEqual({ mode, allowed: true, basis: 'admin' });
    expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
  });

  it('reports a developer bypass', async () => {
    expect(await gate.describeApiKeyAccess({ ...USER, tags: ['developer'] })).toEqual({
      mode: 'paid',
      allowed: true,
      basis: 'developer',
    });
  });

  it('reports open access without a subscription lookup', async () => {
    setMode('all');
    expect(await gate.describeApiKeyAccess(USER)).toEqual({ mode: 'all', allowed: true, basis: 'open_to_all' });
    expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
  });

  it('reports a disabled switch as denying a regular user', async () => {
    setMode('disabled');
    expect(await gate.describeApiKeyAccess(USER)).toEqual({ mode: 'disabled', allowed: false, basis: 'disabled' });
  });

  it('reports paid mode by whether the user holds a paid subscription', async () => {
    expect(await gate.describeApiKeyAccess(USER)).toEqual({
      mode: 'paid',
      allowed: false,
      basis: 'no_paid_subscription',
    });
    findActiveUserSubscriptions.mockResolvedValue([{ priceId: plans.PROFESSIONAL_PRICE_ID }]);
    expect(await gate.describeApiKeyAccess(USER)).toEqual({ mode: 'paid', allowed: true, basis: 'paid_subscription' });
  });

  it('reports a credit buyer as allowed by the purchase', async () => {
    expect(await gate.describeApiKeyAccess(CREDIT_BUYER)).toEqual({
      mode: 'paid',
      allowed: true,
      basis: 'credit_purchase',
    });
  });

  it('agrees with isApiKeyAccessAllowed for a billing-less key', async () => {
    for (const mode of ['all', 'paid', 'disabled']) {
      setMode(mode);
      gate.clearApiKeyAccessModeCache();
      for (const user of [USER, CREDIT_BUYER]) {
        const described = await gate.describeApiKeyAccess(user);
        expect(described.allowed).toBe(await gate.isApiKeyAccessAllowed(user));
      }
    }
  });
});

describe('assertApiKeyAccessAllowed', () => {
  it('throws ForbiddenError with the subscription message on denial', async () => {
    const error = await gate.assertApiKeyAccessAllowed(USER).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toBe(gate.API_KEY_ACCESS_DENIED_MESSAGE);
  });
  it('resolves for a paying subscriber', async () => {
    findActiveUserSubscriptions.mockResolvedValue([{ priceId: plans.PROFESSIONAL_PRICE_ID }]);
    await expect(gate.assertApiKeyAccessAllowed(USER)).resolves.toBeUndefined();
  });
});

describe('assertCliSessionAllowed', () => {
  it('refuses a device-flow CLI session the setting denies', async () => {
    findBySidMock.mockResolvedValue({ createdVia: 'device', clientId: 'b4m-cli' });
    const error = await gate.assertCliSessionAllowed(USER, 'sid-1').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toBe(gate.CLI_ACCESS_DENIED_MESSAGE);
    expect(findBySidMock).toHaveBeenCalledWith('sid-1');
  });

  it('admits a device-flow CLI session for a credit buyer', async () => {
    findBySidMock.mockResolvedValue({ createdVia: 'device', clientId: 'b4m-cli' });
    await expect(gate.assertCliSessionAllowed(CREDIT_BUYER, 'sid-1')).resolves.toBeUndefined();
    await expect(
      gate.assertCliSessionAllowed(CREDIT_BUYER, undefined, { requireApiAccess: true })
    ).resolves.toBeUndefined();
  });

  it.each(OAUTH_DEVICE_CLIENT_IDS)('refuses a session identified only by known client %s', async clientId => {
    findBySidMock.mockResolvedValue({ createdVia: 'legacy-migration', clientId });
    await expect(gate.assertCliSessionAllowed(USER, 'sid-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('leaves browser sessions alone without reading settings or subscriptions', async () => {
    setMode('disabled');
    findBySidMock.mockResolvedValue({ createdVia: 'otc', clientId: null });
    await expect(gate.assertCliSessionAllowed(USER, 'sid-1')).resolves.toBeUndefined();
    expect(getSettingsMapMock).not.toHaveBeenCalled();
    expect(findActiveUserSubscriptions).not.toHaveBeenCalled();
  });

  it.each(['basic', 'standalone'] as const)('admits a CLI session with the real %s plan', async kind => {
    const plan = plans.SUBSCRIPTION_PLANS.find(row =>
      kind === 'standalone' ? row.tier === undefined : row.tier !== undefined
    );
    if (!plan?.priceId) throw new Error('Missing test plan');
    findBySidMock.mockResolvedValue({ createdVia: 'device', clientId: 'b4m-cli' });
    findActiveUserSubscriptions.mockResolvedValue([{ priceId: plan.priceId }]);
    await expect(gate.assertCliSessionAllowed(USER, 'sid-1')).resolves.toBeUndefined();
  });

  it('admits every CLI session under all', async () => {
    setMode('all');
    findBySidMock.mockResolvedValue({ createdVia: 'device', clientId: 'b4m-cli' });
    await expect(gate.assertCliSessionAllowed(USER, 'sid-1')).resolves.toBeUndefined();
  });

  it('preserves admin and developer bypass on dedicated CLI surfaces', async () => {
    setMode('disabled');
    await gate.assertCliSessionAllowed(ADMIN, 'sid-1', { requireApiAccess: true });
    await gate.assertCliSessionAllowed({ ...USER, tags: ['developer'] }, 'sid-1', { requireApiAccess: true });
    expect(findBySidMock).not.toHaveBeenCalled();
    expect(getSettingsMapMock).not.toHaveBeenCalled();
  });

  it('leaves legacy sidless browser sessions alone', async () => {
    await gate.assertCliSessionAllowed(USER, undefined);
    expect(findBySidMock).not.toHaveBeenCalled();
    expect(getSettingsMapMock).not.toHaveBeenCalled();
  });

  it('rejects a missing session instead of treating it as a browser session', async () => {
    findBySidMock.mockResolvedValue(null);
    await expect(gate.assertCliSessionAllowed(USER, 'missing-sid')).rejects.toMatchObject({
      statusCode: 401,
      message: 'Session expired',
    });
    expect(getSettingsMapMock).not.toHaveBeenCalled();
  });

  it('propagates session lookup failures rather than allowing or denying as unpaid', async () => {
    const failure = new Error('session lookup down');
    findBySidMock.mockRejectedValue(failure);
    await expect(gate.assertCliSessionAllowed(USER, 'sid-1')).rejects.toBe(failure);
    expect(getSettingsMapMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'browser-sid'])(
    'enforces dedicated API policy for token sid=%s without a session lookup',
    async sid => {
      findBySidMock.mockResolvedValue({ createdVia: 'otc', clientId: null });
      await expect(gate.assertCliSessionAllowed(USER, sid, { requireApiAccess: true })).rejects.toBeInstanceOf(
        ForbiddenError
      );
      expect(findBySidMock).not.toHaveBeenCalled();
      expect(findActiveUserSubscriptions).toHaveBeenCalledWith(USER.id);
    }
  );

  it('propagates strict org subscription failures for a CLI session', async () => {
    findBySidMock.mockResolvedValue({ createdVia: 'device', clientId: 'b4m-cli' });
    findPlanHolderOrgIds.mockRejectedValue(new Error('org lookup down'));
    await expect(gate.assertCliSessionAllowed(USER, 'sid-1')).rejects.toThrow('org lookup down');
  });
});
