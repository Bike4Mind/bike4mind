import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resource: { App: { stage: 'production' } },
  connect: vi.fn(),
  findYoungAccountSpend: vi.fn(),
  getSettingsMap: vi.fn(),
  resolveSlackWebhookUrl: vi.fn(),
  post: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  counterLogRepository: { findYoungAccountSpend: mocks.findYoungAccountSpend },
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: mocks.getSettingsMap }));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({
  resolveSlackWebhookUrl: mocks.resolveSlackWebhookUrl,
}));
vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return { log: mocks.log, error: mocks.error };
    }
  },
}));

import {
  formatYoungAccountSpendMessage,
  handler,
  readYoungAccountSpendThresholds,
  shouldAlertYoungAccountSpend,
} from './youngAccountSpendAlert';

const event = { time: '2026-10-26T11:00:00Z' };
const createdAt = new Date('2026-10-25T00:00:00.000Z');
const summary = (totalCredits: number, accountCount: number) => ({
  totalCredits,
  accountCount,
  topSpenders: [
    { userId: 'user-a', creditsSpent: totalCredits, accountCreatedAt: createdAt, stripeCustomerId: 'cus_a' },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.resource.App.stage = 'production';
  mocks.getSettingsMap.mockResolvedValue({});
  mocks.resolveSlackWebhookUrl.mockReturnValue('https://hooks.example.com/x');
});

describe('young-account spend thresholds', () => {
  it('defaults to 5000 credits and 25 accounts', () => {
    expect(readYoungAccountSpendThresholds()).toEqual({ credits: 5000, accounts: 25 });
  });

  it('reads configured ceilings and rejects invalid ones', () => {
    vi.stubEnv('YOUNG_ACCOUNT_SPEND_ALERT_CREDITS', ' 800 ');
    vi.stubEnv('YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS', '3');
    expect(readYoungAccountSpendThresholds()).toEqual({ credits: 800, accounts: 3 });
    vi.stubEnv('YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS', '0');
    expect(() => readYoungAccountSpendThresholds()).toThrow(/YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS/);
  });

  it.each([
    [5000, 25, false],
    [5001, 1, true],
    [10, 26, true],
    [0, 0, false],
  ])('total %s credits across %s accounts alerts: %s', (credits, accounts, expected) => {
    expect(shouldAlertYoungAccountSpend(summary(credits, accounts), { credits: 5000, accounts: 25 })).toBe(expected);
  });
});

describe('young-account spend message', () => {
  const window = { start: new Date('2026-10-26T10:00:00.000Z'), end: new Date('2026-10-26T11:00:00.000Z') };
  const twoSpenders = {
    totalCredits: 12345,
    accountCount: 2,
    topSpenders: [
      { userId: 'user-a', creditsSpent: 12000, accountCreatedAt: createdAt, stripeCustomerId: 'cus_a' },
      { userId: 'user-b', creditsSpent: 345, accountCreatedAt: createdAt, stripeCustomerId: null },
    ],
  };
  const thresholds = { credits: 5000, accounts: 25 };

  it('lists the window, counts and ranked user ids without emails', () => {
    const text = formatYoungAccountSpendMessage(twoSpenders, thresholds, window, 'production', undefined);
    expect(text).toContain('2026-10-26T10:00:00.000Z to 2026-10-26T11:00:00.000Z');
    expect(text).toContain('12,345 credits across 2 accounts');
    expect(text).toContain('1. `user-a` 12,000 credits');
    expect(text).toContain('2. `user-b` 345 credits');
    expect(text).not.toContain('@');
    expect([...text].every(char => char.charCodeAt(0) < 128)).toBe(true);
  });

  it('links each account to the admin profile and the live Stripe customer, or marks it as unbilled', () => {
    const lines = formatYoungAccountSpendMessage(
      twoSpenders,
      thresholds,
      window,
      'production',
      'https://app.example.com'
    ).split('\n');
    expect(lines).toContain(
      '1. `user-a` 12,000 credits (created 2026-10-25T00:00:00.000Z) - ' +
        '<https://app.example.com/admin/users/user-a|admin> | <https://dashboard.stripe.com/customers/cus_a|Stripe>'
    );
    expect(lines).toContain(
      '2. `user-b` 345 credits (created 2026-10-25T00:00:00.000Z) - ' +
        '<https://app.example.com/admin/users/user-b|admin> | no Stripe customer'
    );
  });

  it('links the Stripe test-mode dashboard outside production', () => {
    const text = formatYoungAccountSpendMessage(twoSpenders, thresholds, window, 'staging', undefined);
    expect(text).toContain('<https://dashboard.stripe.com/test/customers/cus_a|Stripe>');
  });

  it('omits the admin link when the app URL is unknown', () => {
    const text = formatYoungAccountSpendMessage(twoSpenders, thresholds, window, 'production', undefined);
    expect(text).not.toContain('/admin/users/');
    expect(text).toContain('- <https://dashboard.stripe.com/customers/cus_a|Stripe>');
  });

  it('keeps ids from breaking out of their Slack links', () => {
    const text = formatYoungAccountSpendMessage(
      { ...twoSpenders, topSpenders: [{ ...twoSpenders.topSpenders[0], userId: 'a|b>c', stripeCustomerId: 'cus|x' }] },
      thresholds,
      window,
      'production',
      'https://app.example.com'
    );
    expect(text).toContain('<https://app.example.com/admin/users/a%7Cb%3Ec|admin>');
    expect(text).toContain('<https://dashboard.stripe.com/customers/cus%7Cx|Stripe>');
  });
});

describe('young-account spend handler', () => {
  it('skips non-production stages before connecting', async () => {
    mocks.resource.App.stage = 'dev';
    expect(await handler(event)).toMatchObject({ status: 'skipped' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('queries the last hour and stays quiet below the ceilings', async () => {
    mocks.findYoungAccountSpend.mockResolvedValue(summary(100, 2));
    expect(await handler(event)).toMatchObject({ status: 'ok' });
    expect(mocks.connect).toHaveBeenCalledWith('mongodb://example/production', expect.anything());
    const [start, end, limit] = mocks.findYoungAccountSpend.mock.calls[0];
    expect(start).toEqual(new Date('2026-10-26T10:00:00Z'));
    expect(end).toEqual(new Date(event.time));
    expect(limit).toBe(10);
    expect(mocks.log).toHaveBeenCalledWith(
      'young-account-spend',
      expect.objectContaining({ windowStart: '2026-10-26T10:00:00.000Z', windowEnd: '2026-10-26T11:00:00.000Z' })
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('keeps the scheduled window on delayed delivery and retry', async () => {
    mocks.findYoungAccountSpend.mockResolvedValue(summary(9000, 4));
    mocks.post.mockRejectedValueOnce(new Error('webhook unavailable'));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-26T11:05:00Z'));
      await expect(handler(event)).rejects.toThrow('webhook unavailable');
      vi.setSystemTime(new Date('2026-10-26T12:15:00Z'));
      await handler(event);
      expect(mocks.findYoungAccountSpend.mock.calls[0]).toEqual(mocks.findYoungAccountSpend.mock.calls[1]);
      expect(mocks.findYoungAccountSpend).toHaveBeenLastCalledWith(
        new Date('2026-10-26T10:00:00Z'),
        new Date(event.time),
        10
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a malformed scheduled event time before connecting', async () => {
    await expect(handler({ time: 'invalid' })).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([{}, null, undefined, { time: null }, { time: '' }])(
    'rejects an event without a valid scheduled timestamp: %j',
    async invalidEvent => {
      await expect(handler(invalidEvent)).rejects.toThrow();
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );

  it('posts to Slack when a ceiling is exceeded', async () => {
    mocks.findYoungAccountSpend.mockResolvedValue(summary(9000, 4));
    expect(await handler(event)).toMatchObject({ status: 'alerted', totalCredits: 9000 });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('https://hooks.example.com/x', {
      text: expect.stringContaining('`user-a`'),
    });
  });

  it('still alerts, and logs the gap, when the deploy domain is unknown', async () => {
    vi.stubEnv('SERVER_DOMAIN', '');
    mocks.findYoungAccountSpend.mockResolvedValue(summary(9000, 4));
    expect(await handler(event)).toMatchObject({ status: 'alerted' });
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('SERVER_DOMAIN'));
  });

  it('builds the admin link from the deploy domain', async () => {
    vi.stubEnv('SERVER_DOMAIN', 'example.com');
    mocks.findYoungAccountSpend.mockResolvedValue(summary(9000, 4));
    await handler(event);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('https://hooks.example.com/x', {
      text: expect.stringContaining(
        '<https://app.example.com/admin/users/user-a|admin> | <https://dashboard.stripe.com/customers/cus_a|Stripe>'
      ),
    });
  });

  it('propagates a failed spend query without reporting a quiet hour', async () => {
    const error = new Error('database unavailable');
    mocks.findYoungAccountSpend.mockRejectedValueOnce(error);
    await expect(handler(event)).rejects.toBe(error);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('propagates a failed Slack delivery for retry', async () => {
    mocks.findYoungAccountSpend.mockResolvedValue(summary(9000, 4));
    const error = new Error('webhook unavailable');
    mocks.post.mockRejectedValueOnce(error);
    await expect(handler(event)).rejects.toBe(error);
  });

  it('fails loudly when an alert has nowhere to go', async () => {
    mocks.findYoungAccountSpend.mockResolvedValue(summary(9000, 4));
    mocks.resolveSlackWebhookUrl.mockReturnValue('');
    await expect(handler(event)).rejects.toThrow(/no Slack webhook/);
  });
});
