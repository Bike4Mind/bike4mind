import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settingValue: true as unknown,
  getSettingsMap: vi.fn(),
  getActiveSubscriptionsForUser: vi.fn(),
  holdsPaidStanding: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: h.getSettingsMap,
  getSettingsValue: () => h.settingValue,
}));
vi.mock('@bike4mind/server-utils/entitlements/activeSubscriptions', () => ({
  getActiveSubscriptionsForUser: h.getActiveSubscriptionsForUser,
}));
vi.mock('@bike4mind/server-utils/entitlements/paidStanding', () => ({ holdsPaidStanding: h.holdsPaidStanding }));

import { canCreateSpace } from './creationGate';

const user = (over: Record<string, unknown> = {}) => ({ id: 'u1', emailVerified: true, ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.settingValue = true;
  h.getSettingsMap.mockResolvedValue({});
  h.getActiveSubscriptionsForUser.mockResolvedValue([]);
  h.holdsPaidStanding.mockReturnValue(false);
});

describe('canCreateSpace', () => {
  it('refuses an unverified email even for an admin', async () => {
    expect(await canCreateSpace(user({ emailVerified: false, isAdmin: true }))).toBe(false);
    expect(h.getSettingsMap).not.toHaveBeenCalled();
  });

  it('admits admins without reading settings', async () => {
    expect(await canCreateSpace(user({ isAdmin: true }))).toBe(true);
    expect(h.getSettingsMap).not.toHaveBeenCalled();
  });

  it('admits everyone while the setting is off', async () => {
    h.settingValue = false;
    expect(await canCreateSpace(user())).toBe(true);
    expect(h.getActiveSubscriptionsForUser).not.toHaveBeenCalled();
  });

  it('with the setting on, admits paid standing and refuses the rest', async () => {
    expect(await canCreateSpace(user())).toBe(false);
    expect(h.getActiveSubscriptionsForUser).toHaveBeenCalledWith('u1', { strict: true });
    h.holdsPaidStanding.mockReturnValue(true);
    expect(await canCreateSpace(user())).toBe(true);
  });

  it('fails closed when the subscription read throws', async () => {
    h.getActiveSubscriptionsForUser.mockRejectedValue(new Error('db down'));
    await expect(canCreateSpace(user())).rejects.toThrow('db down');
  });
});
