import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({
  expirePreviousKey: vi.fn(),
  postMessageToSlack: vi.fn(),
  resolveSlackWebhookUrl: vi.fn(),
  sendAccessReviewReminder: vi.fn(),
  resource: { App: { stage: 'dev' } },
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { expirePreviousKey: mocks.expirePreviousKey },
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

vi.mock('@bike4mind/server-utils/security/accessReview/accessReviewData', () => ({
  sendAccessReviewReminder: mocks.sendAccessReviewReminder,
}));

vi.mock('sst', () => ({ Resource: mocks.resource }));

import { handler } from './secretRotationNotifier';

// First Monday of January: an access review reminder day.
const REMINDER_DAY = new Date('2027-01-04T09:00:00Z');
const ORDINARY_DAY = new Date('2027-01-12T09:00:00Z');

describe('secretRotationNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ORDINARY_DAY);
    mocks.resource.App.stage = 'dev';
    mocks.expirePreviousKey.mockResolvedValue(undefined);
    mocks.resolveSlackWebhookUrl.mockReturnValue('https://hooks.example/liveops');
    mocks.sendAccessReviewReminder.mockResolvedValue('2027-Q1');
    mocks.postMessageToSlack.mockResolvedValue(true);
    vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retires a rotated-out JWT secret once its grace window has closed', async () => {
    await handler();

    expect(mocks.expirePreviousKey).toHaveBeenCalledWith('JWT_SECRET', 24 * 60 * 60 * 1000);
  });

  it('posts nothing on an ordinary day', async () => {
    mocks.resource.App.stage = 'production';

    await expect(handler()).resolves.toEqual({ status: 'OK' });
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
    expect(mocks.sendAccessReviewReminder).not.toHaveBeenCalled();
  });

  it('posts the quarterly access review reminder on its day in production', async () => {
    vi.setSystemTime(REMINDER_DAY);
    mocks.resource.App.stage = 'production';

    await expect(handler()).resolves.toEqual({ status: 'OK', accessReviewQuarter: '2027-Q1' });
    expect(mocks.sendAccessReviewReminder).toHaveBeenCalledWith(REMINDER_DAY, expect.any(Function));
    const post = mocks.sendAccessReviewReminder.mock.calls[0][1] as (text: string) => Promise<unknown>;
    await post('reminder text');
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
    expect(mocks.postMessageToSlack).toHaveBeenCalledWith('https://hooks.example/liveops', 'reminder text');
  });

  it('skips the reminder when the webhook is not configured', async () => {
    vi.setSystemTime(REMINDER_DAY);
    mocks.resource.App.stage = 'production';
    mocks.resolveSlackWebhookUrl.mockReturnValue('');

    await expect(handler()).resolves.toEqual({ status: 'OK', skipped: true, reason: 'Slack webhook not configured' });
    expect(mocks.sendAccessReviewReminder).not.toHaveBeenCalled();
  });

  it('logs a failed reminder without failing the run', async () => {
    vi.setSystemTime(REMINDER_DAY);
    mocks.resource.App.stage = 'production';
    mocks.postMessageToSlack.mockResolvedValueOnce(false);
    mocks.sendAccessReviewReminder.mockImplementationOnce(
      async (_now: Date, post: (text: string) => Promise<unknown>) => {
        await post('reminder text');
        return '2027-Q1';
      }
    );

    await expect(handler()).resolves.toEqual({ status: 'OK' });
    expect(Logger.error).toHaveBeenCalledWith('Access review reminder failed', {
      error: expect.objectContaining({ message: 'Access review reminder was not accepted by Slack' }),
    });
  });

  it('sends no access review reminder outside production', async () => {
    vi.setSystemTime(REMINDER_DAY);

    await expect(handler()).resolves.toEqual({ status: 'OK' });
    expect(mocks.sendAccessReviewReminder).not.toHaveBeenCalled();
  });

  it('logs and rethrows a failure', async () => {
    mocks.expirePreviousKey.mockRejectedValue(new Error('db down'));

    await expect(handler()).rejects.toThrow('db down');
    expect(Logger.error).toHaveBeenCalledWith('Error in secret rotation notifier', { error: expect.any(Error) });
  });
});
