import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CreditHolderType, ForbiddenError, OAUTH_DEVICE_CLIENT_IDS, settingsMap } from '@bike4mind/common';
import type { ActiveSubscriptionsRequest } from '@server/entitlements/activeSubscriptions';

const { getSettingsMapMock, findActiveUserSubscriptions, findActiveSubscriptionsByOwners, findPlanHolderOrgIds } =
  vi.hoisted(() => {
    return {
      getSettingsMapMock: vi.fn<(...args: unknown[]) => Promise<Record<string, string>>>(),
      findActiveUserSubscriptions: vi.fn(),
      findActiveSubscriptionsByOwners: vi.fn(),
      findPlanHolderOrgIds: vi.fn(),
    };
  });

vi.unmock('@server/utils/apiKeyAccessGate');
const { findBySidMock } = vi.hoisted(() => ({ findBySidMock: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  authSessionRepository: { findBySid: findBySidMock },
  organizationRepository: { findPlanHolderOrgIds },
}));
vi.mock('@bike4mind/utils', async () => {
  const { getSettingsValue } = await import('../../../../b4m-core/utils/src/settings');
  return { getSettingsMap: getSettingsMapMock, getSettingsValue };
});
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findActiveUserSubscriptions, findActiveSubscriptionsByOwners },
}));

const USER = { id: 'user-1', isAdmin: false, tags: [] };
const ADMIN = { id: 'admin-1', isAdmin: true, tags: [] };
const ORG_BILLING = { billingOwnerType: CreditHolderType.Organization, organizationId: 'org-1' };
const setMode = (mode: string | undefined) =>
  getSettingsMapMock.mockResolvedValue(mode === undefined ? {} : { apiKeyAccess: mode });

let gate: typeof import('@server/utils/apiKeyAccessGate');
let plans: typeof import('@client/lib/userSubscriptions/constants');

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  setMode('paid');
  findActiveUserSubscriptions.mockResolvedValue([]);
  findPlanHolderOrgIds.mockResolvedValue([]);
  findActiveSubscriptionsByOwners.mockResolvedValue([]);
  gate = await import('@server/utils/apiKeyAccessGate');
  plans = await import('@client/lib/userSubscriptions/constants');
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
    req.user = USER as Express.User;
    const { resolveUserRateTier } = await import('./userRateTier');
    expect(await resolveUserRateTier(USER, req)).toBe('basic');
    const { getRequestActiveSubscriptions } = await import('@server/entitlements/activeSubscriptions');
    expect(await getRequestActiveSubscriptions(req)).toBe(req.activeSubscriptions);
    expect(await gate.isApiKeyAccessAllowed(USER, undefined, req)).toBe(true);
    expect(findActiveUserSubscriptions).toHaveBeenCalledTimes(1);
    expect(findPlanHolderOrgIds).toHaveBeenCalledTimes(1);
  });

  it('does not reuse or overwrite a different authenticated user memo', async () => {
    const rows = [{ priceId: plans.PROFESSIONAL_PRICE_ID }] as ActiveSubscriptionsRequest['activeSubscriptions'];
    const req: ActiveSubscriptionsRequest = {
      user: { id: 'someone-else' } as Express.User,
      activeSubscriptions: rows,
      activeSubscriptionsStrict: true,
    };
    expect(await gate.isApiKeyAccessAllowed(USER, undefined, req)).toBe(false);
    expect(req.activeSubscriptions).toBe(rows);
  });

  it('does not trust a possibly degraded request memo for authorization', async () => {
    const req: ActiveSubscriptionsRequest = { user: USER as Express.User, activeSubscriptions: [] };
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

  it('agrees with isApiKeyAccessAllowed for a billing-less key', async () => {
    for (const mode of ['all', 'paid', 'disabled']) {
      setMode(mode);
      gate.clearApiKeyAccessModeCache();
      const described = await gate.describeApiKeyAccess(USER);
      expect(described.allowed).toBe(await gate.isApiKeyAccessAllowed(USER));
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
