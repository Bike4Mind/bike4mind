import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userService } from '@bike4mind/services';
import { newSignupGrant } from '@bike4mind/common';
import {
  AdminSettings,
  CreditLot,
  CreditTransaction,
  User,
  creditTransactionRepository,
  mongoose,
  userRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

// Domain-burst protection is covered by its own suites; here it would only add a second hold.
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: undefined }));
import { releaseRiskReviewedSignupGrant } from './riskReviewGrantRelease';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const config: Record<string, string> = {
  stagedSignupGrantEnabled: 'true',
  signupGrantCredits: '12',
  verifiedUnlockCredits: '28',
  signupGrantRiskPolicy: JSON.stringify({
    enabled: true,
    version: 'synthetic',
    reducedAt: 4,
    reviewAt: 8,
    reducedFraction: 0.5,
    rules: [{ signal: 'datacenter', comparison: 'eq', threshold: 1, weight: 8, missing: 'review', missingWeight: 0 }],
  }),
};
const adminSettings = {
  findBySettingName: async (key: string) => (key in config ? { settingValue: config[key] } : null),
} as unknown as Parameters<typeof newSignupGrant>[0];

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await CreditLot.createCollection();
  await AdminSettings.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await CreditLot.collection.deleteMany({});
});

/** A verified account whose signup tranche the grant policy assessed into the review band. */
async function heldAccount(reviewState: 'pending' | 'approved' = 'pending') {
  const user = await User.create({
    username: 'synthetic-user',
    name: 'Synthetic User',
    email: 'user@example.test',
    emailVerified: true,
    signupGrant: await newSignupGrant(adminSettings),
  });
  await userService.grantFreeCredits(
    { id: user.id },
    {
      db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings },
      reason: 'synthetic signup',
      collectRiskSignals: async () => ({ datacenter: true }),
    }
  );
  await User.updateOne(
    { _id: user.id },
    { $set: { riskScore: { score: 0, signals: [], computedAt: new Date(), reviewState } } }
  );
  return user.id as string;
}

const audit = vi.fn(async () => undefined);
const release = (userId: string) => releaseRiskReviewedSignupGrant(userId, { reason: 'Looks legitimate', audit });

describe('releaseRiskReviewedSignupGrant', () => {
  beforeEach(() => audit.mockClear());

  it('pays the held tranche once, then leaves the unlock remainder to the usual unlocks', async () => {
    const userId = await heldAccount();
    const held = await User.findById(userId).lean();
    expect(held?.signupGrantAssessment?.band).toBe('review');
    expect(held?.signupGrant).toMatchObject({ stage: 'signup', creditsReleased: 0 });

    expect(await release(userId)).toBe(12);
    expect(await release(userId)).toBe(0);

    const paid = await User.findById(userId).lean();
    expect(paid?.currentCredits).toBe(12);
    expect(paid?.signupGrant).toMatchObject({ stage: 'signup', creditsReleased: 12 });
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ credits: 12 }));

    // The remainder still unlocks under its own ledger id.
    const unlocked = await userService.unlockSignupGrant(userId, 'activity', {
      db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings },
      reason: 'synthetic unlock',
      validators: { activity: async () => true },
    });
    expect(unlocked.creditsGranted).toBe(28);
    expect(await CreditTransaction.countDocuments({ ownerId: userId })).toBe(2);
  });

  it('pays nothing once the review is no longer pending', async () => {
    const userId = await heldAccount('approved');

    expect(await release(userId)).toBe(0);
    expect((await User.findById(userId).lean())?.currentCredits ?? 0).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });
});
