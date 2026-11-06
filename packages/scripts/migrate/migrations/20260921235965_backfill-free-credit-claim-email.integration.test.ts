import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { CreditTransaction, safeDropIndex, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235965_backfill-free-credit-claim-email';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await User.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  // Start from a deployment the migration has not run on yet.
  await safeDropIndex(User.collection, 'freeCreditClaimEmail_1');
});

const seedUser = async (email: string, freeCreditClaimEmail?: string) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `u-${_id}`,
    name: 'fixture',
    email,
    ...(freeCreditClaimEmail ? { freeCreditClaimEmail } : {}),
  });
  return String(_id);
};
const seedGrant = (ownerId: string, transactionId: string, day: number) =>
  CreditTransaction.collection.insertOne({
    ownerId,
    ownerType: 'User',
    transactionId,
    credits: 100,
    createdAt: new Date(Date.UTC(2026, 0, day)),
  });
const claimOf = async (id: string) =>
  (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.freeCreditClaimEmail;

// Real mongod: the migration relies on the prefix-regex scan, the raw bulk writes and the unique
// index rejecting a second claim on one inbox.
describe('backfill-free-credit-claim-email migration (real DB)', () => {
  it('claims each inbox for its earliest grant, clears duplicate claims and enforces the index', async () => {
    const first = await seedUser('x.y@gmail.com');
    const alias = await seedUser('xy+1@gmail.com');
    const legacy = await seedUser('solo@example.com');
    const ungranted = await seedUser('nobody@example.com');
    const runtimeA = await seedUser('ab+1@gmail.com', 'ab@gmail.com');
    const runtimeB = await seedUser('ab+2@gmail.com', 'ab@gmail.com');
    await seedGrant(alias, `verify-grant:${alias}`, 2);
    await seedGrant(first, `verify-grant:${first}`, 1);
    await seedGrant(legacy, `otc-register-grant:${legacy}`, 3);
    await seedGrant(ungranted, `admin-adjust:${ungranted}`, 1);
    await seedGrant(runtimeA, `verify-grant:${runtimeA}`, 4);
    await seedGrant(runtimeB, `verify-grant:${runtimeB}`, 5);

    await migration.up();

    expect(await claimOf(first)).toBe('xy@gmail.com');
    expect(await claimOf(alias)).toBeUndefined();
    expect(await claimOf(legacy)).toBe('solo@example.com');
    expect(await claimOf(ungranted)).toBeUndefined();
    expect(await claimOf(runtimeA)).toBe('ab@gmail.com');
    expect(await claimOf(runtimeB)).toBeUndefined();

    await expect(
      User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(alias) },
        { $set: { freeCreditClaimEmail: 'xy@gmail.com' } }
      )
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('is idempotent', async () => {
    const id = await seedUser('x@gmail.com');
    await seedGrant(id, `verify-grant:${id}`, 1);

    await migration.up();
    await migration.up();

    expect(await claimOf(id)).toBe('x@gmail.com');
  });
});
