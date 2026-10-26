import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CreditHolderType, ForbiddenError } from '@bike4mind/common';

const { getSettingsMapMock, resolveUserRateTierMock, findActiveSubscriptionsByOwnersMock, ladderRateTierMock } =
  vi.hoisted(() => ({
    getSettingsMapMock: vi.fn<(...args: unknown[]) => Promise<Record<string, string>>>(),
    resolveUserRateTierMock: vi.fn(),
    findActiveSubscriptionsByOwnersMock: vi.fn(),
    ladderRateTierMock: vi.fn(),
  }));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...args: unknown[]) => getSettingsMapMock(...args),
  getSettingsValue: (key: string, settings: Record<string, string>) => settings[key],
}));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwners: findActiveSubscriptionsByOwnersMock },
}));
vi.mock('@server/utils/userRateTier', () => ({
  resolveUserRateTier: resolveUserRateTierMock,
  ladderRateTier: ladderRateTierMock,
}));

import { assertApiKeyAccessAllowed, isApiKeyAccessAllowed, API_KEY_ACCESS_DENIED_MESSAGE } from './apiKeyAccessGate';

const USER = { id: 'user-1', isAdmin: false, tags: [] };
const ADMIN = { id: 'admin-1', isAdmin: true, tags: [] };

const setMode = (mode: string | undefined) =>
  getSettingsMapMock.mockResolvedValue(mode === undefined ? {} : { apiKeyAccess: mode });

describe('isApiKeyAccessAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // [mode, resolved tier, expected]
  const matrix: [string, string, boolean][] = [
    ['all', 'bypass', true],
    ['all', 'pro', true],
    ['all', 'basic', true],
    ['all', 'free', true],
    ['paid', 'bypass', true],
    ['paid', 'pro', true],
    ['paid', 'basic', true],
    ['paid', 'free', false],
    ['disabled', 'bypass', true],
    ['disabled', 'pro', false],
    ['disabled', 'basic', false],
    ['disabled', 'free', false],
  ];

  it.each(matrix)('mode=%s tier=%s -> %s', async (mode, tier, expected) => {
    setMode(mode);
    resolveUserRateTierMock.mockResolvedValue(tier);
    const user = tier === 'bypass' ? ADMIN : USER;
    expect(await isApiKeyAccessAllowed(user)).toBe(expected);
  });

  it('lets a developer-tagged user through without reading the setting', async () => {
    expect(await isApiKeyAccessAllowed({ id: 'dev-1', tags: ['developer'] })).toBe(true);
    expect(getSettingsMapMock).not.toHaveBeenCalled();
  });

  describe('default when the setting is unset', () => {
    const originalSelfHost = process.env.B4M_SELF_HOST;
    afterEach(() => {
      if (originalSelfHost === undefined) delete process.env.B4M_SELF_HOST;
      else process.env.B4M_SELF_HOST = originalSelfHost;
    });

    it('is paid on hosted: a free user is denied, a subscriber passes', async () => {
      delete process.env.B4M_SELF_HOST;
      setMode(undefined);
      resolveUserRateTierMock.mockResolvedValue('free');
      expect(await isApiKeyAccessAllowed(USER)).toBe(false);
      resolveUserRateTierMock.mockResolvedValue('pro');
      expect(await isApiKeyAccessAllowed(USER)).toBe(true);
    });

    it('is all on self-host', async () => {
      process.env.B4M_SELF_HOST = 'true';
      setMode(undefined);
      expect(await isApiKeyAccessAllowed(USER)).toBe(true);
      expect(resolveUserRateTierMock).not.toHaveBeenCalled();
    });
  });

  it('reads the setting uncached so a flip applies on the next request', async () => {
    setMode('all');
    await isApiKeyAccessAllowed(USER);
    expect(getSettingsMapMock).toHaveBeenCalledWith(expect.anything(), {
      skipCache: true,
      names: ['apiKeyAccess'],
    });
  });

  describe('org-billed keys under paid', () => {
    const orgBilling = { billingOwnerType: CreditHolderType.Organization, organizationId: 'org-1' };

    beforeEach(() => {
      setMode('paid');
      resolveUserRateTierMock.mockResolvedValue('free');
      findActiveSubscriptionsByOwnersMock.mockResolvedValue([{ priceId: 'price_pro' }]);
    });

    it('admits a free minter when the paying org holds a ladder plan', async () => {
      ladderRateTierMock.mockReturnValue('pro');
      expect(await isApiKeyAccessAllowed(USER, orgBilling)).toBe(true);
      expect(findActiveSubscriptionsByOwnersMock).toHaveBeenCalledWith('Organization', ['org-1']);
    });

    it('denies when the paying org has no ladder plan', async () => {
      ladderRateTierMock.mockReturnValue('free');
      expect(await isApiKeyAccessAllowed(USER, orgBilling)).toBe(false);
    });

    it('does not consult an org for a user-billed key', async () => {
      expect(await isApiKeyAccessAllowed(USER, { billingOwnerType: CreditHolderType.User })).toBe(false);
      expect(findActiveSubscriptionsByOwnersMock).not.toHaveBeenCalled();
    });

    it('never admits an org-billed key under disabled', async () => {
      setMode('disabled');
      ladderRateTierMock.mockReturnValue('pro');
      expect(await isApiKeyAccessAllowed(USER, orgBilling)).toBe(false);
    });
  });

  describe('read errors fail closed', () => {
    it('propagates a setting read failure instead of allowing', async () => {
      getSettingsMapMock.mockRejectedValue(new Error('db down'));
      await expect(isApiKeyAccessAllowed(USER)).rejects.toThrow('db down');
    });

    it('propagates a subscription read failure under paid instead of allowing', async () => {
      setMode('paid');
      resolveUserRateTierMock.mockRejectedValue(new Error('subs down'));
      await expect(isApiKeyAccessAllowed(USER)).rejects.toThrow('subs down');
    });
  });
});

describe('assertApiKeyAccessAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws ForbiddenError with the paid-subscription message on deny', async () => {
    setMode('paid');
    resolveUserRateTierMock.mockResolvedValue('free');
    const error = await assertApiKeyAccessAllowed(USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toBe(API_KEY_ACCESS_DENIED_MESSAGE);
  });

  it('resolves on allow', async () => {
    setMode('paid');
    resolveUserRateTierMock.mockResolvedValue('basic');
    await expect(assertApiKeyAccessAllowed(USER)).resolves.toBeUndefined();
  });
});
