import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Resource } from 'sst';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { PAID_PLAN_ENTITLEMENT_KEY, type PurchaseReversalReason } from '@bike4mind/common';
import { CreditTransaction, User, userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { getUserEntitlements, toEntitlementUser } from '@server/entitlements';
import { hasPurchasedCredits } from '@server/entitlements/paidStanding';
import { resolveUserRateTier } from '@server/utils/userRateTier';
import { grantCreditPurchase } from './grantCreditPurchase';
import { reversePurchaseStanding } from './purchaseReversal';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
vi.mock('@server/integrations/slack/subscriptionLifecycle', () => ({ adminOwnerSlackRef: () => 'user' }));
// vitest.setup.ts mocks sst without a websocket resource; extend that mock rather than replace it.
Object.assign(Resource, { websocket: { managementEndpoint: 'wss://ws.example.com' } });
vi.mock('@client/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [],
  SUBSCRIPTION_PLANS_MAP: {},
  TEAM_PLAN: { priceId: 'price_team', tier: 2 },
}));

// Purchases are seeded through the real grant (ledger row + stamp as production writes them), so the
// reversal is proven against the rows the webhook actually leaves behind.

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await CreditTransaction.createIndexes();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const seedBuyer = async () =>
  (
    await User.create({
      name: 'Buyer',
      username: `buyer-${Math.random().toString(36).slice(2, 10)}`,
      password: null,
      hasUsablePassword: false,
      currentCredits: 100,
    })
  ).id as string;

const buy = (userId: string, paymentIntentId: string) =>
  grantCreditPurchase({
    userId,
    paymentIntentId,
    credits: 500,
    amount: 999,
    packageId: 'pkg_1',
    environment: 'test',
    paymentMethod: 'card',
  });

const reverse = (paymentIntentId: string, reason: PurchaseReversalReason) =>
  reversePurchaseStanding({ paymentIntentId, reason }, logger);

const standingOf = async (userId: string) => {
  const user = await userRepository.findById(userId);
  if (!user) throw new Error(`user ${userId} missing`);
  return {
    purchased: hasPurchasedCredits(user),
    paidPlan: (await getUserEntitlements(toEntitlementUser(user))).includes(PAID_PLAN_ENTITLEMENT_KEY),
    tier: await resolveUserRateTier(user),
  };
};

const PAID = { purchased: true, paidPlan: true, tier: 'basic' };
const FREE = { purchased: false, paidPlan: false, tier: 'free' };

describe('reversePurchaseStanding on a real replica set', () => {
  it.each<[string, PurchaseReversalReason]>([
    ['a full refund', 'refunded'],
    ['a lost dispute', 'dispute_lost'],
  ])('drops a single-purchase buyer back to free standing after %s', async (_label, reason) => {
    const userId = await seedBuyer();
    await buy(userId, 'pi_only');
    expect(await standingOf(userId)).toEqual(PAID);

    expect(await reverse('pi_only', reason)).toBe('revoked');

    expect(await standingOf(userId)).toEqual(FREE);
    const row = await CreditTransaction.findOne({ stripePaymentIntentId: 'pi_only' }).lean();
    expect(row).toMatchObject({ reversalReason: reason, reversedAt: expect.any(Date) });
  });

  it('keeps paid standing through a partial refund, which never marks the purchase', async () => {
    const userId = await seedBuyer();
    await buy(userId, 'pi_partial');

    // The webhook reverses only when Stripe reports the charge fully refunded; a partial leaves the row as is.
    const row = await CreditTransaction.findOne({ stripePaymentIntentId: 'pi_partial' }).lean();
    expect(row?.reversedAt ?? null).toBeNull();
    expect(await standingOf(userId)).toEqual(PAID);
  });

  it('keeps paid standing while a second purchase is unreversed, and revokes once both are', async () => {
    const userId = await seedBuyer();
    await buy(userId, 'pi_first');
    await buy(userId, 'pi_second');

    expect(await reverse('pi_first', 'refunded')).toBe('kept');
    expect(await standingOf(userId)).toEqual(PAID);

    expect(await reverse('pi_second', 'dispute_lost')).toBe('revoked');
    expect(await standingOf(userId)).toEqual(FREE);
  });

  it('treats a redelivered reversal as a no-op once the stamp is gone', async () => {
    const userId = await seedBuyer();
    await buy(userId, 'pi_redeliver');

    expect(await reverse('pi_redeliver', 'refunded')).toBe('revoked');
    expect(await reverse('pi_redeliver', 'refunded')).toBe('no_stamp');
    expect(await standingOf(userId)).toEqual(FREE);
  });

  it('does nothing for a payment intent with no purchase row', async () => {
    const userId = await seedBuyer();
    await buy(userId, 'pi_kept');

    expect(await reverse('pi_subscription_charge', 'refunded')).toBe('no_purchase');
    expect(await standingOf(userId)).toEqual(PAID);
  });
});
