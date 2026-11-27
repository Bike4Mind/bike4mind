import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AccountDeletionNoticeModel,
  accountDeletionNoticeRepository as repo,
  ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

const h = vi.hoisted(() => ({ send: vi.fn<(email: string) => Promise<void | { FailedEntryCount: number }>>() }));
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: h.send }));
import { drainDeletionNotices, sendPendingDeletionNotice } from './accountDeletionNotice';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
const NOW = new Date();
const DUE = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
const LATER = new Date(NOW.getTime() + ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS);
const HASH = 'a'.repeat(64);
const EMAIL = 'leaving@example.test';
const logger = { warn: vi.fn(), error: vi.fn() };
const seed = () => repo.record({ idHash: HASH, email: EMAIL, now: NOW });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const loggedText = () => JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false, autoCreate: false });
  await AccountDeletionNoticeModel.createCollection();
  await AccountDeletionNoticeModel.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await AccountDeletionNoticeModel.deleteMany({});
  h.send.mockReset().mockResolvedValue(undefined);
  logger.warn.mockClear();
  logger.error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('real Mongo notice claims with a fake email transport', () => {
  it('publishes only once when two due drains overlap', async () => {
    await seed();
    const entered = deferred();
    const release = deferred();
    h.send.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const first = drainDeletionNotices({ logger, now: DUE });
    try {
      await entered.promise;
      const second = await drainDeletionNotices({ logger, now: DUE });
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ sent: 0, failed: 0, abandoned: 0 });
      expect(await repo.find(HASH)).not.toBeNull();
    } finally {
      release.resolve();
      await first;
    }
    expect(await repo.find(HASH)).toBeNull();
  });

  it('shares the immediate-send claim with a sweep and uses the first stored recipient', async () => {
    await seed();
    await repo.record({ idHash: HASH, email: 'replacement@example.test', now: NOW });
    const entered = deferred();
    const release = deferred();
    h.send.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const immediate = sendPendingDeletionNotice(HASH, { logger, now: DUE });
    try {
      await entered.promise;
      expect(await drainDeletionNotices({ logger, now: DUE })).toEqual({ sent: 0, failed: 0, abandoned: 0 });
      expect(h.send).toHaveBeenCalledExactlyOnceWith(EMAIL);
    } finally {
      release.resolve();
      await immediate;
    }
    expect(await repo.find(HASH)).toBeNull();
  });

  it.each(['throw', 'rejected-entry'] as const)(
    'retains and retries a %s failure only after it is due',
    async failure => {
      await seed();
      if (failure === 'throw') h.send.mockRejectedValueOnce(new Error(`transport failed for ${EMAIL}`));
      else h.send.mockResolvedValueOnce({ FailedEntryCount: 1 });
      expect(await drainDeletionNotices({ logger, now: NOW })).toEqual({ sent: 0, failed: 1, abandoned: 0 });
      const failed = await repo.find(HASH);
      expect(failed).toMatchObject({ attempts: 1, email: EMAIL, nextAttemptAt: LATER, createdAt: NOW });
      expect(loggedText()).not.toContain(EMAIL);
      expect(loggedText()).not.toContain(HASH);
      expect(loggedText()).not.toContain(failed?.leaseToken);
      vi.setSystemTime(new Date(LATER.getTime() - 1));
      expect(await drainDeletionNotices({ logger })).toEqual({ sent: 0, failed: 0, abandoned: 0 });
      expect(h.send).toHaveBeenCalledTimes(1);
      vi.setSystemTime(LATER);
      expect(await drainDeletionNotices({ logger })).toEqual({ sent: 1, failed: 0, abandoned: 0 });
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(await repo.find(HASH)).toBeNull();
    }
  );

  it('recovers a lost sender only after expiry without refreshing retention', async () => {
    await seed();
    const claim = await repo.claimDue(HASH, NOW);
    expect(claim?.createdAt).toEqual(NOW);
    expect(await drainDeletionNotices({ logger, now: NOW })).toEqual({ sent: 0, failed: 0, abandoned: 0 });
    expect(h.send).not.toHaveBeenCalled();
    vi.setSystemTime(LATER);
    expect(await drainDeletionNotices({ logger })).toEqual({ sent: 1, failed: 0, abandoned: 0 });
    expect(h.send).toHaveBeenCalledExactlyOnceWith(EMAIL);
  });

  it('does not send a sixth email after a crash between the fifth failure and cleanup', async () => {
    await seed();
    await AccountDeletionNoticeModel.updateOne({ idHash: HASH }, { $set: { attempts: 4 } });
    h.send.mockRejectedValueOnce(new Error('transport failed'));
    const remove = vi.spyOn(repo, 'remove').mockRejectedValueOnce(new Error('cleanup failed'));
    expect(await drainDeletionNotices({ logger, now: NOW })).toEqual({ sent: 0, failed: 1, abandoned: 0 });
    expect(await repo.find(HASH)).toMatchObject({ attempts: 5 });
    remove.mockRestore();
    vi.setSystemTime(LATER);
    expect(await drainDeletionNotices({ logger })).toEqual({ sent: 0, failed: 0, abandoned: 1 });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(await repo.find(HASH)).toBeNull();
  });

  it.each(['cleanup', 'failure-record'] as const)(
    'attempts each notice only once per drain after a long send and %s failure',
    async failure => {
      await seed();
      const secondHash = 'b'.repeat(64);
      const secondEmail = 'second@example.test';
      await repo.record({ idHash: secondHash, email: secondEmail, now: new Date(NOW.getTime() + 1) });
      h.send.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(LATER.getTime() + 1));
        if (failure === 'failure-record') throw new Error('transport failed');
      });
      if (failure === 'cleanup') vi.spyOn(repo, 'remove').mockRejectedValueOnce(new Error('cleanup failed'));
      else vi.spyOn(repo, 'markFailed').mockRejectedValueOnce(new Error('failure recording unavailable'));
      expect(await drainDeletionNotices({ logger, now: DUE })).toEqual({
        sent: failure === 'cleanup' ? 2 : 1,
        failed: failure === 'cleanup' ? 0 : 1,
        abandoned: 0,
      });
      expect(h.send.mock.calls.map(([email]) => email)).toEqual([EMAIL, secondEmail]);
      expect(await repo.find(HASH)).not.toBeNull();
      expect(await repo.find(secondHash)).toBeNull();
    }
  );

  it('keeps an accepted-but-uncleared notice leased, with an explicit later retry ambiguity', async () => {
    await seed();
    const remove = vi.spyOn(repo, 'remove').mockRejectedValueOnce(new Error('cleanup failed'));
    expect(await drainDeletionNotices({ logger, now: NOW })).toEqual({ sent: 1, failed: 0, abandoned: 0 });
    remove.mockRestore();
    expect(await drainDeletionNotices({ logger, now: NOW })).toEqual({ sent: 0, failed: 0, abandoned: 0 });
    vi.setSystemTime(LATER);
    expect(await drainDeletionNotices({ logger })).toEqual({ sent: 1, failed: 0, abandoned: 0 });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(await repo.find(HASH)).toBeNull();
  });
});
