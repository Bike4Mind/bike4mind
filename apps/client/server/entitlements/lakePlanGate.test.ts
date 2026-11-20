import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_LAKE_PLAN_REQUIRED_CODE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  settingValue: false as unknown,
  subscriptions: [] as { priceId: string }[],
  payingOrg: false,
  getSettingsMap: vi.fn(),
  getRequestActiveSubscriptions: vi.fn(),
  isPayingOrganization: vi.fn(),
  holdsPaidStanding: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: h.getSettingsMap,
  getSettingsValue: () => h.settingValue,
}));
vi.mock('@bike4mind/server-utils/entitlements/activeSubscriptions', () => ({
  getRequestActiveSubscriptions: h.getRequestActiveSubscriptions,
}));
vi.mock('@server/entitlements/orgPaidStanding', () => ({ isPayingOrganization: h.isPayingOrganization }));
vi.mock('@bike4mind/server-utils/entitlements/paidStanding', () => ({ holdsPaidStanding: h.holdsPaidStanding }));

import { assertLakePlanAllowed, clearLakePlanGateCache, isLakePlanAllowed } from './lakePlanGate';

const req = (user: Partial<{ isAdmin: boolean; tags: string[] }> = {}) =>
  ({ user: { id: 'u1', ...user } }) as unknown as Parameters<typeof isLakePlanAllowed>[0];

beforeEach(() => {
  vi.clearAllMocks();
  clearLakePlanGateCache();
  h.settingValue = false;
  h.getSettingsMap.mockResolvedValue({});
  h.getRequestActiveSubscriptions.mockResolvedValue([]);
  h.holdsPaidStanding.mockReturnValue(false);
  h.isPayingOrganization.mockResolvedValue(false);
});

describe('lake plan gate', () => {
  it('admits everyone and reads no subscriptions while the setting is off', async () => {
    await expect(assertLakePlanAllowed(req())).resolves.toBeUndefined();
    expect(h.getRequestActiveSubscriptions).not.toHaveBeenCalled();
  });

  it('refuses a caller with no paid standing once on, with a coded 403', async () => {
    h.settingValue = true;
    await expect(assertLakePlanAllowed(req())).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/paid plan.*Upgrade or buy credits/),
      additionalInfo: { code: DATA_LAKE_PLAN_REQUIRED_CODE },
    });
    expect(h.getRequestActiveSubscriptions).toHaveBeenCalledWith(expect.anything(), { strict: true });
  });

  it('admits paid standing (subscription, org seat or credit purchase) once on', async () => {
    h.settingValue = true;
    h.holdsPaidStanding.mockReturnValue(true);
    const subscriptions = [{ priceId: 'price_paid' }];
    h.getRequestActiveSubscriptions.mockResolvedValue(subscriptions);
    const request = req();
    await expect(isLakePlanAllowed(request)).resolves.toBe(true);
    expect(h.holdsPaidStanding).toHaveBeenCalledWith(request.user, subscriptions);
  });

  it('fails closed: a failed settings or subscription read rejects instead of admitting', async () => {
    h.getSettingsMap.mockRejectedValueOnce(new Error('settings down'));
    await expect(isLakePlanAllowed(req())).rejects.toThrow('settings down');

    h.settingValue = true;
    h.getRequestActiveSubscriptions.mockRejectedValueOnce(new Error('subscriptions down'));
    await expect(isLakePlanAllowed(req())).rejects.toThrow('subscriptions down');
  });

  it('reads the setting once per TTL', async () => {
    await isLakePlanAllowed(req());
    await isLakePlanAllowed(req());
    expect(h.getSettingsMap).toHaveBeenCalledTimes(1);
  });

  it('admits an org lake when the organization holds paid standing, and only for an org lake', async () => {
    h.settingValue = true;
    h.isPayingOrganization.mockResolvedValue(true);
    await expect(isLakePlanAllowed(req(), 'org1')).resolves.toBe(true);
    expect(h.isPayingOrganization).toHaveBeenCalledWith('org1');
    await expect(isLakePlanAllowed(req())).resolves.toBe(false);
  });

  it('refuses a request with no authenticated user', async () => {
    h.settingValue = true;
    await expect(isLakePlanAllowed({} as Parameters<typeof isLakePlanAllowed>[0])).resolves.toBe(false);
  });

  it('exempts admins and developers without reading the setting', async () => {
    h.settingValue = true;
    await expect(isLakePlanAllowed(req({ isAdmin: true }))).resolves.toBe(true);
    await expect(isLakePlanAllowed(req({ tags: ['developer'] }))).resolves.toBe(true);
    expect(h.getSettingsMap).not.toHaveBeenCalled();
  });
});
