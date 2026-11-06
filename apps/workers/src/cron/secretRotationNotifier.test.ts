import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  expirePreviousKey: vi.fn(),
  find: vi.fn(),
  postMessageToSlack: vi.fn(),
  resolveSlackWebhookUrl: vi.fn(),
  rotationConfig: vi.fn(),
  sendAccessReviewReminder: vi.fn(),
  resource: { App: { stage: 'dev' } },
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { expirePreviousKey: mocks.expirePreviousKey, find: mocks.find },
}));

vi.mock('@bike4mind/utils', () => ({
  postMessageToSlack: mocks.postMessageToSlack,
  getSettingsMap: vi.fn().mockResolvedValue({}),
}));

vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({
  resolveSlackWebhookUrl: mocks.resolveSlackWebhookUrl,
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://localhost:27017/%STAGE%' },
}));

vi.mock('@bike4mind/server-utils/lib/secretRotation/constants', () => ({
  getSecretRotationConfig: mocks.rotationConfig,
}));

vi.mock('@bike4mind/server-utils/security/accessReview/accessReviewData', () => ({
  sendAccessReviewReminder: mocks.sendAccessReviewReminder,
}));

vi.mock('sst', () => ({ Resource: mocks.resource }));

import { handler } from './secretRotationNotifier';

const DAY_MS = 24 * 60 * 60 * 1000;
// First Monday of January: an access review reminder day.
const REMINDER_DAY = new Date('2027-01-04T09:00:00Z');
const ORDINARY_DAY = new Date('2027-01-12T09:00:00Z');

const secret = (keyName: string, daysOut: number, description?: string) => ({
  keyName,
  isActive: true,
  nextRotation: new Date(Date.now() + daysOut * DAY_MS),
  rotationIntervalDays: 90,
  description,
});

describe('secretRotationNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ORDINARY_DAY);
    mocks.resource.App.stage = 'dev';
    mocks.expirePreviousKey.mockResolvedValue(undefined);
    mocks.find.mockResolvedValue([]);
    mocks.rotationConfig.mockReturnValue({});
    mocks.resolveSlackWebhookUrl.mockReturnValue('https://hooks.example/liveops');
    mocks.sendAccessReviewReminder.mockResolvedValue('2027-Q1');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retires a rotated-out JWT secret once its grace window has closed', async () => {
    await handler();

    expect(mocks.expirePreviousKey).toHaveBeenCalledWith('JWT_SECRET', 24 * 60 * 60 * 1000);
  });

  it('posts nothing when no secret is due and no review is due', async () => {
    mocks.rotationConfig.mockReturnValue({ JWT_SECRET: {} });
    mocks.find.mockResolvedValue([secret('JWT_SECRET', 30), secret('UNCONFIGURED', 1)]);

    await expect(handler()).resolves.toEqual({ status: 'OK', message: 'No secrets due for rotation' });
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('posts the configured secrets due within a week', async () => {
    mocks.rotationConfig.mockReturnValue({ JWT_SECRET: {}, SESSION_SECRET: {} });
    mocks.find.mockResolvedValue([secret('JWT_SECRET', 3, 'Signs tokens'), secret('SESSION_SECRET', 2)]);

    await expect(handler()).resolves.toEqual({ status: 'OK', notified: 2 });
    const [url, text] = mocks.postMessageToSlack.mock.calls[0];
    expect(url).toBe('https://hooks.example/liveops');
    expect(text).toContain('*2 secret(s) due for rotation*');
    expect(text).toContain('_Description:_ Signs tokens');
    expect(text).toContain('_Description:_ None');
    expect(mocks.sendAccessReviewReminder).not.toHaveBeenCalled();
  });

  it('skips posting when the webhook is not configured', async () => {
    mocks.rotationConfig.mockReturnValue({ JWT_SECRET: {} });
    mocks.find.mockResolvedValue([secret('JWT_SECRET', 1)]);
    mocks.resolveSlackWebhookUrl.mockReturnValue('');

    await expect(handler()).resolves.toEqual({
      status: 'OK',
      notified: 0,
      skipped: true,
      reason: 'Slack webhook not configured',
    });
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('posts the quarterly access review reminder on its day in production', async () => {
    vi.setSystemTime(REMINDER_DAY);
    mocks.resource.App.stage = 'production';

    await expect(handler()).resolves.toEqual({ status: 'OK', notified: 0, accessReviewQuarter: '2027-Q1' });
    expect(mocks.sendAccessReviewReminder).toHaveBeenCalledWith(REMINDER_DAY, expect.any(Function));
    const post = mocks.sendAccessReviewReminder.mock.calls[0][1] as (text: string) => Promise<unknown>;
    await post('reminder text');
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
    expect(mocks.postMessageToSlack).toHaveBeenCalledWith('https://hooks.example/liveops', 'reminder text');
  });

  it('posts both the reminder and due secrets on a reminder day', async () => {
    vi.setSystemTime(REMINDER_DAY);
    mocks.resource.App.stage = 'production';
    mocks.rotationConfig.mockReturnValue({ JWT_SECRET: {} });
    mocks.find.mockResolvedValue([secret('JWT_SECRET', 1)]);

    await expect(handler()).resolves.toEqual({ status: 'OK', notified: 1, accessReviewQuarter: '2027-Q1' });
    expect(mocks.sendAccessReviewReminder).toHaveBeenCalledTimes(1);
    expect(mocks.postMessageToSlack).toHaveBeenCalledWith(
      'https://hooks.example/liveops',
      expect.stringContaining('*1 secret(s) due for rotation*')
    );
  });

  it('still posts due secrets when the access review reminder fails', async () => {
    vi.setSystemTime(REMINDER_DAY);
    mocks.resource.App.stage = 'production';
    mocks.rotationConfig.mockReturnValue({ JWT_SECRET: {} });
    mocks.find.mockResolvedValue([secret('JWT_SECRET', 1)]);
    mocks.sendAccessReviewReminder.mockRejectedValue(new Error('read failed'));

    await expect(handler()).resolves.toEqual({ status: 'OK', notified: 1 });
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith('Access review reminder failed:', expect.any(Error));
  });

  it('sends no access review reminder outside production', async () => {
    vi.setSystemTime(REMINDER_DAY);

    await expect(handler()).resolves.toEqual({ status: 'OK', message: 'No secrets due for rotation' });
    expect(mocks.sendAccessReviewReminder).not.toHaveBeenCalled();
  });

  it('logs and rethrows a failure', async () => {
    mocks.expirePreviousKey.mockRejectedValue(new Error('db down'));

    await expect(handler()).rejects.toThrow('db down');
    expect(console.error).toHaveBeenCalledWith('Error in secret rotation notifier:', expect.any(Error));
  });
});
