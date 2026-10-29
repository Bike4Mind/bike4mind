import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  drip: vi.fn(),
  protection: { repository: {} },
  findById: vi.fn(),
  aggregate: vi.fn(),
  setting: vi.fn(),
  limits: vi.fn(),
}));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: h.protection }));
vi.mock('@bike4mind/services', () => ({ userService: { dripSignupGrant: h.drip, resolveDripLimits: h.limits } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: h.setting },
  creditLotRepository: {},
  creditTransactionRepository: {},
  Quest: { aggregate: h.aggregate },
  userRepository: { findById: h.findById },
}));

import { unlockSignupGrantFromActivity } from './activityUnlock';

const NOW = new Date('2030-03-01T10:00:00Z');
const grantedUser = (extra: Record<string, unknown> = {}) => ({
  id: 'user-1',
  createdAt: new Date('2030-01-01T00:00:00Z'),
  signupGrant: { stage: 'signup', ...extra },
});
const qualifying = (messages: number) => h.aggregate.mockReturnValue({ option: async () => [{ messages }] });

describe('activity signup drip evaluation', () => {
  beforeEach(() => {
    h.aggregate.mockClear();
    h.limits.mockResolvedValue({ dailyCredits: 1000, maxCredits: 9000 });
  });

  it('drips for the current UTC day with the shared domain protection when the day qualifies', async () => {
    h.setting.mockImplementation(async (name: string) => ({
      settingValue: { signupGrantActivityEnabled: 'true', signupGrantActivityMinMessages: '2' }[name],
    }));
    h.findById.mockResolvedValue(grantedUser());
    qualifying(2);
    h.drip.mockResolvedValue({ creditsGranted: 1000, currentCredits: 1 });
    await unlockSignupGrantFromActivity('user-1', NOW);
    expect(h.drip).toHaveBeenCalledWith('user-1', '2030-03-01', expect.anything());
    expect(h.drip.mock.calls[0][2].db.signupProtection).toBe(h.protection);
  });

  it.each([
    ['below the daily message minimum', grantedUser(), 1],
    ['the day was already dripped', grantedUser({ lastDripDay: '2030-03-01' }), 5],
    ['the signup tranche is unpaid', grantedUser({ stage: 'pending_email' }), 5],
    ['the account is unlocked', grantedUser({ stage: 'unlocked' }), 5],
    ['the drip is capped', grantedUser({ dripCredits: 9000 }), 5],
  ])('does not drip when %s', async (_label, user, messages) => {
    h.drip.mockClear();
    h.findById.mockResolvedValue(user);
    qualifying(messages);
    expect((await unlockSignupGrantFromActivity('user-1', NOW)).creditsGranted).toBe(0);
    expect(h.drip).not.toHaveBeenCalled();
    if (_label !== 'below the daily message minimum') expect(h.aggregate).not.toHaveBeenCalled();
  });
});
