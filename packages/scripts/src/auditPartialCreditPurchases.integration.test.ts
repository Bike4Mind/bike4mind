import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { CreditLot, CreditTransaction, User } from '@bike4mind/database';
import { createMongoReplSet, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import {
  auditPartialCreditPurchases,
  classifyPurchase,
  describePaymentIntentProblem,
  type PurchaseEvidence,
} from './auditPartialCreditPurchases';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const STAMP_SINCE = new Date('2026-08-01T00:00:00Z');
const AFTER = new Date('2026-09-01T00:00:00Z');
const BEFORE = new Date('2026-07-01T00:00:00Z');

describe('classifyPurchase', () => {
  const evidence = (overrides: Partial<PurchaseEvidence>): PurchaseEvidence => ({
    createdAt: AFTER,
    backfilledAt: null,
    hasLot: false,
    lastCreditsPurchasedAt: null,
    stampSince: STAMP_SINCE,
    ...overrides,
  });

  it('trusts a pack lot as proof of a grant', () => {
    expect(classifyPurchase(evidence({ hasLot: true })).verdict).toBe('granted');
  });

  it('reports a row an earlier run repaired before anything else', () => {
    expect(classifyPurchase(evidence({ backfilledAt: AFTER, hasLot: true })).verdict).toBe('backfilled');
  });

  it('calls a row ungranted when no stamp was written after it', () => {
    expect(classifyPurchase(evidence({})).verdict).toBe('ungranted');
    expect(classifyPurchase(evidence({ lastCreditsPurchasedAt: STAMP_SINCE })).verdict).toBe('ungranted');
  });

  it('cannot tell when a later stamp might be this purchase or another write', () => {
    const later = new Date(AFTER.getTime() + 1000);
    expect(classifyPurchase(evidence({ lastCreditsPurchasedAt: later })).verdict).toBe('unverifiable');
  });

  it('cannot tell for a row older than the stamp, or on a stage that never stamped', () => {
    expect(classifyPurchase(evidence({ createdAt: BEFORE })).verdict).toBe('unverifiable');
    expect(classifyPurchase(evidence({ stampSince: null })).verdict).toBe('unverifiable');
  });
});

describe('describePaymentIntentProblem', () => {
  const intent = (overrides: { charge?: Partial<Stripe.Charge>; intent?: Partial<Stripe.PaymentIntent> } = {}) =>
    ({
      status: 'succeeded',
      metadata: { environment: 'production', credits: '500' },
      latest_charge: { amount: 999, amount_refunded: 0, disputed: false, ...overrides.charge },
      ...overrides.intent,
    }) as Stripe.PaymentIntent;

  it('backs a repair for a clean succeeded intent on this stage', () => {
    expect(describePaymentIntentProblem(intent(), 'production', 500)).toBeNull();
  });

  it.each([
    ['another stage', intent(), 'dev', 500],
    ['a credits mismatch', intent(), 'production', 400],
    ['a non-succeeded intent', intent({ intent: { status: 'canceled' } }), 'production', 500],
    ['a refund', intent({ charge: { amount_refunded: 999 } }), 'production', 500],
    ['a dispute', intent({ charge: { disputed: true } }), 'production', 500],
    ['an unexpanded charge', intent({ intent: { latest_charge: 'ch_1' } }), 'production', 500],
  ])('refuses %s', (_label, paymentIntent, stage, credits) => {
    expect(describePaymentIntentProblem(paymentIntent, stage, credits)).not.toBeNull();
  });
});

describe('auditPartialCreditPurchases on a real replica set', () => {
  let replSet: Awaited<ReturnType<typeof createMongoReplSet>>;

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

  const seedUser = async (lastCreditsPurchasedAt: Date | null) => {
    const user = await User.create({
      name: 'Buyer',
      username: `buyer-${Math.random().toString(36).slice(2, 10)}`,
      password: null,
      hasUsablePassword: false,
      currentCredits: 100,
    });
    await User.collection.updateOne({ _id: user._id }, { $set: { lastCreditsPurchasedAt } });
    return user.id as string;
  };

  // Raw insert: the audit keys on createdAt, which the schema's timestamps would overwrite.
  const seedPurchase = (ownerId: string, paymentIntentId: string, createdAt: Date) =>
    CreditTransaction.collection.insertOne({
      ownerId,
      ownerType: 'User',
      type: 'purchase',
      status: 'completed',
      credits: 500,
      amount: 999,
      stripePaymentIntentId: paymentIntentId,
      createdAt,
      updatedAt: createdAt,
    });

  const balanceOf = async (userId: string) => (await User.findById(userId).lean())?.currentCredits;
  const verdictOf = (purchases: { paymentIntentId: string; verdict: string }[], id: string) =>
    purchases.find(purchase => purchase.paymentIntentId === id)?.verdict;

  const seedScenario = async () => {
    // The earliest surviving stamp is the derived cutoff.
    await seedUser(STAMP_SINCE);
    const granted = await seedUser(AFTER);
    await seedPurchase(granted, 'pi_granted', AFTER);
    await CreditLot.create({
      ownerId: granted,
      ownerType: 'User',
      source: 'pack',
      amount: 500,
      expiresAt: AFTER,
      consumedAssigned: 0,
      stripeRef: 'pi_granted',
    });
    const stranded = await seedUser(null);
    await seedPurchase(stranded, 'pi_stranded', AFTER);
    const refunded = await seedUser(null);
    await seedPurchase(refunded, 'pi_refunded', AFTER);
    const legacy = await seedUser(null);
    await seedPurchase(legacy, 'pi_legacy', BEFORE);
    return { granted, stranded, refunded, legacy };
  };

  const checkPaymentIntent = async (paymentIntentId: string) =>
    paymentIntentId === 'pi_refunded' ? 'charge refunded 999 of 999' : null;
  const silent = () => undefined;

  it('classifies every purchase row and writes nothing on a dry run', async () => {
    const { stranded } = await seedScenario();

    const result = await auditPartialCreditPurchases({ apply: false, checkPaymentIntent, log: silent });

    expect(result.stampSince).toEqual(STAMP_SINCE);
    expect(verdictOf(result.purchases, 'pi_granted')).toBe('granted');
    expect(verdictOf(result.purchases, 'pi_stranded')).toBe('ungranted');
    expect(verdictOf(result.purchases, 'pi_refunded')).toBe('ungranted');
    expect(verdictOf(result.purchases, 'pi_legacy')).toBe('unverifiable');
    expect(await balanceOf(stranded)).toBe(100);
    expect(await CreditLot.countDocuments({ stripeRef: 'pi_stranded' })).toBe(0);
  });

  it('credits only the purchases Stripe backs, once, across re-runs', async () => {
    const { stranded, refunded } = await seedScenario();

    const first = await auditPartialCreditPurchases({ apply: true, checkPaymentIntent, log: silent });
    const second = await auditPartialCreditPurchases({ apply: true, checkPaymentIntent, log: silent });

    expect(first.purchases.find(purchase => purchase.paymentIntentId === 'pi_stranded')?.repaired).toBe(true);
    expect(await balanceOf(stranded)).toBe(600);
    expect(await CreditLot.countDocuments({ stripeRef: 'pi_stranded' })).toBe(1);
    expect(verdictOf(second.purchases, 'pi_stranded')).toBe('backfilled');

    expect(await balanceOf(refunded)).toBe(100);
    expect(verdictOf(second.purchases, 'pi_refunded')).toBe('ungranted');
  });

  it('reports a repair that cannot find its buyer and keeps going', async () => {
    const { stranded } = await seedScenario();
    await seedPurchase(new mongoose.Types.ObjectId().toString(), 'pi_orphan', AFTER);

    const { purchases } = await auditPartialCreditPurchases({ apply: true, checkPaymentIntent, log: silent });

    const orphan = purchases.find(purchase => purchase.paymentIntentId === 'pi_orphan');
    expect(orphan?.repaired).toBe(false);
    expect(orphan?.repairError).toMatch(/not found/);
    expect(await CreditTransaction.countDocuments({ 'metadata.balanceBackfilledAt': { $exists: true } })).toBe(1);
    expect(await balanceOf(stranded)).toBe(600);
  });
});
