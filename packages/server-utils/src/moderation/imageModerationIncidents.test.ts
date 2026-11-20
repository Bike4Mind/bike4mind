import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageModerationIncident } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  markAlerted: vi.fn(),
  markAlertQueued: vi.fn(),
  markEscalationAlerted: vi.fn(),
  markEscalationAlertQueued: vi.fn(),
  getSettingsMap: vi.fn(),
  sendEmail: vi.fn(),
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
  queueFailureLog: vi.fn(),
  voidAlertRound: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  imageModerationIncidentRepository: {
    record: mocks.record,
    markAlerted: mocks.markAlerted,
    markAlertQueued: mocks.markAlertQueued,
    markEscalationAlerted: mocks.markEscalationAlerted,
    markEscalationAlertQueued: mocks.markEscalationAlertQueued,
  },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: mocks.getSettingsMap }));
vi.mock('@bike4mind/observability', () => ({
  Logger: { globalInstance: mocks.logger, error: mocks.queueFailureLog },
}));
// The alert path imports the queued mailer once and keeps it, so a single case swaps in the real one
// by forwarding this stub to it.
vi.mock('../utils/mailer/queuedMailer', () => ({
  queuedMailer: { sendEmail: (...args: unknown[]) => mocks.sendEmail(...args) },
}));
vi.mock('../utils/eventBus', () => ({ EmailEvents: { Send: { publish: mocks.publish } } }));
vi.mock('../utils/mailer/index', () => ({ default: { sendEmail: mocks.smtpSendEmail } }));
vi.mock('../utils/mailer/deliveryOutcome', () => ({ voidIncidentAlertRound: mocks.voidAlertRound }));

import {
  createReviewerAlertDelivery,
  getReviewerListStatus,
  imageModerationIncidents,
  resolveAdminAppUrl,
  sendIncidentEscalationAlert,
} from './imageModerationIncidents';

describe('resolveAdminAppUrl', () => {
  it('prefers APP_URL', () => {
    expect(resolveAdminAppUrl({ APP_URL: 'https://router.example', SERVER_DOMAIN: 'example.com' })).toBe(
      'https://router.example'
    );
  });

  it('derives the app origin from SERVER_DOMAIN when APP_URL is unset', () => {
    expect(resolveAdminAppUrl({ SERVER_DOMAIN: 'example.com' })).toBe('https://app.example.com');
    expect(resolveAdminAppUrl({ APP_URL: ' ', SERVER_DOMAIN: 'https://example.com/' })).toBe('https://app.example.com');
  });

  it('returns undefined when neither is set, leaving a relative link', () => {
    expect(resolveAdminAppUrl({ SERVER_DOMAIN: '' })).toBeUndefined();
  });
});

const INPUT: ImageModerationIncident = {
  userId: 'user-1',
  sessionId: 'session-1',
  questId: 'quest-1',
  provider: 'provider-x',
  model: 'model-y',
  surface: 'generation',
  labels: [{ name: 'Category A', parentName: 'Parent B', confidence: 97.5 }],
};
const INCIDENT = { id: 'incident-1', createdAt: new Date('2026-10-19T12:00:00.000Z'), surface: 'generation' as const };
const PRIVATE_OPTIONS = { mirror: false, logRecipient: false };
const REVIEW_REF = { kind: 'incidentAlert', incidentId: 'incident-1', alert: 'review' };
const ESCALATION_REF = { kind: 'incidentAlert', incidentId: 'incident-1', alert: 'escalation' };

describe('imageModerationIncidents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.record.mockResolvedValue(INCIDENT);
    mocks.markAlerted.mockResolvedValue(undefined);
    mocks.sendEmail.mockResolvedValue({ messageId: 'm-1' });
  });

  it.each([
    ['an array', ['reviewer@example.com']],
    ['its JSON string', '["reviewer@example.com"]'],
  ])(
    'alerts the configured reviewers read from %s, with the mirror and recipient logging off',
    async (_label, stored) => {
      mocks.getSettingsMap.mockResolvedValue({ ImageModerationReviewerEmails: stored });

      await expect(imageModerationIncidents.record(INPUT)).resolves.toBe(INCIDENT);

      expect(mocks.getSettingsMap).toHaveBeenCalledWith({ adminSettings: expect.anything() });
      expect(mocks.sendEmail).toHaveBeenCalledWith(
        'reviewer@example.com',
        expect.objectContaining({ subject: 'Moderation review pending' }),
        { ...PRIVATE_OPTIONS, ref: REVIEW_REF }
      );
      expect(mocks.markAlerted).toHaveBeenCalledWith('incident-1');
    }
  );

  it('sends each reviewer a separate message so no reviewer sees another address', async () => {
    mocks.getSettingsMap.mockResolvedValue({
      ImageModerationReviewerEmails: ['one@example.com', 'two@example.com'],
    });

    await imageModerationIncidents.record(INPUT);

    expect(mocks.sendEmail.mock.calls.map(call => call[0])).toEqual(['one@example.com', 'two@example.com']);
  });

  it('records and returns the incident without sending when the stored setting cannot be parsed', async () => {
    mocks.getSettingsMap.mockResolvedValue({ ImageModerationReviewerEmails: 'not json' });

    await expect(imageModerationIncidents.record(INPUT)).resolves.toBe(INCIDENT);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.markAlerted).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('no reviewer is configured'), {
      incidentId: 'incident-1',
    });
  });

  describe('through the real queued mailer', () => {
    beforeEach(async () => {
      vi.stubEnv('B4M_SELF_HOST', 'false');
      mocks.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
      const { queuedMailer } =
        await vi.importActual<typeof import('../utils/mailer/queuedMailer')>('../utils/mailer/queuedMailer');
      mocks.sendEmail.mockImplementation((to, mail, options) => queuedMailer.sendEmail(to, mail, options));
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('publishes the alert as an email.send event that skips the mirror and the recipient log', async () => {
      mocks.getSettingsMap.mockResolvedValue({ ImageModerationReviewerEmails: ['reviewer@example.com'] });

      await expect(imageModerationIncidents.record(INPUT)).resolves.toBe(INCIDENT);

      expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          to: 'reviewer@example.com',
          subject: 'Moderation review pending',
          body: expect.stringContaining('incident-1'),
          mirror: false,
          logRecipient: false,
          ref: REVIEW_REF,
        })
      );
      expect(mocks.smtpSendEmail).not.toHaveBeenCalled();
      // Queued is not delivered: the email-send worker stamps alertedAt through the ref.
      expect(mocks.markAlertQueued).toHaveBeenCalledWith('incident-1');
      expect(mocks.markAlerted).not.toHaveBeenCalled();
    });

    it('leaves the incident unstamped when the event cannot be queued', async () => {
      mocks.getSettingsMap.mockResolvedValue({ ImageModerationReviewerEmails: ['reviewer@example.com'] });
      mocks.publish.mockRejectedValue(new Error('bus unreachable'));

      await expect(imageModerationIncidents.record(INPUT)).resolves.toBe(INCIDENT);

      expect(mocks.queueFailureLog).toHaveBeenCalledTimes(1);
      expect(mocks.queueFailureLog.mock.calls[0][0]).not.toContain('reviewer@example.com');
      expect(mocks.markAlerted).not.toHaveBeenCalled();
      expect(mocks.markAlertQueued).not.toHaveBeenCalled();
      expect(mocks.voidAlertRound).toHaveBeenCalledExactlyOnceWith(REVIEW_REF, expect.any(Date));
    });
  });

  it('reads the reviewer list past the settings cache only when the scheduled sweep asks', async () => {
    mocks.getSettingsMap.mockResolvedValue({ ImageModerationReviewerEmails: ['reviewer@example.com'] });

    await createReviewerAlertDelivery({ skipSettingsCache: true }).getRecipients();

    expect(mocks.getSettingsMap).toHaveBeenCalledWith({ adminSettings: expect.anything() }, { skipCache: true });
  });
});

describe('sendIncidentEscalationAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue({ messageId: 'm-1' });
    mocks.markEscalationAlerted.mockResolvedValue(undefined);
  });

  it('emails the escalation list read past the settings cache, privately, and stamps the delivery', async () => {
    mocks.getSettingsMap.mockResolvedValue({
      ImageModerationReviewerEmails: ['first@example.com'],
      ImageModerationEscalationEmails: '["second@example.com"]',
    });

    const result = await sendIncidentEscalationAlert(INCIDENT);

    expect(result).toEqual({ outcome: 'delivered', alertedAt: expect.any(Date), queuedAt: null });
    expect(mocks.getSettingsMap).toHaveBeenCalledWith({ adminSettings: expect.anything() }, { skipCache: true });
    expect(mocks.sendEmail).toHaveBeenCalledExactlyOnceWith(
      'second@example.com',
      expect.objectContaining({ subject: 'Moderation review escalated' }),
      { ...PRIVATE_OPTIONS, ref: ESCALATION_REF }
    );
    expect(mocks.markEscalationAlerted).toHaveBeenCalledWith('incident-1', result.alertedAt);
  });

  it('stamps only escalationAlertQueuedAt when the email is queued for the email-send worker', async () => {
    mocks.getSettingsMap.mockResolvedValue({ ImageModerationEscalationEmails: ['second@example.com'] });
    mocks.sendEmail.mockResolvedValue({ queued: true });
    mocks.markEscalationAlertQueued.mockResolvedValue(undefined);

    const result = await sendIncidentEscalationAlert(INCIDENT);

    expect(result).toEqual({ outcome: 'queued', alertedAt: null, queuedAt: expect.any(Date) });
    expect(mocks.markEscalationAlertQueued).toHaveBeenCalledWith('incident-1', result.queuedAt);
    expect(mocks.markEscalationAlerted).not.toHaveBeenCalled();
  });

  it('reports no_recipients when no escalation reviewer is configured', async () => {
    mocks.getSettingsMap.mockResolvedValue({ ImageModerationReviewerEmails: ['first@example.com'] });

    await expect(sendIncidentEscalationAlert(INCIDENT)).resolves.toEqual({
      outcome: 'no_recipients',
      alertedAt: null,
      queuedAt: null,
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.markEscalationAlerted).not.toHaveBeenCalled();
  });
});

describe('getReviewerListStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads only the two lists, past the settings cache', async () => {
    mocks.getSettingsMap.mockResolvedValue({});

    await getReviewerListStatus();

    expect(mocks.getSettingsMap).toHaveBeenCalledExactlyOnceWith(
      { adminSettings: expect.anything() },
      { skipCache: true, names: ['ImageModerationReviewerEmails', 'ImageModerationEscalationEmails'] }
    );
  });

  it.each([
    ['absent', undefined, false],
    ['empty', '[]', false],
    ['unparseable', 'not json', false],
    ['invalid entries only', '["not-an-address", ""]', false],
    ['one valid entry among invalid ones', '["not-an-address", "reviewer@example.com"]', true],
    ['a valid array', ['reviewer@example.com'], true],
  ])('treats a list that is %s as configured=%s', async (_label, stored, expected) => {
    mocks.getSettingsMap.mockResolvedValue({
      ImageModerationReviewerEmails: stored,
      ImageModerationEscalationEmails: stored,
    });

    await expect(getReviewerListStatus()).resolves.toEqual({
      reviewersConfigured: expected,
      escalationReviewersConfigured: expected,
    });
  });

  it('judges each list on its own and never returns an address', async () => {
    mocks.getSettingsMap.mockResolvedValue({
      ImageModerationReviewerEmails: '["reviewer@example.com"]',
      ImageModerationEscalationEmails: '["nope"]',
    });

    const status = await getReviewerListStatus();

    expect(status).toEqual({ reviewersConfigured: true, escalationReviewersConfigured: false });
    expect(JSON.stringify(status)).not.toContain('@');
  });
});
