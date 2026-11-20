import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateSettingsCache } from '@bike4mind/utils';
import {
  fallbackThinkingVisibility,
  loadThinkingVisibilitySettings,
  resolveAccountThinkingVisibility,
} from './thinkingVisibility';

function adminSettingsWith(rows: Record<string, string>) {
  const docs = Object.entries(rows).map(([settingName, settingValue]) => ({ settingName, settingValue }));
  return {
    adminSettings: {
      findAll: vi.fn().mockResolvedValue(docs),
      findBySettingNames: vi.fn().mockResolvedValue(docs),
    },
  } as unknown as Parameters<typeof loadThinkingVisibilitySettings>[0];
}

const freeUser = { isAdmin: false, apiKeyTrustApproved: false, lastCreditsPurchasedAt: undefined };
const noPlan = async () => false;

describe('loadThinkingVisibilitySettings', () => {
  beforeEach(() => invalidateSettingsCache());

  it('defaults to summary for free accounts and raw for paid', async () => {
    await expect(loadThinkingVisibilitySettings(adminSettingsWith({}))).resolves.toEqual({
      free: 'summary',
      paid: 'raw',
    });
  });

  it('applies an admin override per tier', async () => {
    const db = adminSettingsWith({ thinkingVisibilityFree: 'none', thinkingVisibilityPaid: 'summary' });
    await expect(loadThinkingVisibilitySettings(db)).resolves.toEqual({ free: 'none', paid: 'summary' });
  });

  it('ignores a stored value that is not a level', async () => {
    const db = adminSettingsWith({ thinkingVisibilityFree: 'everything' });
    await expect(loadThinkingVisibilitySettings(db)).resolves.toMatchObject({ free: 'summary' });
  });
});

describe('resolveAccountThinkingVisibility', () => {
  const settings = { free: 'none' as const, paid: 'raw' as const };

  it('gives an account with no purchase, plan or approval the free level', async () => {
    await expect(resolveAccountThinkingVisibility(freeUser, { settings, hasActivePlan: noPlan })).resolves.toBe('none');
  });

  it.each([
    ['a purchase', { ...freeUser, lastCreditsPurchasedAt: new Date() }],
    ['admin approval', { ...freeUser, apiKeyTrustApproved: true }],
    ['a platform admin', { ...freeUser, isAdmin: true }],
  ])('gives %s the paid level without a plan lookup', async (_label, user) => {
    const hasActivePlan = vi.fn(noPlan);
    await expect(resolveAccountThinkingVisibility(user, { settings, hasActivePlan })).resolves.toBe('raw');
    expect(hasActivePlan).not.toHaveBeenCalled();
  });

  it('gives an active plan the paid level', async () => {
    await expect(
      resolveAccountThinkingVisibility(freeUser, { settings, hasActivePlan: async () => true })
    ).resolves.toBe('raw');
  });
});

describe('fallbackThinkingVisibility', () => {
  beforeEach(() => invalidateSettingsCache());

  it('is the configured free level', async () => {
    await expect(fallbackThinkingVisibility(adminSettingsWith({ thinkingVisibilityFree: 'none' }))).resolves.toBe(
      'none'
    );
  });

  it('is summary when settings cannot be read', async () => {
    const broken = {
      adminSettings: {
        findAll: vi.fn().mockRejectedValue(new Error('settings down')),
        findBySettingNames: vi.fn().mockRejectedValue(new Error('settings down')),
      },
    } as unknown as Parameters<typeof fallbackThinkingVisibility>[0];
    await expect(fallbackThinkingVisibility(broken)).resolves.toBe('summary');
  });
});
