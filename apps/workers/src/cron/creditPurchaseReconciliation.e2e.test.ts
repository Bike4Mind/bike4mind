import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { CreditHolderType, CreditPurchaseStatus } from '@bike4mind/common';
import { CreditTransaction, User, creditTransactionRepository, userRepository } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

const mockList = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  isStripeConfigured: () => true,
  stripe: { paymentIntents: { list: (...args: unknown[]) => mockList(...args) } },
}));
const mockPostMessageToSlack = vi.fn();
vi.mock('@server/integrations/slack/slack', () => ({
  postMessageToSlack: (...args: unknown[]) => mockPostMessageToSlack(...args),
}));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetric: vi.fn() }));

import { runCreditPurchaseReconciliation } from './creditPurchaseReconciliation';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let mongo: Awaited<ReturnType<typeof createMongoServer>>;
const adapters = { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository };

async function seedUser() {
  const user = await User.create({
    username: `reconcile-${new mongoose.Types.ObjectId()}`,
    name: 'Reconciliation fixture',
    currentCredits: 100,
  });
  return String(user._id);
}

const purchase = (userId: string, paymentIntentId: string) =>
  creditService.addCredits(
    {
      type: 'purchase',
      ownerId: userId,
      ownerType: CreditHolderType.User,
      amount: 1000,
      credits: 5000,
      status: CreditPurchaseStatus.Completed,
      stripePaymentIntentId: paymentIntentId,
    },
    adapters
  );

function stripeReturns(userId: string, ...ids: string[]) {
  mockList.mockResolvedValue({
    data: ids.map(id => ({
      id,
      status: 'succeeded',
      amount: 1000,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      metadata: { environment: 'test', credits: '5000', userId },
    })),
    has_more: false,
  });
}

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop({ doCleanup: false });
});

describe('credit purchase reconciliation against the real ledger', () => {
  it('flags a purchase whose row committed but whose balance increment failed', async () => {
    const userId = await seedUser();
    vi.spyOn(userRepository, 'incrementCredits').mockRejectedValueOnce(new Error('fixture increment failure'));
    await expect(purchase(userId, 'pi_drifted')).rejects.toThrow('fixture increment failure');

    expect(await CreditTransaction.countDocuments({ stripePaymentIntentId: 'pi_drifted' })).toBe(1);
    expect((await User.findById(userId).lean())?.currentCredits).toBe(100);

    stripeReturns(userId, 'pi_drifted');
    const result = await runCreditPurchaseReconciliation();

    expect(result.ungranted).toEqual([
      expect.objectContaining({ paymentIntentId: 'pi_drifted', reason: 'balance_not_applied', userId }),
    ]);
    expect(mockPostMessageToSlack.mock.calls[0][0]).toContain('transaction recorded but balance never credited');
  });

  it('does not flag a purchase whose balance was credited', async () => {
    const userId = await seedUser();
    await purchase(userId, 'pi_applied');
    expect((await User.findById(userId).lean())?.currentCredits).toBe(5100);

    stripeReturns(userId, 'pi_applied');
    const result = await runCreditPurchaseReconciliation();

    expect(result).toMatchObject({ checked: 1, ungranted: [] });
    expect(mockPostMessageToSlack).not.toHaveBeenCalled();
  });

  // Same addCredits call as the admin credit-adjustment path (userService/adminUpdate.ts): it heals
  // the balance but is not a purchase, so it leaves lastCreditsPurchasedAt unset.
  it('keeps flagging after an admin adjustment heals the balance', async () => {
    const userId = await seedUser();
    vi.spyOn(userRepository, 'incrementCredits').mockRejectedValueOnce(new Error('fixture increment failure'));
    await expect(purchase(userId, 'pi_healed')).rejects.toThrow();
    await creditService.addCredits(
      {
        type: 'generic_add',
        reason: 'admin_adjustment',
        ownerId: userId,
        ownerType: CreditHolderType.User,
        credits: 5000,
        description: 'Admin credit adjustment',
      },
      adapters
    );
    expect((await User.findById(userId).lean())?.currentCredits).toBe(5100);

    stripeReturns(userId, 'pi_healed');
    const result = await runCreditPurchaseReconciliation();

    expect(result.ungranted).toEqual([expect.objectContaining({ reason: 'balance_not_applied' })]);
  });
});
