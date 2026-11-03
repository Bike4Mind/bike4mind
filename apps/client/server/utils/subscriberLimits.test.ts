import { describe, it, expect, vi, beforeEach } from 'vitest';

type CounterResult = { success: boolean; count: number; expiresAt: Date };

const mocks = vi.hoisted(() => ({
  tryIncrement: vi.fn<(key: string, limit: number, ttlMs: number) => Promise<CounterResult>>(),
  settings: {} as Record<string, string>,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: mocks.tryIncrement },
  userRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => mocks.settings,
}));

import { settingsMap } from '@bike4mind/common';
import { SUBSCRIBER_LIMITS, reserveSubscriberAlert } from './subscriberLimits';

const expiresAt = new Date('2026-10-29T15:00:00.000Z');
const counted = (success: boolean, count: number): CounterResult => ({ success, count, expiresAt });

describe('SUBSCRIBER_LIMITS', () => {
  it("declares one setting per limit, capped at the limit's built-in value", () => {
    const limits = Object.values(SUBSCRIBER_LIMITS);
    expect(new Set(limits.map(limit => limit.setting)).size).toBe(limits.length);
    for (const limit of limits) {
      const setting = settingsMap[limit.setting];
      expect(setting.type).toBe('number');
      expect(setting.defaultValue).toBe(0);
      expect('max' in setting && setting.max).toBe(limit.limit);
    }
  });
});

describe('reserveSubscriberAlert', () => {
  const { limit, windowMs } = SUBSCRIBER_LIMITS.slackAlertsPerHour;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = {};
  });

  it('reserves one slot past the hourly limit for the pause notice', async () => {
    mocks.tryIncrement.mockResolvedValue(counted(true, 1));

    expect(await reserveSubscriberAlert()).toEqual({ action: 'post', resumesAt: expiresAt });
    expect(mocks.tryIncrement).toHaveBeenCalledWith('subscriber-limit:slack-alerts', limit + 1, windowMs);
  });

  it('posts up to the limit, pauses once just past it, then skips until the window resets', async () => {
    mocks.tryIncrement.mockResolvedValueOnce(counted(true, limit));
    expect((await reserveSubscriberAlert()).action).toBe('post');

    mocks.tryIncrement.mockResolvedValueOnce(counted(true, limit + 1));
    expect((await reserveSubscriberAlert()).action).toBe('pause');

    mocks.tryIncrement.mockResolvedValueOnce(counted(false, limit + 1));
    expect(await reserveSubscriberAlert()).toEqual({ action: 'skip', resumesAt: expiresAt });
  });

  it('counts against a lowered admin limit, never a raised one', async () => {
    mocks.tryIncrement.mockResolvedValue(counted(true, 1));

    mocks.settings = { [SUBSCRIBER_LIMITS.slackAlertsPerHour.setting]: '3' };
    await reserveSubscriberAlert();
    expect(mocks.tryIncrement).toHaveBeenLastCalledWith(expect.any(String), 4, windowMs);

    mocks.settings = { [SUBSCRIBER_LIMITS.slackAlertsPerHour.setting]: String(limit + 50) };
    await reserveSubscriberAlert();
    expect(mocks.tryIncrement).toHaveBeenLastCalledWith(expect.any(String), limit + 1, windowMs);
  });
});
