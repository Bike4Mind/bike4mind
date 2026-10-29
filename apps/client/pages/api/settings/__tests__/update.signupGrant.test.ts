// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: Array<{ settingName: string; settingValue: unknown }> = [];
const findOneAndUpdate = vi.fn();

vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    find: () => ({ lean: () => Promise.resolve(rows) }),
    findOne: () => ({ lean: () => Promise.resolve(null) }),
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
  },
}));
vi.mock('@bike4mind/utils', () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
const recordAdminActionFromRequest = vi.fn();
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => recordAdminActionFromRequest(...args),
}));
vi.mock('@server/utils/adminSettingsAudit', () => ({ recordAdminSettingChange: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ put: (handler: (...a: unknown[]) => unknown) => handler }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/utils/publicSettingsArtifact', () => ({
  materializePublicSettingsArtifactSafe: vi.fn(() => Promise.resolve()),
}));
vi.mock('@server/utils/resolveDefaultEmbeddingModel', () => ({
  resolveDefaultEmbeddingModel: () => Promise.resolve('text-embedding-3-small'),
}));

import handler from '../update';
import { LARGE_SIGNUP_GRANT_CREDITS } from '@bike4mind/common';

const PROTECTIONS = [
  { settingName: 'signupGrantRiskPolicy', settingValue: { enabled: true } },
  { settingName: 'maxSignupsPerIpPerDay', settingValue: 5 },
  { settingName: 'maxSignupsPerAsnPerHour', settingValue: 20 },
  { settingName: 'signupBurstAutoHold', settingValue: true },
];
const LARGE = LARGE_SIGNUP_GRANT_CREDITS + 1;

const runHandler = async (key: string, value: unknown) => {
  const json = vi.fn((x: unknown) => x);
  const req = {
    user: { isAdmin: true },
    ability: { can: () => true },
    body: { key, value },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, { json });
  return json;
};

describe('settings/update large signup grant guard', () => {
  beforeEach(() => {
    rows = [];
    findOneAndUpdate.mockReset().mockImplementation(async (filter: { settingName: string }, update) => ({
      settingName: filter.settingName,
      settingValue: update.$set.settingValue,
      toObject: () => ({ settingName: filter.settingName, settingValue: update.$set.settingValue }),
    }));
    recordAdminActionFromRequest.mockReset().mockResolvedValue(null);
  });

  it.each(['defaultFreeCredits', 'signupGrantCredits', 'verifiedUnlockCredits'])(
    'refuses raising %s above the limit while protections are at their defaults',
    async key => {
      await expect(runHandler(key, LARGE)).rejects.toThrow(/signupGrantRiskPolicy/);
      expect(findOneAndUpdate).not.toHaveBeenCalled();
      expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'settings.admin_settings.denied' })
      );
    }
  );

  it('counts the stored signup grant when only the unlock grant is raised', async () => {
    rows = [{ settingName: 'signupGrantCredits', settingValue: 90 }];
    await expect(runHandler('verifiedUnlockCredits', 20)).rejects.toThrow(/Refusing to raise/);
  });

  it.each([150.5, 1e21])('refuses a flat grant of %s that is not a safe integer', async value => {
    await expect(runHandler('defaultFreeCredits', value)).rejects.toThrow(/Refusing to raise/);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('is not masked by a dormant staged total when the flat grant is raised', async () => {
    rows = [{ settingName: 'signupGrantCredits', settingValue: 500 }];
    await expect(runHandler('defaultFreeCredits', 400)).rejects.toThrow(/Refusing to raise/);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows a grant at the limit with protections off', async () => {
    await runHandler('defaultFreeCredits', LARGE_SIGNUP_GRANT_CREDITS);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('allows a large grant once every protection is on', async () => {
    rows = PROTECTIONS;
    await runHandler('defaultFreeCredits', LARGE);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('treats a policy stored as a JSON string as enabled', async () => {
    rows = PROTECTIONS.map(row =>
      row.settingName === 'signupGrantRiskPolicy' ? { ...row, settingValue: '{"enabled":true}' } : row
    );
    await runHandler('defaultFreeCredits', LARGE);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('still refuses when a single protection is left off', async () => {
    rows = PROTECTIONS.filter(row => row.settingName !== 'maxSignupsPerIpPerDay');
    await expect(runHandler('defaultFreeCredits', LARGE)).rejects.toThrow(/maxSignupsPerIpPerDay/);
  });

  it('lets an operator lower an over-limit grant while protections are off', async () => {
    rows = [{ settingName: 'defaultFreeCredits', settingValue: 500 }];
    await runHandler('defaultFreeCredits', LARGE);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
