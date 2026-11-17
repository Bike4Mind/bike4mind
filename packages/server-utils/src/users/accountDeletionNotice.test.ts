import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type NoticeFixture = {
  idHash: string;
  email: string;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  leaseToken?: string;
  leaseExpiresAt?: Date;
};

// In-memory stand-in for the outbox collection, so the keep-until-sent behaviour is observable.
const h = vi.hoisted(() => ({
  store: new Map<string, NoticeFixture>(),
  send: vi.fn(),
  sequence: 0,
  // Repository faults, keyed by operation: set a key to make that call reject.
  fault: {} as { claim?: boolean; markFailed?: boolean; remove?: boolean },
}));
vi.mock('@bike4mind/database', () => {
  const claim = (idHash: string | undefined, dueBefore: Date, excludedIdHashes: readonly string[] = []) => {
    if (h.fault.claim) throw new Error('db down');
    const now = new Date();
    const notice = [...h.store.values()]
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .find(
        row =>
          (idHash === undefined || row.idHash === idHash) &&
          !excludedIdHashes.includes(row.idHash) &&
          row.nextAttemptAt <= dueBefore &&
          (!row.leaseExpiresAt || row.leaseExpiresAt <= now)
      );
    if (!notice) return null;
    notice.leaseToken = `claim-${++h.sequence}`;
    notice.leaseExpiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    return { ...notice };
  };
  return {
    ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS: 60 * 60 * 1000,
    accountDeletionNoticeRepository: {
      claimDue: async (idHash: string, now: Date) => claim(idHash, now),
      claimNextDue: async (now: Date, _leaseNow: Date, excludedIdHashes: readonly string[]) =>
        claim(undefined, now, excludedIdHashes),
      markFailed: async (idHash: string, leaseToken: string, nextAttemptAt: Date) => {
        if (h.fault.markFailed) throw new Error('db down');
        const notice = h.store.get(idHash);
        if (!notice || notice.leaseToken !== leaseToken) return null;
        notice.attempts++;
        notice.nextAttemptAt = nextAttemptAt;
        notice.leaseExpiresAt = nextAttemptAt;
        return notice.attempts;
      },
      remove: async (idHash: string, leaseToken: string) => {
        if (h.fault.remove) throw new Error('db down');
        if (h.store.get(idHash)?.leaseToken === leaseToken) h.store.delete(idHash);
      },
    },
  };
});
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: h.send }));

import { drainDeletionNotices, sendPendingDeletionNotice } from './accountDeletionNotice';

const EMAIL = 'leaving@example.com';
const HASH = 'a'.repeat(64);
const NOW = new Date('2026-11-04T05:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const logger = { warn: vi.fn(), error: vi.fn() };
const seed = () => h.store.set(HASH, { idHash: HASH, email: EMAIL, attempts: 0, nextAttemptAt: NOW, createdAt: NOW });
// Every argument of every call, Errors by name and message, as the real Logger writes them.
const loggedText = () =>
  [...logger.warn.mock.calls, ...logger.error.mock.calls]
    .flat()
    .map(arg => (arg instanceof Error ? `${arg.name}: ${arg.message}` : JSON.stringify(arg)))
    .join('\n');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.sequence = 0;
  h.store.clear();
  h.fault = {};
  h.send.mockReset().mockResolvedValue(undefined);
  seed();
});

afterEach(() => vi.useRealTimers());

describe('sendPendingDeletionNotice', () => {
  it('removes the notice after a successful send', async () => {
    await expect(sendPendingDeletionNotice(HASH, { logger, now: NOW })).resolves.toBe('sent');
    expect(h.send).toHaveBeenCalledWith(EMAIL);
    expect(h.store.has(HASH)).toBe(false);
  });

  it('keeps the address after a failed send, counts the attempt and does not throw', async () => {
    h.send.mockRejectedValueOnce(new Error(`bus down for ${EMAIL}`));

    await expect(sendPendingDeletionNotice(HASH, { logger, now: NOW })).resolves.toBe('failed');

    expect(h.store.get(HASH)).toMatchObject({ email: EMAIL, attempts: 1 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain(EMAIL);
  });

  it('treats a rejected PutEvents entry as a failed send and keeps the address', async () => {
    h.send.mockResolvedValueOnce({ FailedEntryCount: 1 });

    await expect(sendPendingDeletionNotice(HASH, { logger, now: NOW })).resolves.toBe('failed');

    expect(h.store.get(HASH)).toMatchObject({ email: EMAIL, attempts: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EntryRejected'));
  });

  it('does not count unclaimed work or expose recipient data after a claim error', async () => {
    h.fault.claim = true;
    await expect(sendPendingDeletionNotice(HASH, { logger, now: NOW })).resolves.toBeNull();
    await expect(drainDeletionNotices({ logger, now: NOW })).resolves.toEqual({ sent: 0, failed: 0, abandoned: 0 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.store.has(HASH)).toBe(true);
    expect(loggedText()).not.toContain(EMAIL);
    expect(loggedText()).not.toContain(HASH);
  });

  it('does not send or count an unclaimed notice when it is already gone', async () => {
    h.store.clear();
    h.send.mockRejectedValueOnce(new Error('bus down'));

    await expect(sendPendingDeletionNotice(HASH, { logger, now: NOW })).resolves.toBeNull();

    expect(h.send).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a PII-free warn and returns failed when recording the failure throws', async () => {
    h.send.mockRejectedValueOnce(new Error(`bus down for ${EMAIL}`));
    h.fault.markFailed = true;

    await expect(sendPendingDeletionNotice(HASH, { logger, now: NOW })).resolves.toBe('failed');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain(EMAIL);
    expect(loggedText()).not.toContain(HASH);
    expect(h.store.get(HASH)).toMatchObject({ email: EMAIL, attempts: 0 });
  });

  it('returns failed with a remove error when the give-up delete throws', async () => {
    h.send.mockRejectedValueOnce(new Error('bus down'));
    h.fault.remove = true;

    await expect(sendPendingDeletionNotice(HASH, { logger, now: NOW, maxAttempts: 1 })).resolves.toBe('failed');

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Could not remove'));
    expect(h.store.has(HASH)).toBe(true);
  });

  it('still reports sent, without throwing, when clearing the notice fails after a send', async () => {
    h.fault.remove = true;

    await expect(sendPendingDeletionNotice(HASH, { logger, now: NOW })).resolves.toBe('sent');
  });
});

describe('drainDeletionNotices', () => {
  it('retries a notice whose first send failed, and clears it once that succeeds', async () => {
    h.send.mockRejectedValueOnce(new Error('bus down'));
    await sendPendingDeletionNotice(HASH, { logger, now: NOW });
    expect(h.store.get(HASH)?.attempts).toBe(1);

    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    const result = await drainDeletionNotices({ logger, now: new Date(NOW.getTime() + DAY) });

    expect(result).toEqual({ sent: 1, failed: 0, abandoned: 0 });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.store.has(HASH)).toBe(false);
  });

  it('leaves a notice that is not due yet', async () => {
    h.send.mockRejectedValueOnce(new Error('bus down'));
    await sendPendingDeletionNotice(HASH, { logger, now: NOW });

    await expect(drainDeletionNotices({ logger, now: NOW })).resolves.toEqual({ sent: 0, failed: 0, abandoned: 0 });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last allowed attempt, removing the address and logging no PII', async () => {
    h.send.mockRejectedValue(new Error(`rejected ${EMAIL}`));
    let now = NOW;
    await sendPendingDeletionNotice(HASH, { logger, now, maxAttempts: 3 });
    for (let day = 1; day <= 2; day++) {
      now = new Date(NOW.getTime() + day * DAY);
      vi.setSystemTime(now);
      const result = await drainDeletionNotices({ logger, now, maxAttempts: 3 });
      expect(result).toEqual(day === 2 ? { sent: 0, failed: 0, abandoned: 1 } : { sent: 0, failed: 1, abandoned: 0 });
    }

    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.store.has(HASH)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain(EMAIL);
  });

  it('keeps going past one failing notice', async () => {
    h.store.set('b', { idHash: 'b', email: 'b@example.com', attempts: 0, nextAttemptAt: NOW, createdAt: NOW });
    h.send.mockRejectedValueOnce(new Error('bus down'));

    const result = await drainDeletionNotices({ logger, now: NOW });

    expect(result).toEqual({ sent: 1, failed: 1, abandoned: 0 });
  });
});
