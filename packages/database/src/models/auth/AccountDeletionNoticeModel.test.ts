import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import {
  ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS,
  ACCOUNT_DELETION_NOTICE_TTL_SECONDS,
  AccountDeletionNoticeModel,
  accountDeletionNoticeRepository as repo,
} from './AccountDeletionNoticeModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await AccountDeletionNoticeModel.init();
}, MONGO_TEST_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await AccountDeletionNoticeModel.deleteMany({});
});

const NOW = new Date('2026-11-17T00:00:00.000Z');
const LATER = new Date(NOW.getTime() + ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS);

describe('accountDeletionNoticeRepository', () => {
  it('keeps the first notice when the same idHash is recorded again', async () => {
    await repo.record({ idHash: 'h1', email: 'first@example.com', now: NOW });
    await repo.markFailed('h1', LATER);
    await repo.record({ idHash: 'h1', email: 'second@example.com', now: LATER });

    expect(await repo.find('h1')).toMatchObject({ email: 'first@example.com', attempts: 1 });
    expect(await AccountDeletionNoticeModel.countDocuments()).toBe(1);
  });

  it('is not due until the retry delay has passed', async () => {
    await repo.record({ idHash: 'h1', email: 'a@example.com', now: NOW });

    expect(await repo.listDue(NOW, 10)).toEqual([]);
    expect(await repo.listDue(LATER, 10)).toHaveLength(1);
  });

  it('markFailed returns the new attempt count, then null once the notice is gone', async () => {
    await repo.record({ idHash: 'h1', email: 'a@example.com', now: NOW });

    expect(await repo.markFailed('h1', LATER)).toBe(1);
    expect(await repo.markFailed('h1', LATER)).toBe(2);
    await repo.remove('h1');
    expect(await repo.markFailed('h1', LATER)).toBeNull();
  });

  it('lists only due notices, oldest first, without _id', async () => {
    await repo.record({ idHash: 'old', email: 'a@example.com', now: new Date(NOW.getTime() - 2 * 86400000) });
    await repo.record({ idHash: 'mid', email: 'b@example.com', now: new Date(NOW.getTime() - 86400000) });
    await repo.record({ idHash: 'new', email: 'c@example.com', now: NOW });

    const due = await repo.listDue(LATER, 10);

    expect(due.map(n => n.idHash)).toEqual(['old', 'mid', 'new']);
    expect(due[0]).not.toHaveProperty('_id');
    expect(await repo.listDue(LATER, 2)).toHaveLength(2);
  });

  it('remove deletes the notice', async () => {
    await repo.record({ idHash: 'h1', email: 'a@example.com', now: NOW });
    await repo.remove('h1');

    expect(await repo.find('h1')).toBeNull();
  });

  it('has a unique idHash index and a createdAt TTL index', async () => {
    const indexes = await AccountDeletionNoticeModel.collection.indexes();

    expect(indexes.find(i => i.key.idHash === 1)?.unique).toBe(true);
    expect(indexes.find(i => i.key.createdAt === 1)?.expireAfterSeconds).toBe(ACCOUNT_DELETION_NOTICE_TTL_SECONDS);
  });
});
