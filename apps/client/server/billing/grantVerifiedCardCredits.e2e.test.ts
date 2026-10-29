import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mongoose, User, CreditTransaction, CreditGrantIdentityClaim, userRepository } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { CardVerification } from './cardVerificationModel';
import { grantVerifiedCardCredits } from './grantVerifiedCardCredits';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await CreditGrantIdentityClaim.createIndexes();
  await CardVerification.createIndexes();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    User.deleteMany({}),
    CreditTransaction.deleteMany({}),
    CreditGrantIdentityClaim.deleteMany({}),
    CardVerification.deleteMany({}),
  ]);
});

async function seed(verificationId: string, identityDigest = 'a'.repeat(64)) {
  const user = await User.create({ username: verificationId, name: 'Synthetic User', currentCredits: 3 });
  await CardVerification.create({
    verificationId,
    userId: user.id,
    environment: 'test',
    livemode: false,
    credits: 17,
    saveCard: false,
    state: 'verified',
    detached: true,
    identityDigest,
  });
  return user;
}
const eligible = async () => true;

describe('verified card grant transaction', () => {
  it('commits one promotional row and balance under concurrent replays', async () => {
    const user = await seed('synthetic-verification');
    const results = await Promise.all(
      Array.from({ length: 4 }, () => grantVerifiedCardCredits('synthetic-verification', user.id, eligible))
    );
    expect(results.filter(result => result === 'granted')).toHaveLength(1);
    expect((await User.findById(user.id))?.currentCredits).toBe(20);
    const row = await CreditTransaction.findOne({ transactionId: `unlock-grant:card_verified:${user.id}` }).lean();
    expect(row).toMatchObject({ credits: 17, type: 'generic_add', reason: 'card_verified' });
    expect(await CreditTransaction.countDocuments()).toBe(1);
    expect((await CardVerification.findOne({ userId: user.id }))?.state).toBe('granted');
  });

  it('allows only one account to receive the same identity grant', async () => {
    const first = await seed('synthetic-first');
    const second = await seed('synthetic-second');
    const results = await Promise.all([
      grantVerifiedCardCredits('synthetic-first', first.id, eligible),
      grantVerifiedCardCredits('synthetic-second', second.id, eligible),
    ]);
    expect(results.sort()).toEqual(['granted', 'refused']);
    expect(await CreditTransaction.countDocuments()).toBe(1);
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(1);
  });

  it('rolls back ledger and state on balance failure and recovers the permanent claim', async () => {
    const user = await seed('synthetic-recovery');
    vi.spyOn(userRepository, 'incrementCredits').mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(grantVerifiedCardCredits('synthetic-recovery', user.id, eligible)).rejects.toThrow(
      'synthetic write failure'
    );
    expect(await CreditTransaction.countDocuments()).toBe(0);
    expect((await User.findById(user.id))?.currentCredits).toBe(3);
    expect((await CardVerification.findOne({ userId: user.id }))?.state).toBe('verified');
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(1);
    expect(await grantVerifiedCardCredits('synthetic-recovery', user.id, eligible)).toBe('granted');
    expect(await grantVerifiedCardCredits('synthetic-recovery', user.id, eligible)).toBe('already_granted');
  });

  it('does not let a second identity stack a grant for one account', async () => {
    const user = await seed('synthetic-one');
    await grantVerifiedCardCredits('synthetic-one', user.id, eligible);
    await CardVerification.create({
      verificationId: 'synthetic-two',
      userId: user.id,
      environment: 'test',
      livemode: false,
      credits: 17,
      saveCard: false,
      state: 'verified',
      detached: true,
      identityDigest: 'b'.repeat(64),
    });
    expect(await grantVerifiedCardCredits('synthetic-two', user.id, eligible)).toBe('refused');
    expect((await User.findById(user.id))?.currentCredits).toBe(20);
  });

  it('refuses unapproved and newly ineligible accounts', async () => {
    const user = await seed('synthetic-refused');
    await expect(grantVerifiedCardCredits('synthetic-refused', 'synthetic-other', eligible)).rejects.toThrow(
      'not been approved'
    );
    await expect(grantVerifiedCardCredits('synthetic-refused', user.id, async () => false)).rejects.toThrow(
      'not eligible'
    );
    expect(await CreditTransaction.countDocuments()).toBe(0);
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(0);
  });
});
