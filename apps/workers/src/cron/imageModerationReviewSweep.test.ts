import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
  emitMetrics: vi.fn(async () => undefined),
  findUnalerted: vi.fn(),
  findDueForReminder: vi.fn(),
  findPendingReview: vi.fn(),
  markAlerted: vi.fn(async () => undefined),
  markAlertQueued: vi.fn(async () => undefined),
  markReminded: vi.fn(async () => undefined),
  findDueForEscalation: vi.fn(),
  escalate: vi.fn(),
  findEscalationUnalerted: vi.fn(),
  markEscalationAlerted: vi.fn(async () => undefined),
  markEscalationAlertQueued: vi.fn(async () => undefined),
  findDueForEscalationReminder: vi.fn(),
  countPendingReview: vi.fn(async () => 1),
  markEscalationReminded: vi.fn(async () => undefined),
  createReviewerAlertDelivery: vi.fn(),
  sendEmail: vi.fn(),
  getRecipients: vi.fn(),
  getEscalationRecipients: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connectDB,
  imageModerationIncidentRepository: {
    findUnalerted: mocks.findUnalerted,
    findDueForReminder: mocks.findDueForReminder,
    findPendingReview: mocks.findPendingReview,
    markAlerted: mocks.markAlerted,
    markAlertQueued: mocks.markAlertQueued,
    markReminded: mocks.markReminded,
    findDueForEscalation: mocks.findDueForEscalation,
    escalate: mocks.escalate,
    findEscalationUnalerted: mocks.findEscalationUnalerted,
    markEscalationAlerted: mocks.markEscalationAlerted,
    markEscalationAlertQueued: mocks.markEscalationAlertQueued,
    findDueForEscalationReminder: mocks.findDueForEscalationReminder,
    countPendingReview: mocks.countPendingReview,
    markEscalationReminded: mocks.markEscalationReminded,
  },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
  },
}));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetrics: mocks.emitMetrics }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('@bike4mind/server-utils/moderation/imageModerationIncidents', () => ({
  createReviewerAlertDelivery: mocks.createReviewerAlertDelivery,
}));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import { handler } from './imageModerationReviewSweep';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const row = (id: string, ageMinutes: number) => ({ _id: id, createdAt: minutesAgo(ageMinutes), surface: 'upload' });

const emitted = () =>
  Object.fromEntries(
    mocks.emitMetrics.mock.calls.flatMap(call =>
      (call[1] as { name: string; value: number }[]).map(metric => [metric.name, metric.value])
    )
  );

describe('imageModerationReviewSweep handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnalerted.mockResolvedValue([]);
    mocks.findDueForReminder.mockResolvedValue([]);
    mocks.findPendingReview.mockResolvedValue([]);
    mocks.findDueForEscalation.mockResolvedValue([]);
    mocks.escalate.mockResolvedValue(null);
    mocks.findEscalationUnalerted.mockResolvedValue([]);
    mocks.findDueForEscalationReminder.mockResolvedValue([]);
    mocks.getRecipients.mockResolvedValue(['reviewer-one@example.com']);
    mocks.getEscalationRecipients.mockResolvedValue(['second-one@example.com']);
    mocks.sendEmail.mockResolvedValue({ messageId: 'm-1' });
    mocks.createReviewerAlertDelivery.mockReturnValue({
      getRecipients: mocks.getRecipients,
      getEscalationRecipients: mocks.getEscalationRecipients,
      sendEmail: mocks.sendEmail,
      appUrl: () => 'https://app.example',
      logger: { warn: vi.fn(), error: vi.fn() },
    });
  });

  it('reads the reviewer list fresh and connects without building indexes', async () => {
    await handler();

    expect(mocks.createReviewerAlertDelivery).toHaveBeenCalledWith({ skipSettingsCache: true });
    expect(mocks.connectDB).toHaveBeenCalledWith('mongodb://host/test', undefined, {
      autoIndex: false,
      autoCreate: false,
    });
  });

  it('re-sends a missed alert, stamps it, and publishes quiet metrics once nothing is left', async () => {
    mocks.findUnalerted.mockResolvedValueOnce([row('inc-1', 40)]).mockResolvedValueOnce([]);
    mocks.findPendingReview.mockResolvedValue([row('inc-1', 40)]);

    const result = await handler();

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.markAlerted).toHaveBeenCalledWith('inc-1', expect.any(Date));
    expect(result).toMatchObject({ alerted: 1, reminded: 0, failed: 0 });
    expect(emitted()).toEqual({
      OldestUnalertedAgeMinutes: 0,
      OldestPendingAgeMinutes: 40,
      PendingWithoutReviewers: 0,
    });
  });

  it('escalates an overdue incident on timeout, with no admin, and emails the escalation list', async () => {
    const overdue = row('inc-3', 25 * 60);
    const escalatedAt = new Date();
    mocks.findDueForEscalation.mockResolvedValue([overdue]);
    mocks.escalate.mockResolvedValue({ ...overdue, escalatedAt, escalationTrigger: 'timeout' });
    mocks.findEscalationUnalerted.mockResolvedValue([{ ...overdue, escalatedAt }]);

    const result = await handler();

    expect(mocks.escalate).toHaveBeenCalledExactlyOnceWith('inc-3', { trigger: 'timeout' }, expect.any(Date));
    expect(mocks.sendEmail).toHaveBeenCalledExactlyOnceWith(
      'second-one@example.com',
      expect.objectContaining({ subject: 'Moderation review escalated' }),
      { kind: 'incidentAlert', incidentId: 'inc-3', alert: 'escalation' }
    );
    expect(mocks.markEscalationAlerted).toHaveBeenCalledWith('inc-3', expect.any(Date));
    expect(result).toMatchObject({ escalated: 1, escalationAlerted: 1 });
  });

  it('reminds the escalation list about a waiting escalated incident and stamps its own reminder time', async () => {
    const waiting = { ...row('inc-4', 50 * 60), escalatedAt: new Date() };
    mocks.findDueForEscalationReminder.mockResolvedValue([waiting]);

    const result = await handler();

    expect(mocks.sendEmail).toHaveBeenCalledExactlyOnceWith(
      'second-one@example.com',
      expect.objectContaining({ subject: 'Moderation reviews still pending' })
    );
    expect(mocks.markEscalationReminded).toHaveBeenCalledExactlyOnceWith(['inc-4'], expect.any(Date));
    expect(mocks.markReminded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalationReminded: 1, reminded: 0 });
  });

  it('publishes every series dimensioned by Stage only', async () => {
    await handler();

    expect(mocks.emitMetrics).toHaveBeenCalledWith(
      'Lumina5/ImageModerationReview',
      expect.arrayContaining([
        expect.objectContaining({ name: 'OldestUnalertedAgeMinutes', dimensions: { Stage: 'test' } }),
        expect.objectContaining({ name: 'OldestPendingAgeMinutes', dimensions: { Stage: 'test' } }),
        expect.objectContaining({ name: 'PendingWithoutReviewers', dimensions: { Stage: 'test' } }),
      ])
    );
  });

  it('flags a pending incident with no reviewer and does not send', async () => {
    mocks.getRecipients.mockResolvedValue([]);
    mocks.findUnalerted.mockResolvedValue([row('inc-2', 120)]);
    mocks.findPendingReview.mockResolvedValue([row('inc-2', 120)]);

    await handler();

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(emitted()).toEqual({
      OldestUnalertedAgeMinutes: 120,
      OldestPendingAgeMinutes: 120,
      PendingWithoutReviewers: 1,
    });
  });

  it('lets a failed run reach the dead-letter queue instead of publishing a clean datapoint', async () => {
    mocks.findPendingReview.mockRejectedValue(new Error('db down'));

    await expect(handler()).rejects.toThrow('db down');
    expect(mocks.emitMetrics).not.toHaveBeenCalled();
  });
});
