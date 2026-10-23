import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

const { getActiveSubscriptionsForUser, getRequestActiveSubscriptions, settingsMap } = vi.hoisted(() => ({
  getActiveSubscriptionsForUser: vi.fn(),
  getRequestActiveSubscriptions: vi.fn(),
  settingsMap: vi.fn(),
}));

vi.mock('@server/entitlements/activeSubscriptions', () => ({
  getActiveSubscriptionsForUser,
  getRequestActiveSubscriptions,
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: settingsMap,
}));

import { applyUntrustedRateLimit, resolveApiKeyTrust } from './apiKeyTrust';
import type { ActiveSubscriptionsRequest } from '@server/entitlements/activeSubscriptions';

// Only handed through to the mocked reader, so an opaque stand-in is enough.
const request = {} as ActiveSubscriptionsRequest;

const DAY_MS = 24 * 60 * 60 * 1000;
const youngVerified = {
  id: 'user-1',
  isAdmin: false,
  emailVerified: true,
  apiKeyTrustApproved: false,
  lastCreditsPurchasedAt: null,
  createdAt: new Date(Date.now() - DAY_MS),
};
const oldVerified = { ...youngVerified, createdAt: new Date(Date.now() - 30 * DAY_MS) };
const keyLimit = { requestsPerMinute: 60, requestsPerDay: 1000 };

describe('resolveApiKeyTrust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMap.mockResolvedValue({});
    getActiveSubscriptionsForUser.mockResolvedValue([]);
  });

  it('judges against the admin settings, falling back to their defaults', async () => {
    const { settings, assessment } = await resolveApiKeyTrust(youngVerified);
    expect(settings).toEqual({
      gateEnabled: true,
      minAccountAgeDays: 7,
      maxActiveKeysUntrusted: 1,
      untrustedRateLimitPerMinute: 20,
    });
    expect(assessment).toMatchObject({ status: 'untrusted', reason: 'not_yet_trusted' });
  });

  it('treats any active subscription, own or an org seat, as paid', async () => {
    getActiveSubscriptionsForUser.mockResolvedValue([{ priceId: 'price_x' }]);
    const { assessment } = await resolveApiKeyTrust(youngVerified);
    expect(getActiveSubscriptionsForUser).toHaveBeenCalledWith('user-1');
    expect(assessment).toEqual({ status: 'trusted' });
  });

  it('reads subscriptions through the request memo when given a request', async () => {
    getRequestActiveSubscriptions.mockResolvedValue([{ priceId: 'price_x' }]);
    const { assessment } = await resolveApiKeyTrust(youngVerified, request);
    expect(getRequestActiveSubscriptions).toHaveBeenCalledWith(request);
    expect(getActiveSubscriptionsForUser).not.toHaveBeenCalled();
    expect(assessment).toEqual({ status: 'trusted' });
  });

  it('propagates a failed subscription read instead of guessing', async () => {
    getRequestActiveSubscriptions.mockRejectedValue(new Error('db down'));
    await expect(resolveApiKeyTrust(youngVerified, request)).rejects.toThrow('db down');
  });

  it('restores current behavior when the gate is switched off', async () => {
    settingsMap.mockResolvedValue({ apiKeyTrustGateEnabled: 'false' });
    const { assessment } = await resolveApiKeyTrust({ ...youngVerified, emailVerified: false });
    expect(assessment).toEqual({ status: 'trusted' });
  });
});

describe('applyUntrustedRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMap.mockResolvedValue({});
    getActiveSubscriptionsForUser.mockResolvedValue([]);
  });

  it("clamps an untrusted owner's personal key to the untrusted per-minute ceiling", async () => {
    const limit = await applyUntrustedRateLimit(youngVerified, {
      rateLimit: keyLimit,
      billingOwnerType: CreditHolderType.User,
    });
    expect(limit).toEqual({ requestsPerMinute: 20, requestsPerDay: 1000 });
  });

  it("keeps a key's own lower limit", async () => {
    const limit = await applyUntrustedRateLimit(youngVerified, {
      rateLimit: { requestsPerMinute: 5, requestsPerDay: 1000 },
    });
    expect(limit.requestsPerMinute).toBe(5);
  });

  it('leaves a trusted owner untouched', async () => {
    expect(await applyUntrustedRateLimit(oldVerified, { rateLimit: keyLimit })).toBe(keyLimit);
  });

  it('leaves org-billed keys untouched without assessing the owner', async () => {
    const limit = await applyUntrustedRateLimit(youngVerified, {
      rateLimit: keyLimit,
      billingOwnerType: CreditHolderType.Organization,
    });
    expect(limit).toBe(keyLimit);
    expect(settingsMap).not.toHaveBeenCalled();
  });
});
