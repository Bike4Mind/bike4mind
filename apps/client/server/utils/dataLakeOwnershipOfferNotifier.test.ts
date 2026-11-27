import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
  findUser: vi.fn(),
  findLake: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser },
  dataLakeRepository: { findById: h.findLake },
}));
// The real queuedMailer runs: the event bus is the seam, and the SMTP mailer must stay untouched.
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: h.smtpSendEmail } }));

import { sendLakeOwnershipOfferEmail } from './dataLakeOwnershipOfferNotifier';

const makeLogger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('B4M_SELF_HOST', 'false');
  h.findUser.mockResolvedValue({ email: 'member@example.org' });
  h.findLake.mockResolvedValue({ name: 'Research Lake' });
  h.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sendLakeOwnershipOfferEmail', () => {
  it('publishes the offer as an email.send event to the offered member', async () => {
    await sendLakeOwnershipOfferEmail({
      kind: 'offered',
      toUserId: 'member-1',
      dataLakeId: 'lake-1',
      counterpartName: 'Dana',
      expiresAt: new Date('2026-12-24T00:00:00.000Z'),
    });

    expect(h.findUser).toHaveBeenCalledWith('member-1');
    expect(h.findLake).toHaveBeenCalledWith('lake-1');
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'member@example.org',
        subject: 'You have been offered ownership of "Research Lake"',
        body: expect.stringContaining('Dana'),
      })
    );
    expect(h.publish.mock.calls[0][0].body).toContain('2026-12-24');
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['accepted', 'Ownership of "Research Lake" was accepted'],
    ['declined', 'Ownership offer for "Research Lake" was declined'],
  ] as const)('publishes the %s outcome to the offerer', async (kind, subject) => {
    await sendLakeOwnershipOfferEmail({ kind, toUserId: 'offerer-1', dataLakeId: 'lake-1' });

    expect(h.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: 'member@example.org', subject, body: expect.stringContaining('Research Lake') })
    );
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });

  it('skips and warns when the recipient has no address', async () => {
    h.findUser.mockResolvedValue({ email: null });
    const logger = makeLogger();

    await sendLakeOwnershipOfferEmail({ kind: 'offered', toUserId: 'member-1', dataLakeId: 'lake-1' }, { logger });

    expect(h.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no address for the recipient'), {
      kind: 'offered',
      toUserId: 'member-1',
      dataLakeId: 'lake-1',
    });
  });

  it('skips and warns when the data lake no longer exists', async () => {
    h.findLake.mockResolvedValue(null);
    const logger = makeLogger();

    await sendLakeOwnershipOfferEmail({ kind: 'offered', toUserId: 'member-1', dataLakeId: 'lake-1' }, { logger });

    expect(h.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no longer exists'), {
      kind: 'offered',
      dataLakeId: 'lake-1',
    });
  });

  it('never throws when the event cannot be queued', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
    h.publish.mockRejectedValue(new Error('bus unreachable'));

    await expect(
      sendLakeOwnershipOfferEmail({ kind: 'offered', toUserId: 'member-1', dataLakeId: 'lake-1' })
    ).resolves.toBeUndefined();

    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });

  it('warns and does not throw when a lookup fails', async () => {
    h.findUser.mockRejectedValue(new Error('db down'));
    const logger = makeLogger();

    await expect(
      sendLakeOwnershipOfferEmail({ kind: 'offered', toUserId: 'member-1', dataLakeId: 'lake-1' }, { logger })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ownership offer email failed'),
      expect.objectContaining({ toUserId: 'member-1' })
    );
    expect(h.publish).not.toHaveBeenCalled();
  });
});
