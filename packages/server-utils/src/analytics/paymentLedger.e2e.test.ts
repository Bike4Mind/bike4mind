import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { CreditHolderType } from '@bike4mind/common';
import {
  CreditTransaction,
  creditTransactionRepository,
  Organization,
  stripeDisputeRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Subscription } from '../models/Subscription';
import { classifyFirstPaid, loadPaymentLedger } from './paymentLedger';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
const UNTIL = new Date('2026-07-01T00:00:00Z');
const signup = new Date('2026-05-10T10:00:00Z');
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const newId = () => new mongoose.Types.ObjectId().toHexString();
const opts = { until: UNTIL, maxTimeMS: () => 10_000 };

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const seedPurchase = (
  ownerId: string,
  createdAt: Date,
  pi: string | null,
  ownerType: CreditHolderType = CreditHolderType.User
) =>
  CreditTransaction.collection.insertOne({
    ownerId,
    ownerType,
    credits: 500,
    type: 'purchase',
    status: 'completed',
    ...(pi && { stripePaymentIntentId: pi }),
    createdAt,
    updatedAt: createdAt,
  });

const seedSubscription = (ownerType: 'User' | 'Organization', ownerId: string, fields: Record<string, unknown> = {}) =>
  Subscription.collection.insertOne({
    ownerType,
    ownerId,
    subscriptionId: `sub_${ownerId}`,
    priceId: 'price_1',
    status: 'active',
    source: 'stripe',
    quantity: 1,
    periodStartsAt: signup,
    periodEndsAt: new Date('2026-07-10T00:00:00Z'),
    createdAt: at('2026-05-20'),
    ...fields,
  });

const openDispute = (id: string, fields: { paymentIntentId?: string; subject?: 'user'; subjectId?: string }) =>
  stripeDisputeRepository.recordOpened({
    stripeDisputeId: id,
    chargeId: null,
    paymentIntentId: fields.paymentIntentId ?? null,
    amount: 1000,
    currency: 'usd',
    reason: 'fraudulent',
    stripeStatus: 'needs_response',
    subject: fields.subject ?? 'user',
    subjectId: fields.subjectId ?? null,
    openedAt: at('2026-05-25'),
  });

describe('loadPaymentLedger', () => {
  it('collapses a retried purchase to one payment at its earliest row and keeps legacy rows apart', async () => {
    const buyer = newId();
    await seedPurchase(buyer, at('2026-05-12'), 'pi_dup');
    await seedPurchase(buyer, at('2026-05-11'), 'pi_dup');
    await seedPurchase(buyer, at('2026-05-13'), null);
    await seedPurchase(buyer, at('2026-05-14'), null);

    const ledger = (await loadPaymentLedger([buyer], opts)).get(buyer)!;

    expect(ledger.payments.map(p => [p.kind, p.at.toISOString().slice(0, 10), p.reversed])).toEqual([
      ['credit', '2026-05-11', false],
      ['credit', '2026-05-13', false],
      ['credit', '2026-05-14', false],
    ]);
  });

  it('marks refunds, lost disputes and open disputes reversed, once per payment intent', async () => {
    const refunded = newId();
    const lost = newId();
    const open = newId();
    const both = newId();
    const won = newId();
    await seedPurchase(refunded, at('2026-05-11'), 'pi_refunded');
    await creditTransactionRepository.markPurchaseReversed('pi_refunded', 'refunded');
    await seedPurchase(lost, at('2026-05-11'), 'pi_lost');
    await openDispute('dp_lost', { paymentIntentId: 'pi_lost' });
    await stripeDisputeRepository.resolveBySystem('dp_lost', 'lost');
    await seedPurchase(open, at('2026-05-11'), 'pi_open');
    await openDispute('dp_open', { paymentIntentId: 'pi_open' });
    await seedPurchase(both, at('2026-05-11'), 'pi_both');
    await seedPurchase(both, at('2026-05-11'), 'pi_both');
    await creditTransactionRepository.markPurchaseReversed('pi_both', 'dispute_lost');
    await openDispute('dp_both', { paymentIntentId: 'pi_both' });
    await seedPurchase(won, at('2026-05-11'), 'pi_won');
    await openDispute('dp_won', { paymentIntentId: 'pi_won' });
    await stripeDisputeRepository.resolveBySystem('dp_won', 'won');

    const ledgers = await loadPaymentLedger([refunded, lost, open, both, won], opts);

    for (const id of [refunded, lost, open, both]) {
      expect(ledgers.get(id)!.payments).toEqual([expect.objectContaining({ kind: 'credit', reversed: true })]);
    }
    expect(ledgers.get(won)!.payments).toEqual([expect.objectContaining({ reversed: false })]);
  });

  it('counts Stripe subscriptions only, and a user dispute opened after one reverses it', async () => {
    const subscriber = newId();
    const comped = newId();
    const trialing = newId();
    const disputed = newId();
    await seedSubscription('User', subscriber);
    await seedSubscription('User', comped, { source: 'admin_grant', subscriptionId: 'admin_grant_x' });
    await seedSubscription('User', trialing, { status: 'trialing' });
    await seedSubscription('User', disputed);
    await openDispute('dp_sub', { subjectId: disputed });

    const ledgers = await loadPaymentLedger([subscriber, comped, trialing, disputed], opts);

    expect(ledgers.get(subscriber)!.payments).toEqual([
      expect.objectContaining({ kind: 'subscription', reversed: false }),
    ]);
    expect(ledgers.get(comped)!.payments).toEqual([]);
    expect(ledgers.get(trialing)!.payments).toEqual([]);
    expect(ledgers.get(disputed)!.payments).toEqual([expect.objectContaining({ reversed: true })]);
  });

  it('keeps organization payments out of the personal split but flags the owner as an org buyer', async () => {
    const owner = newId();
    const orgOnly = newId();
    const team = await Organization.create({ name: 'Team', userId: owner });
    const otherTeam = await Organization.create({ name: 'Other', userId: orgOnly });
    await seedSubscription('Organization', String(team._id));
    await seedPurchase(String(otherTeam._id), at('2026-05-15'), 'pi_org', CreditHolderType.Organization);
    await seedPurchase(owner, at('2026-05-30'), 'pi_personal');

    const ledgers = await loadPaymentLedger([owner, orgOnly], opts);

    expect(ledgers.get(owner)!.payments).toEqual([expect.objectContaining({ kind: 'credit' })]);
    expect(ledgers.get(owner)!.orgBuyerAt).toEqual(at('2026-05-20'));
    expect(ledgers.get(orgOnly)!.payments).toEqual([]);
    expect(ledgers.get(orgOnly)!.orgBuyerAt).toEqual(at('2026-05-15'));
  });
});

describe('classifyFirstPaid', () => {
  it('takes the earliest payment in the window, prefers a subscription on a tie, and flags both kinds', async () => {
    const tie = newId();
    const creditFirst = newId();
    const late = newId();
    await seedSubscription('User', tie, { createdAt: at('2026-05-12') });
    await seedPurchase(tie, at('2026-05-12'), 'pi_tie');
    await seedPurchase(creditFirst, at('2026-05-11'), 'pi_first');
    await seedSubscription('User', creditFirst, { createdAt: at('2026-06-30') });
    await seedPurchase(late, at('2026-06-30'), 'pi_late');

    const ledgers = await loadPaymentLedger([tie, creditFirst, late], opts);

    expect(classifyFirstPaid(ledgers.get(tie), signup, 7)).toMatchObject({ kind: 'subscription', both: true });
    expect(classifyFirstPaid(ledgers.get(creditFirst), signup, 30)).toMatchObject({ kind: 'credit', both: false });
    expect(classifyFirstPaid(ledgers.get(creditFirst), signup, 90)).toMatchObject({ kind: 'credit', both: true });
    expect(classifyFirstPaid(ledgers.get(late), signup, 30)).toBeNull();
    expect(classifyFirstPaid(ledgers.get(late), signup, 90)).toMatchObject({ kind: 'credit' });
  });
});
