import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
  findActiveEmailsByIds: vi.fn(),
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { findActiveEmailsByIds: h.findActiveEmailsByIds } }));
// The real queuedMailer runs: the event bus is the seam, and the SMTP mailer must stay untouched.
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: h.smtpSendEmail } }));

import { notifyApiKeyOrgRevoke, notifyApiKeyRotationReown } from './apiKeyRotationNotifier';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('B4M_SELF_HOST', 'false');
  h.findActiveEmailsByIds.mockResolvedValue([{ id: 'prev-owner', email: 'owner@example.org' }]);
  h.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('notifyApiKeyRotationReown', () => {
  it('publishes the rotation notice as an email.send event to the previous owner', async () => {
    await notifyApiKeyRotationReown('prev-owner', 'My Key');

    expect(h.findActiveEmailsByIds).toHaveBeenCalledWith(['prev-owner']);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'owner@example.org',
        subject: expect.stringContaining('My Key'),
        body: expect.stringContaining('My Key'),
      })
    );
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });

  it('publishes nothing when the previous owner has no active email', async () => {
    h.findActiveEmailsByIds.mockResolvedValue([]);
    const logger = { warn: vi.fn() };

    await notifyApiKeyRotationReown('prev-owner', 'My Key', logger);

    expect(h.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('forwards the logger, which hears about an event that could not be queued', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
    h.publish.mockRejectedValue(new Error('bus unreachable'));
    const logger = { warn: vi.fn() };

    await expect(notifyApiKeyRotationReown('prev-owner', 'My Key', logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to send'), expect.anything());
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });
});

describe('notifyApiKeyOrgRevoke', () => {
  beforeEach(() => {
    h.findActiveEmailsByIds.mockResolvedValue([{ id: 'holder-1', email: 'holder@example.org' }]);
  });

  it('publishes the revoke notice as an email.send event to the key holder', async () => {
    await notifyApiKeyOrgRevoke('holder-1', 'CI Key', 'Acme');

    expect(h.findActiveEmailsByIds).toHaveBeenCalledWith(['holder-1']);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'holder@example.org',
        subject: expect.stringContaining('CI Key'),
        body: expect.stringContaining('Acme'),
      })
    );
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });

  it('publishes nothing when the key holder has no active email', async () => {
    h.findActiveEmailsByIds.mockResolvedValue([]);
    const logger = { warn: vi.fn() };

    await notifyApiKeyOrgRevoke('holder-1', 'CI Key', 'Acme', logger);

    expect(h.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('forwards the logger, which hears about an event that could not be queued', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
    h.publish.mockRejectedValue(new Error('bus unreachable'));
    const logger = { warn: vi.fn() };

    await expect(notifyApiKeyOrgRevoke('holder-1', 'CI Key', 'Acme', logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to send'), expect.anything());
  });
});
