import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  drip: vi.fn(),
  protection: { repository: {} },
  findById: vi.fn(),
  setting: vi.fn(),
  limits: vi.fn(),
}));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: h.protection }));
vi.mock('@bike4mind/services', () => ({ userService: { dripSignupGrant: h.drip, resolveDripLimits: h.limits } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: h.setting },
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: { findById: h.findById },
}));

import { resolveRequiredActiveSeconds, unlockSignupGrantFromActivity } from './activityUnlock';

const NOW = new Date('2030-03-01T10:00:00Z');
const grantedUser = (extra: Record<string, unknown> = {}) => ({
  id: 'user-1',
  signupGrant: { stage: 'signup', activity: { day: '2030-03-01', ms: 600_000, lastAt: NOW }, ...extra },
});
const settings = (values: Record<string, string>) =>
  h.setting.mockImplementation(async (name: string) => ({ settingValue: values[name] }));

describe('activity signup drip evaluation', () => {
  beforeEach(() => {
    h.drip.mockReset();
    h.limits.mockResolvedValue({ dailyCredits: 1000, maxCredits: 9000 });
    settings({ signupGrantActivityEnabled: 'true' });
  });

  it('drips for the current UTC day with the shared domain protection when the active time qualifies', async () => {
    h.findById.mockResolvedValue(grantedUser());
    h.drip.mockResolvedValue({ creditsGranted: 1000, currentCredits: 1 });
    await unlockSignupGrantFromActivity('user-1', NOW);
    expect(h.drip).toHaveBeenCalledWith('user-1', '2030-03-01', expect.anything());
    expect(h.drip.mock.calls[0][2].db.signupProtection).toBe(h.protection);
  });

  it.each([
    ['below the active-time minimum', grantedUser({ activity: { day: '2030-03-01', ms: 59_000, lastAt: NOW } })],
    [
      'the accrued time is from another day',
      grantedUser({ activity: { day: '2030-02-28', ms: 900_000, lastAt: NOW } }),
    ],
    ['no time was accrued', grantedUser({ activity: undefined })],
    ['the day was already dripped', grantedUser({ lastDripDay: '2030-03-01' })],
    ['the signup tranche is unpaid', grantedUser({ stage: 'pending_email' })],
    ['the account is unlocked', grantedUser({ stage: 'unlocked' })],
    ['the drip is capped', grantedUser({ dripCredits: 9000 })],
  ])('does not drip when %s', async (_label, user) => {
    h.findById.mockResolvedValue(user);
    expect((await unlockSignupGrantFromActivity('user-1', NOW)).creditsGranted).toBe(0);
    expect(h.drip).not.toHaveBeenCalled();
  });

  it('does not drip when the activity flag is off', async () => {
    settings({ signupGrantActivityEnabled: 'false' });
    h.findById.mockResolvedValue(grantedUser());
    await unlockSignupGrantFromActivity('user-1', NOW);
    expect(h.drip).not.toHaveBeenCalled();
  });

  it.each([['0'], ['abc'], [undefined], ['59'], ['7201'], ['90.5']])(
    'falls back to 60 seconds for %s rather than disabling the drip',
    async value => {
      settings(value === undefined ? {} : { signupGrantActivityMinActiveSeconds: value });
      expect(await resolveRequiredActiveSeconds()).toBe(60);
    }
  );

  it('honors an in-range configured minimum', async () => {
    settings({ signupGrantActivityMinActiveSeconds: '120' });
    expect(await resolveRequiredActiveSeconds()).toBe(120);
  });
});
