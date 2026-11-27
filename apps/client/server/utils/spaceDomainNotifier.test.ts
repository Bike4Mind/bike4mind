import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  notifySpaceDomainReleased: vi.fn(),
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
  users: { kind: 'users' as const },
}));
vi.mock('@bike4mind/services', () => ({
  spaceService: { notifySpaceDomainReleased: h.notifySpaceDomainReleased },
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: h.users }));
// The real queuedMailer is the one under test: the event bus is the seam, and the SMTP mailer must stay untouched.
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: h.smtpSendEmail } }));

import { queuedMailer } from '@bike4mind/server-utils/utils/mailer/queuedMailer';
import { notifySpaceDomainReleasedByEmail } from './spaceDomainNotifier';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('B4M_SELF_HOST', 'false');
  h.notifySpaceDomainReleased.mockResolvedValue(undefined);
  h.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('notifySpaceDomainReleasedByEmail', () => {
  it('calls notifySpaceDomainReleased with the owner, Space name and domain', async () => {
    await notifySpaceDomainReleasedByEmail('owner-1', 'Team Space', 'example.org');

    expect(h.notifySpaceDomainReleased).toHaveBeenCalledWith(
      { ownerUserId: 'owner-1', spaceName: 'Team Space', domain: 'example.org' },
      expect.anything()
    );
  });

  it('threads userRepository as db.users', async () => {
    await notifySpaceDomainReleasedByEmail('owner-1', 'Team Space', 'example.org');

    const [, deps] = h.notifySpaceDomainReleased.mock.calls[0];
    expect(deps.db.users).toBe(h.users);
  });

  it('forwards an optional logger', async () => {
    const logger = { warn: vi.fn() };

    await notifySpaceDomainReleasedByEmail('owner-1', 'Team Space', 'example.org', logger);

    const [, deps] = h.notifySpaceDomainReleased.mock.calls[0];
    expect(deps.logger).toBe(logger);
  });

  it('hands the notifier the queued mailer rather than the SMTP mailer', async () => {
    await notifySpaceDomainReleasedByEmail('owner-1', 'Team Space', 'example.org');

    const [, deps] = h.notifySpaceDomainReleased.mock.calls[0];
    expect(deps.mailer).toBe(queuedMailer);
  });

  it('gives the notifier a mailer that publishes an email.send event', async () => {
    await notifySpaceDomainReleasedByEmail('owner-1', 'Team Space', 'example.org');
    const [, deps] = h.notifySpaceDomainReleased.mock.calls[0];

    await expect(
      deps.mailer.sendEmail('owner@example.org', {
        subject: 'Team Space no longer holds example.org',
        html: '<p>x</p>',
      })
    ).resolves.toEqual({ queued: true });

    expect(h.publish).toHaveBeenCalledExactlyOnceWith({
      to: 'owner@example.org',
      subject: 'Team Space no longer holds example.org',
      body: '<p>x</p>',
    });
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });
});
