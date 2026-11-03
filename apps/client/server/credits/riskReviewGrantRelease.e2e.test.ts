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

// Domain-burst protection is covered by its own suites; it is off unless a test installs a hold.
const protection = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@server/auth/signupProtection', () => ({
  get signupProtection() {
    return protection.current;
  },
}));
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
  protection.current = undefined;
  delete config.signupUnlockPaymentHoldHours;
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await CreditLot.collection.deleteMany({});
});

/**
 * A verified account scored at verification (reviewState from that rescore), whose signup tranche the
 * grant policy then assesses into the review band, as the domain-hold release and email change do.
 */
async function heldAccount(scoredState: 'none' | 'approved' = 'none', score = 5) {
  const user = await User.create({
    username: 'synthetic-user',
    name: 'Synthetic User',
    email: 'user@example.test',
    emailVerified: true,
    signupGrant: await newSignupGrant(adminSettings),
    riskScore: { score, signals: [], computedAt: new Date(), reviewState: scoredState },
  });
  await userService.grantFreeCredits(
    { id: user.id },
    {
      db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings },
      reason: 'synthetic signup',
      collectRiskSignals: async () => ({ datacenter: true }),
    }
  );
  return user.id as string;
}

const audit = vi.fn(async () => undefined);
const release = (userId: string) => releaseRiskReviewedSignupGrant(userId, { reason: 'Looks legitimate', audit });

describe('releaseRiskReviewedSignupGrant', () => {
  beforeEach(() => audit.mockClear());

  it('queues the held tranche for review, pays it once, then leaves the unlock remainder to the usual unlocks', async () => {
    const userId = await heldAccount();
    const held = await User.findById(userId).lean();
    expect(held?.signupGrantAssessment?.band).toBe('review');
    expect(held?.signupGrant).toMatchObject({ stage: 'signup', creditsReleased: 0 });
    expect(held?.riskScore).toMatchObject({ score: 5, reviewState: 'pending' });
    expect((await userRepository.findPendingRiskReviews(10)).map(user => user.id)).toEqual([userId]);

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

  it('keeps an earlier approval and pays nothing once the review is no longer pending', async () => {
    const userId = await heldAccount('approved');
    expect((await User.findById(userId).lean())?.riskScore?.reviewState).toBe('approved');

    expect(await release(userId)).toBe(0);
    expect((await User.findById(userId).lean())?.currentCredits ?? 0).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects and leaves the account pending and held when signup protection withholds the payout', async () => {
    const userId = await heldAccount();
    protection.current = {
      mode: 'observe',
      repository: {
        findReview: async () => ({ status: 'held_pending_review' }),
        isOrganizationDomain: async () => false,
      },
    };

    await expect(release(userId)).rejects.toThrow('still withheld');

    const after = await User.findById(userId).lean();
    expect(after?.riskScore?.reviewState).toBe('pending');
    expect(after?.signupGrant).toMatchObject({ stage: 'signup', creditsReleased: 0 });
    expect(after?.currentCredits ?? 0).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('a payment unlock that pays the held tranche', () => {
  const pay = (userId: string) => {
    config.signupUnlockPaymentHoldHours = '0';
    return userService.unlockSignupGrant(userId, 'card_verified', {
      db: { users: userRepository, creditTransactions: creditTransactionRepository, adminSettings },
      reason: 'synthetic card',
      validators: { card_verified: async () => true },
    });
  };

  it('takes an account whose score is below the review threshold out of the queue', async () => {
    const userId = await heldAccount('none', 5);
    expect((await User.findById(userId).lean())?.riskScore?.reviewState).toBe('pending');

    expect((await pay(userId)).creditsGranted).toBe(40);

    const after = await User.findById(userId).lean();
    expect(after?.riskScore).toMatchObject({ score: 5, reviewState: 'none' });
    expect(await userRepository.findPendingRiskReviews(10)).toEqual([]);
  });

  it('keeps an account whose score is at or above the review threshold pending', async () => {
    const userId = await heldAccount('none', 60);

    expect((await pay(userId)).creditsGranted).toBe(40);

    expect((await User.findById(userId).lean())?.riskScore).toMatchObject({ score: 60, reviewState: 'pending' });
  });
});
