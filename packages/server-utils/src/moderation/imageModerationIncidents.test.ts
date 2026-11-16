import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageModerationIncident } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  markAlerted: vi.fn(),
  markEscalationAlerted: vi.fn(),
  getSettingsMap: vi.fn(),
  sendEmail: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  imageModerationIncidentRepository: {
    record: mocks.record,
    markAlerted: mocks.markAlerted,
    markEscalationAlerted: mocks.markEscalationAlerted,
  },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: mocks.getSettingsMap }));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: mocks.logger } }));
vi.mock('../utils/mailer/index', () => ({ default: { sendEmail: mocks.sendEmail } }));

import {
  createReviewerAlertDelivery,
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
        PRIVATE_OPTIONS
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

    expect(result).toEqual({ outcome: 'delivered', alertedAt: expect.any(Date) });
    expect(mocks.getSettingsMap).toHaveBeenCalledWith({ adminSettings: expect.anything() }, { skipCache: true });
    expect(mocks.sendEmail).toHaveBeenCalledExactlyOnceWith(
      'second@example.com',
      expect.objectContaining({ subject: 'Moderation review escalated' }),
      PRIVATE_OPTIONS
    );
    expect(mocks.markEscalationAlerted).toHaveBeenCalledWith('incident-1', result.alertedAt);
  });

  it('reports no_recipients when no escalation reviewer is configured', async () => {
    mocks.getSettingsMap.mockResolvedValue({ ImageModerationReviewerEmails: ['first@example.com'] });

    await expect(sendIncidentEscalationAlert(INCIDENT)).resolves.toEqual({
      outcome: 'no_recipients',
      alertedAt: null,
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.markEscalationAlerted).not.toHaveBeenCalled();
  });
});
