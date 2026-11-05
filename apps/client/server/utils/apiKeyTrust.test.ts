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

import { applyUntrustedRateLimit, resolveApiKeyTrust, resolveUntrustedKeyLimits } from './apiKeyTrust';
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
      accountAgeTrustsKeys: true,
      maxActiveKeysUntrusted: 1,
      untrustedRateLimitPerMinute: 20,
      untrustedRequestsPerDay: 0,
      untrustedTokensPerMinute: 0,
      untrustedMaxConcurrent: 0,
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

  it('keeps an old free account untrusted when account age does not lift key limits', async () => {
    settingsMap.mockResolvedValue({ apiKeyAccountAgeTrustsKeys: 'false' });
    const { assessment } = await resolveApiKeyTrust(oldVerified);
    expect(assessment).toEqual({ status: 'untrusted', reason: 'paid_standing_required', maxActiveKeys: 1 });
  });

  it('counts account age anyway when the caller asks to honor it', async () => {
    settingsMap.mockResolvedValue({ apiKeyAccountAgeTrustsKeys: 'false' });
    const { assessment } = await resolveApiKeyTrust(oldVerified, undefined, { honorAccountAge: true });
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

  it('also clamps the per-day ceiling when the untrusted daily limit is on', async () => {
    settingsMap.mockResolvedValue({ apiKeyUntrustedRequestsPerDay: '200' });
    const limit = await applyUntrustedRateLimit(youngVerified, { rateLimit: keyLimit });
    expect(limit).toEqual({ requestsPerMinute: 20, requestsPerDay: 200 });
  });

  it("keeps a key's own lower daily limit", async () => {
    settingsMap.mockResolvedValue({ apiKeyUntrustedRequestsPerDay: '5000' });
    const limit = await applyUntrustedRateLimit(youngVerified, { rateLimit: keyLimit });
    expect(limit.requestsPerDay).toBe(1000);
  });

  it('leaves a trusted owner untouched when the untrusted daily limit is on', async () => {
    settingsMap.mockResolvedValue({ apiKeyUntrustedRequestsPerDay: '200' });
    expect(await applyUntrustedRateLimit(oldVerified, { rateLimit: keyLimit })).toBe(keyLimit);
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

  it('clamps an old free owner when account age does not lift key limits', async () => {
    settingsMap.mockResolvedValue({ apiKeyAccountAgeTrustsKeys: 'false', apiKeyUntrustedRequestsPerDay: '200' });
    const limit = await applyUntrustedRateLimit(oldVerified, { rateLimit: keyLimit });
    expect(limit).toEqual({ requestsPerMinute: 20, requestsPerDay: 200 });
  });

  it('flags an old free owner as untrusted for the completion quotas when account age does not lift key limits', async () => {
    settingsMap.mockResolvedValue({ apiKeyAccountAgeTrustsKeys: 'false' });
    const { ownerUntrusted } = await resolveUntrustedKeyLimits(oldVerified, { rateLimit: keyLimit });
    expect(ownerUntrusted).toBe(true);
  });

  it('leaves org-billed keys untouched without assessing the owner', async () => {
    const limit = await applyUntrustedRateLimit(youngVerified, {
      rateLimit: keyLimit,
      billingOwnerType: CreditHolderType.Organization,
    });
    expect(limit).toBe(keyLimit);
    expect(settingsMap).not.toHaveBeenCalled();
  });

  it('leaves a system-owned key untouched without assessing the owner, even with the daily limit on', async () => {
    settingsMap.mockResolvedValue({ apiKeyUntrustedRequestsPerDay: '200' });
    // The Overwatch ingest user: unverified, no plan, never an admin, so it would judge untrusted.
    const systemOwner = { ...youngVerified, emailVerified: false, isSystem: true };
    const result = await resolveUntrustedKeyLimits(systemOwner, { rateLimit: keyLimit });
    expect(result).toEqual({ rateLimit: keyLimit, ownerUntrusted: false });
    expect(settingsMap).not.toHaveBeenCalled();
  });

  it('still clamps an owner whose isSystem flag is explicitly false', async () => {
    const limit = await applyUntrustedRateLimit({ ...youngVerified, isSystem: false }, { rateLimit: keyLimit });
    expect(limit.requestsPerMinute).toBe(20);
  });
});
