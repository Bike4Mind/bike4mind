import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoadSettings, mockFallback, mockActiveSubscriptions, mockFindUser } = vi.hoisted(() => ({
  mockLoadSettings: vi.fn(),
  mockFallback: vi.fn(),
  mockActiveSubscriptions: vi.fn(),
  mockFindUser: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, userRepository: { findById: mockFindUser } }));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  loadThinkingVisibilitySettings: mockLoadSettings,
  fallbackThinkingVisibility: mockFallback,
}));
vi.mock('@server/entitlements/activeSubscriptions', () => ({ getActiveSubscriptionsForUser: mockActiveSubscriptions }));

import { withholdAdminRole } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { resolveThinkingVisibility, resolveThinkingVisibilityForUserId } from './thinkingVisibility';

const freeUser = () => ({ id: 'u1', isAdmin: false, apiKeyTrustApproved: false, lastCreditsPurchasedAt: undefined });

describe('resolveThinkingVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSettings.mockResolvedValue({ free: 'none', paid: 'raw' });
    mockActiveSubscriptions.mockResolvedValue([]);
  });

  it('gives an account with no paid standing the free level', async () => {
    await expect(resolveThinkingVisibility(freeUser())).resolves.toBe('none');
  });

  it('gives an active plan the paid level', async () => {
    mockActiveSubscriptions.mockResolvedValue([{ priceId: 'p1' }]);
    await expect(resolveThinkingVisibility(freeUser())).resolves.toBe('raw');
  });

  it('counts the stored admin role that an API key without the admin scope hides', async () => {
    const admin = withholdAdminRole({ ...freeUser(), isAdmin: true });
    expect(admin.isAdmin).toBe(false);
    await expect(resolveThinkingVisibility(admin)).resolves.toBe('raw');
    expect(mockActiveSubscriptions).not.toHaveBeenCalled();
  });

  it('falls back to the free level when the plan lookup fails', async () => {
    mockActiveSubscriptions.mockRejectedValue(new Error('subscriptions down'));
    await expect(resolveThinkingVisibility(freeUser())).resolves.toBe('none');
  });

  it('falls back to summary when settings cannot be read', async () => {
    mockLoadSettings.mockRejectedValue(new Error('settings down'));
    await expect(resolveThinkingVisibility(freeUser())).resolves.toBe('summary');
  });
});

describe('resolveThinkingVisibilityForUserId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSettings.mockResolvedValue({ free: 'none', paid: 'raw' });
    mockActiveSubscriptions.mockResolvedValue([]);
  });

  it('resolves the stored account', async () => {
    mockFindUser.mockResolvedValue({ ...freeUser(), lastCreditsPurchasedAt: new Date() });
    await expect(resolveThinkingVisibilityForUserId('u1')).resolves.toBe('raw');
  });

  it('uses the fallback level for an account that cannot be loaded', async () => {
    mockFindUser.mockResolvedValue(null);
    mockFallback.mockResolvedValue('summary');
    await expect(resolveThinkingVisibilityForUserId('gone')).resolves.toBe('summary');
  });
});
