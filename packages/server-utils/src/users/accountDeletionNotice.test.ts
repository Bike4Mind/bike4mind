import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the outbox collection, so the keep-until-sent behaviour is observable.
const h = vi.hoisted(() => ({
  store: new Map<string, { idHash: string; email: string; attempts: number; nextAttemptAt: Date }>(),
  send: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  accountDeletionNoticeRepository: {
    listDue: async (now: Date, limit: number) =>
      [...h.store.values()].filter(n => n.nextAttemptAt <= now).slice(0, limit),
    markFailed: async (idHash: string, nextAttemptAt: Date) => {
      const notice = h.store.get(idHash);
      if (!notice) return null;
      notice.attempts++;
      notice.nextAttemptAt = nextAttemptAt;
      return notice.attempts;
    },
    remove: async (idHash: string) => {
      h.store.delete(idHash);
    },
  },
}));
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: h.send }));

import { drainDeletionNotices, sendPendingDeletionNotice } from './accountDeletionNotice';

const EMAIL = 'leaving@example.com';
const HASH = 'a'.repeat(64);
const NOW = new Date('2026-11-04T05:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const logger = { warn: vi.fn(), error: vi.fn() };
const seed = () => h.store.set(HASH, { idHash: HASH, email: EMAIL, attempts: 0, nextAttemptAt: NOW });
const loggedText = () => JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);

beforeEach(() => {
  vi.clearAllMocks();
  h.store.clear();
  h.send.mockResolvedValue(undefined);
  seed();
});

describe('sendPendingDeletionNotice', () => {
  it('removes the notice after a successful send', async () => {
    await expect(sendPendingDeletionNotice(HASH, EMAIL, { logger, now: NOW })).resolves.toBe('sent');
    expect(h.send).toHaveBeenCalledWith(EMAIL);
    expect(h.store.has(HASH)).toBe(false);
  });

  it('keeps the address after a failed send, counts the attempt and does not throw', async () => {
    h.send.mockRejectedValueOnce(new Error(`bus down for ${EMAIL}`));

    await expect(sendPendingDeletionNotice(HASH, EMAIL, { logger, now: NOW })).resolves.toBe('failed');

    expect(h.store.get(HASH)).toMatchObject({ email: EMAIL, attempts: 1 });
    expect(loggedText()).not.toContain(EMAIL);
  });
});

describe('drainDeletionNotices', () => {
  it('retries a notice whose first send failed, and clears it once that succeeds', async () => {
    h.send.mockRejectedValueOnce(new Error('bus down'));
    await sendPendingDeletionNotice(HASH, EMAIL, { logger, now: NOW });
    expect(h.store.get(HASH)?.attempts).toBe(1);

    const result = await drainDeletionNotices({ logger, now: new Date(NOW.getTime() + DAY) });

    expect(result).toEqual({ sent: 1, failed: 0, abandoned: 0 });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.store.has(HASH)).toBe(false);
  });

  it('leaves a notice that is not due yet', async () => {
    h.send.mockRejectedValueOnce(new Error('bus down'));
    await sendPendingDeletionNotice(HASH, EMAIL, { logger, now: NOW });

    await expect(drainDeletionNotices({ logger, now: NOW })).resolves.toEqual({ sent: 0, failed: 0, abandoned: 0 });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last allowed attempt, removing the address and logging no PII', async () => {
    h.send.mockRejectedValue(new Error(`rejected ${EMAIL}`));
    let now = NOW;
    await sendPendingDeletionNotice(HASH, EMAIL, { logger, now, maxAttempts: 3 });
    for (let day = 1; day <= 2; day++) {
      now = new Date(NOW.getTime() + day * DAY);
      const result = await drainDeletionNotices({ logger, now, maxAttempts: 3 });
      expect(result).toEqual(day === 2 ? { sent: 0, failed: 0, abandoned: 1 } : { sent: 0, failed: 1, abandoned: 0 });
    }

    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.store.has(HASH)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain(EMAIL);
  });

  it('keeps going past one failing notice', async () => {
    h.store.set('b', { idHash: 'b', email: 'b@example.com', attempts: 0, nextAttemptAt: NOW });
    h.send.mockRejectedValueOnce(new Error('bus down'));

    const result = await drainDeletionNotices({ logger, now: NOW });

    expect(result).toEqual({ sent: 1, failed: 1, abandoned: 0 });
  });
});
