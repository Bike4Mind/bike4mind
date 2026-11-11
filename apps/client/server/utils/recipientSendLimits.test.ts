import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const counters = new Map<string, { count: number; expiresAt: Date }>();
const tryAddWithinLimitFixedWindow = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryAddWithinLimitFixedWindow },
  adminSettingsRepository: {},
  userRepository: {},
}));

import { RECIPIENT_SEND_WINDOWS, reserveRecipientSendBudget } from './recipientSendLimits';

const [hourly, daily] = RECIPIENT_SEND_WINDOWS;

describe('reserveRecipientSendBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    counters.clear();
    tryAddWithinLimitFixedWindow.mockImplementation(async (key: string, amount: number, limit: number, ttl: number) => {
      const now = Date.now();
      const cur = counters.get(key);
      const live = cur && cur.expiresAt.getTime() > now ? cur : { count: 0, expiresAt: new Date(now + ttl) };
      if (live.count + amount > limit) return { success: false, count: live.count, expiresAt: live.expiresAt };
      live.count += amount;
      counters.set(key, live);
      return { success: true, count: live.count, expiresAt: live.expiresAt };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows sends up to the hourly limit then refuses with a Retry-After', async () => {
    for (let i = 0; i < hourly.limit; i++) {
      expect(await reserveRecipientSendBudget(['a@example.com'])).toBeUndefined();
    }
    const refused = await reserveRecipientSendBudget(['a@example.com']);
    expect(refused?.retryAfter).toBeGreaterThan(0);
    expect(refused?.retryAfter).toBeLessThanOrEqual(hourly.windowMs / 1000);
  });

  it('folds plus-tags, Gmail dots and case into one inbox', async () => {
    const aliases = [
      'jo.hn@gmail.com',
      'john+a@gmail.com',
      'JOHN@googlemail.com',
      'j.o.h.n+x@gmail.com',
      'John@Gmail.com',
    ];
    for (const alias of aliases) expect(await reserveRecipientSendBudget([alias])).toBeUndefined();
    expect(await reserveRecipientSendBudget(['john+z@gmail.com'])).toBeDefined();
  });

  it('refuses the whole send and spends nothing when any recipient is over its limit', async () => {
    for (let i = 0; i < hourly.limit; i++) await reserveRecipientSendBudget(['full@example.com']);

    expect(await reserveRecipientSendBudget(['fresh@example.com', 'full@example.com'])).toBeDefined();
    for (let i = 0; i < hourly.limit; i++) {
      expect(await reserveRecipientSendBudget(['fresh@example.com'])).toBeUndefined();
    }
  });

  it('charges a repeated address once per send', async () => {
    await reserveRecipientSendBudget(['a@example.com', 'A@example.com', 'a+x@example.com']);
    for (let i = 0; i < hourly.limit - 1; i++) {
      expect(await reserveRecipientSendBudget(['a@example.com'])).toBeUndefined();
    }
    expect(await reserveRecipientSendBudget(['a@example.com'])).toBeDefined();
  });

  it('resets the hourly window but still enforces the daily window', async () => {
    for (let round = 0; round < daily.limit / hourly.limit; round++) {
      for (let i = 0; i < hourly.limit; i++) {
        expect(await reserveRecipientSendBudget(['a@example.com'])).toBeUndefined();
      }
      expect(await reserveRecipientSendBudget(['a@example.com'])).toBeDefined();
      vi.advanceTimersByTime(hourly.windowMs + 1000);
    }
    const refused = await reserveRecipientSendBudget(['a@example.com']);
    expect(refused).toBeDefined();
    expect(refused!.retryAfter).toBeGreaterThan(hourly.windowMs / 1000);

    vi.advanceTimersByTime(daily.windowMs);
    expect(await reserveRecipientSendBudget(['a@example.com'])).toBeUndefined();
  });

  it('never puts the raw address in a cache key', async () => {
    await reserveRecipientSendBudget(['secret.person@example.com']);
    for (const [key] of counters) expect(key).not.toMatch(/secret|example/);
  });

  it('does nothing for an empty list', async () => {
    tryAddWithinLimitFixedWindow.mockClear();
    expect(await reserveRecipientSendBudget([])).toBeUndefined();
    expect(tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
  });
});
