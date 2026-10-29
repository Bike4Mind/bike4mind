import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';

const { validateKey, findUser, findSubscriptions, findOrganizations, settingsMap } = vi.hoisted(() => ({
  validateKey: vi.fn(),
  findUser: vi.fn(),
  findSubscriptions: vi.fn(),
  findOrganizations: vi.fn(),
  settingsMap: vi.fn(),
}));

vi.mock('@bike4mind/services', async importOriginal => {
  const services = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...services,
    userApiKeyService: { ...services.userApiKeyService, validateUserApiKey: validateKey },
  };
});
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database', () => ({
  User: { findById: findUser },
  adminSettingsRepository: {},
  organizationRepository: { findPlanHolderOrgIds: findOrganizations },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: settingsMap,
}));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveUserSubscriptions: findSubscriptions },
}));
vi.mock('@server/auth/ability', () => ({ default: () => ({}) }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/server-utils/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));

import { apiKeyAuth } from './apiKeyAuth';
import { getRequestActiveSubscriptions } from '@server/entitlements/activeSubscriptions';

// Exercise the real trust assessment and request subscription memo together.
describe('apiKeyAuth subscription trust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMap.mockResolvedValue({});
    findOrganizations.mockResolvedValue([]);
    findSubscriptions.mockResolvedValue([]);
    findUser.mockResolvedValue({
      id: 'user-1',
      emailVerified: true,
      createdAt: new Date(),
      lastCreditsPurchasedAt: null,
      isAdmin: false,
    });
    validateKey.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      billingOwnerType: CreditHolderType.User,
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
  });

  it.each([
    ['subscribed', [{ priceId: 'price_paid' }], 60],
    ['unsubscribed', [], 20],
  ])('applies the correct limit for a young verified %s owner', async (_label, subscriptions, expectedLimit) => {
    findSubscriptions.mockResolvedValue(subscriptions);
    const request = {
      headers: { 'x-api-key': 'b4m_live_0123456789abcdef0123456789abcdef' },
      method: 'GET',
      originalUrl: '/api/v1/sessions',
    } as unknown as Request;
    const response = { once: vi.fn(), statusCode: 200 } as unknown as Response;
    const next = vi.fn();

    await apiKeyAuth()(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(request.apiKeyInfo?.rateLimit.requestsPerMinute).toBe(expectedLimit);
    expect(request.apiKeyInfo?.ownerUntrusted).toBe(expectedLimit === 20);
    expect(findSubscriptions).toHaveBeenCalledWith('user-1');
    expect(await getRequestActiveSubscriptions(request)).toEqual(subscriptions);
    expect(findSubscriptions).toHaveBeenCalledOnce();
  });

  it('retains admin owner trust when the key cannot exercise the admin role', async () => {
    findUser.mockResolvedValue({
      id: 'user-1',
      emailVerified: true,
      createdAt: new Date(),
      isAdmin: true,
    });
    const request = {
      headers: { 'x-api-key': 'b4m_live_0123456789abcdef0123456789abcdef' },
      method: 'GET',
      originalUrl: '/api/v1/sessions',
    } as unknown as Request;
    const response = { once: vi.fn(), statusCode: 200 } as unknown as Response;
    const next = vi.fn();

    await apiKeyAuth()(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(request.user?.isAdmin).toBe(false);
    expect(request.apiKeyInfo?.ownerUntrusted).toBe(false);
    expect(request.apiKeyInfo?.rateLimit.requestsPerMinute).toBe(60);
  });
});
