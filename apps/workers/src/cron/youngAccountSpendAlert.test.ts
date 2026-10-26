import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resource: { App: { stage: 'production' } },
  connect: vi.fn(),
  findYoungAccountSpend: vi.fn(),
  getSettingsMap: vi.fn(),
  resolveSlackWebhookUrl: vi.fn(),
  post: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  counterLogRepository: { findYoungAccountSpend: mocks.findYoungAccountSpend },
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: mocks.getSettingsMap }));
vi.mock('@server/integrations/slack/slack', () => ({ resolveSlackWebhookUrl: mocks.resolveSlackWebhookUrl }));
vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return { log: vi.fn(), error: vi.fn() };
    }
  },
}));

import {
  formatYoungAccountSpendMessage,
  handler,
  readYoungAccountSpendThresholds,
  shouldAlertYoungAccountSpend,
} from './youngAccountSpendAlert';

const createdAt = new Date('2026-10-25T00:00:00.000Z');
const summary = (totalCredits: number, accountCount: number) => ({
  totalCredits,
  accountCount,
  topSpenders: [{ userId: 'user-a', creditsSpent: totalCredits, accountCreatedAt: createdAt }],
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
  it('lists the window, counts and ranked user ids without emails', () => {
    const text = formatYoungAccountSpendMessage(
      {
        totalCredits: 12345,
        accountCount: 2,
        topSpenders: [
          { userId: 'user-a', creditsSpent: 12000, accountCreatedAt: createdAt },
          { userId: 'user-b', creditsSpent: 345, accountCreatedAt: createdAt },
        ],
      },
      { credits: 5000, accounts: 25 },
      { start: new Date('2026-10-26T10:00:00.000Z'), end: new Date('2026-10-26T11:00:00.000Z') },
      'production'
    );
    expect(text).toContain('2026-10-26T10:00:00.000Z to 2026-10-26T11:00:00.000Z');
    expect(text).toContain('12,345 credits across 2 accounts');
    expect(text).toContain('1. `user-a` 12,000 credits');
    expect(text).toContain('2. `user-b` 345 credits');
    expect(text).not.toContain('@');
    expect([...text].every(char => char.charCodeAt(0) < 128)).toBe(true);
  });
});

describe('young-account spend handler', () => {
  it('skips non-production stages before connecting', async () => {
    mocks.resource.App.stage = 'dev';
    expect(await handler()).toMatchObject({ status: 'skipped' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('queries the last hour and stays quiet below the ceilings', async () => {
    mocks.findYoungAccountSpend.mockResolvedValue(summary(100, 2));
    expect(await handler()).toMatchObject({ status: 'ok' });
    expect(mocks.connect).toHaveBeenCalledWith('mongodb://example/production', expect.anything());
    const [start, end, limit] = mocks.findYoungAccountSpend.mock.calls[0];
    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
    expect(limit).toBe(10);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('posts to Slack when a ceiling is exceeded', async () => {
    mocks.findYoungAccountSpend.mockResolvedValue(summary(9000, 4));
    expect(await handler()).toMatchObject({ status: 'alerted', totalCredits: 9000 });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('https://hooks.example.com/x', {
      text: expect.stringContaining('`user-a`'),
    });
  });

  it('fails loudly when an alert has nowhere to go', async () => {
    mocks.findYoungAccountSpend.mockResolvedValue(summary(9000, 4));
    mocks.resolveSlackWebhookUrl.mockReturnValue('');
    await expect(handler()).rejects.toThrow(/no Slack webhook/);
  });
});
