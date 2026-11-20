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
const record = (idHash = 'h1') => repo.record({ idHash, email: 'first@example.com', now: NOW });

describe('accountDeletionNoticeRepository', () => {
  it('keeps the first notice, retry state, and original TTL timestamp on a repeated record', async () => {
    await record();
    const claim = await repo.claimDue('h1', NOW, NOW);
    if (!claim) throw new Error('Fixture did not acquire notice');
    await repo.markFailed('h1', claim.leaseToken, LATER);
    await repo.record({ idHash: 'h1', email: 'second@example.com', now: LATER });
    expect(await repo.find('h1')).toMatchObject({
      email: 'first@example.com',
      attempts: 1,
      createdAt: NOW,
      nextAttemptAt: LATER,
    });
    expect(await AccountDeletionNoticeModel.countDocuments()).toBe(1);
  });

  it('is due immediately, but only one concurrent claimant can acquire it', async () => {
    await record();
    expect(await repo.listDue(NOW, 10)).toHaveLength(1);
    const claims = await Promise.all(Array.from({ length: 10 }, () => repo.claimDue('h1', NOW, NOW)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.leaseExpiresAt).toEqual(LATER);
  });

  it('reclaims an expired lease without extending the original retention timestamp', async () => {
    await record();
    const first = await repo.claimDue('h1', NOW, NOW);
    expect(await repo.claimDue('h1', LATER, new Date(LATER.getTime() - 1))).toBeNull();
    const second = await repo.claimDue('h1', LATER, LATER);
    expect(second).not.toBeNull();
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    expect(second?.createdAt).toEqual(NOW);
  });

  it('does not let a stale sender delete or count a failure against a successor', async () => {
    await record();
    const first = await repo.claimDue('h1', NOW, NOW);
    const second = await repo.claimDue('h1', LATER, LATER);
    if (!first || !second) throw new Error('Fixture did not acquire both generations');
    expect(await repo.markFailed('h1', first.leaseToken, new Date(LATER.getTime() + 1))).toBeNull();
    await repo.remove('h1', first.leaseToken);
    expect(await repo.find('h1')).toMatchObject({ attempts: 0, leaseToken: second.leaseToken, nextAttemptAt: NOW });
    await repo.remove('h1', second.leaseToken);
    expect(await repo.find('h1')).toBeNull();
  });

  it('retains the ownership token through failure and removes only that owner at exhaustion', async () => {
    await record();
    const claim = await repo.claimDue('h1', NOW, NOW);
    if (!claim) throw new Error('Fixture did not acquire notice');
    expect(await repo.markFailed('h1', claim.leaseToken, LATER)).toBe(1);
    expect(await repo.markFailed('h1', claim.leaseToken, LATER)).toBe(2);
    expect(await repo.find('h1')).toMatchObject({ leaseToken: claim.leaseToken, leaseExpiresAt: LATER });
    await repo.remove('h1', claim.leaseToken);
    expect(await repo.markFailed('h1', claim.leaseToken, LATER)).toBeNull();
  });

  it('does not let active leases starve an available row beyond the first 200 due records', async () => {
    await AccountDeletionNoticeModel.insertMany(
      Array.from({ length: 200 }, (_, index) => ({
        idHash: `leased-${index}`,
        email: 'held@example.com',
        attempts: 0,
        nextAttemptAt: new Date(NOW.getTime() - 1),
        createdAt: NOW,
        leaseToken: `held-${index}`,
        leaseExpiresAt: LATER,
      }))
    );
    await record('available');
    expect((await repo.claimNextDue(NOW, NOW))?.idHash).toBe('available');
    expect(await repo.claimNextDue(NOW, NOW)).toBeNull();
  });

  it('uses fresh lease time independently of a fixed due cutoff and supports legacy unleased rows', async () => {
    await record();
    const claim = await repo.claimNextDue(NOW, LATER);
    expect(claim?.leaseExpiresAt).toEqual(new Date(LATER.getTime() + ACCOUNT_DELETION_NOTICE_RETRY_DELAY_MS));
    expect(claim?.createdAt).toEqual(NOW);
  });

  it('lists due rows oldest first without _id', async () => {
    await repo.record({ idHash: 'old', email: 'a@example.com', now: new Date(NOW.getTime() - 2 * 86400000) });
    await repo.record({ idHash: 'mid', email: 'b@example.com', now: new Date(NOW.getTime() - 86400000) });
    await repo.record({ idHash: 'new', email: 'c@example.com', now: NOW });
    const due = await repo.listDue(LATER, 10);
    expect(due.map(row => row.idHash)).toEqual(['old', 'mid', 'new']);
    expect(due[0]).not.toHaveProperty('_id');
    expect(await repo.listDue(LATER, 2)).toHaveLength(2);
  });

  it('preserves the unique hash index and original createdAt TTL', async () => {
    const indexes = await AccountDeletionNoticeModel.collection.indexes();
    expect(indexes.find(index => index.key.idHash === 1)?.unique).toBe(true);
    expect(indexes.find(index => index.key.createdAt === 1)?.expireAfterSeconds).toBe(
      ACCOUNT_DELETION_NOTICE_TTL_SECONDS
    );
  });
});
