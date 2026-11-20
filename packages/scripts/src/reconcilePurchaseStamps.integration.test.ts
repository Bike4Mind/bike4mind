import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import {
  CreditTransaction,
  Organization,
  User,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { reconcilePurchaseStamps, type PurchaseClassification, type ReconcileOptions } from './reconcilePurchaseStamps';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const STAMP = new Date('2026-10-01T00:00:00Z');

describe('reconcilePurchaseStamps', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  afterEach(async () => {
    await mongoose.connection.dropDatabase();
  });

  const seedUser = async (stamp: Date | null = STAMP) => {
    const user = await User.create({
      name: 'Buyer',
      username: `buyer-${Math.random().toString(36).slice(2, 10)}`,
      password: null,
      hasUsablePassword: false,
      currentCredits: 100,
    });
    await User.collection.updateOne({ _id: user._id }, { $set: { lastCreditsPurchasedAt: stamp } });
    return user.id as string;
  };

  const seedPurchase = (ownerId: string, paymentIntentId: string | null, extra: Record<string, unknown> = {}) =>
    CreditTransaction.collection.insertOne({
      ownerId,
      ownerType: 'User',
      type: 'purchase',
      status: 'completed',
      credits: 500,
      amount: 999,
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      createdAt: STAMP,
      updatedAt: STAMP,
      ...extra,
    });

  const stampOf = async (userId: string) => (await User.findById(userId).lean())?.lastCreditsPurchasedAt ?? null;
  const rowOf = (pi: string) => CreditTransaction.findOne({ stripePaymentIntentId: pi }).lean();

  const run = (
    apply: boolean,
    {
      classes = {},
      owners = {},
      ...rest
    }: {
      classes?: Record<string, PurchaseClassification>;
      owners?: Record<string, string>;
    } & Partial<ReconcileOptions> = {}
  ) => {
    const notify = vi.fn(async () => undefined);
    const promise = reconcilePurchaseStamps({
      apply,
      classifyPurchase: async pi => classes[pi] ?? { kind: 'standing' },
      resolveOwnerByPaymentIntent: async pi => owners[pi] ?? null,
      notify,
      log: () => undefined,
      ...rest,
    });
    return { promise, notify };
  };

  const verdictOf = (result: Awaited<ReturnType<typeof reconcilePurchaseStamps>>, userId: string) =>
    result.users.find(u => u.userId === userId);

  it('lists an unbacked stamp on a dry run without touching it, and clears it on apply', async () => {
    const userId = await seedUser();

    const dry = run(false);
    expect(verdictOf(await dry.promise, userId)).toEqual({ userId, verdict: 'clear', reason: 'no_backing' });
    expect(await stampOf(userId)).toEqual(STAMP);
    expect(dry.notify).not.toHaveBeenCalled();

    const wet = run(true);
    const result = await wet.promise;
    expect(verdictOf(result, userId)?.verdict).toBe('clear');
    expect(result.cleared).toBe(1);
    expect(await stampOf(userId)).toBeNull();
    expect(wet.notify).toHaveBeenCalledWith(userId);
  });

  it('keeps a stamp backed by a completed unreversed purchase, or a status-less legacy one', async () => {
    const buyer = await seedUser();
    const legacy = await seedUser();
    await seedPurchase(buyer, 'pi_buyer');
    await seedPurchase(legacy, null, { status: undefined });

    const result = await run(true).promise;

    expect(verdictOf(result, buyer)).toMatchObject({ verdict: 'keep', reason: 'purchase' });
    expect(verdictOf(result, legacy)).toMatchObject({ verdict: 'keep', reason: 'purchase' });
    expect(await stampOf(buyer)).toEqual(STAMP);
  });

  it('clears a stamp whose only purchases are pending, failed or already reversed', async () => {
    const pending = await seedUser();
    const reversed = await seedUser();
    await seedPurchase(pending, 'pi_pending', { status: 'pending' });
    await seedPurchase(pending, 'pi_failed', { status: 'failed' });
    await seedPurchase(reversed, 'pi_reversed', { reversedAt: STAMP, reversalReason: 'refunded' });

    await run(true).promise;

    expect(await stampOf(pending)).toBeNull();
    expect(await stampOf(reversed)).toBeNull();
  });

  it('clears an unbacked stamp even when the user has an active subscription', async () => {
    const userId = await seedUser();
    await mongoose.connection.collection('subscriptions').insertOne({
      ownerType: 'User',
      ownerId: userId,
      status: 'active',
      source: 'stripe',
      subscriptionId: 'sub_active',
    });

    const result = await run(true).promise;

    expect(verdictOf(result, userId)).toMatchObject({ verdict: 'clear', reason: 'no_backing' });
    expect(await stampOf(userId)).toBeNull();
  });

  it('marks fully refunded and lost-dispute purchases reversed and clears the stamps they backed', async () => {
    const refunded = await seedUser();
    const disputed = await seedUser();
    await seedPurchase(refunded, 'pi_refunded');
    await seedPurchase(disputed, 'pi_disputed');
    const classes: Record<string, PurchaseClassification> = {
      pi_refunded: { kind: 'reversed', reason: 'refunded' },
      pi_disputed: { kind: 'reversed', reason: 'dispute_lost' },
    };

    const dry = await run(false, { classes }).promise;
    expect(dry.reversals).toHaveLength(2);
    expect((await rowOf('pi_refunded'))?.reversedAt ?? null).toBeNull();

    await run(true, { classes }).promise;

    expect(await rowOf('pi_refunded')).toMatchObject({ reversalReason: 'refunded', reversedAt: expect.any(Date) });
    expect(await rowOf('pi_disputed')).toMatchObject({ reversalReason: 'dispute_lost', reversedAt: expect.any(Date) });
    expect(await stampOf(refunded)).toBeNull();
    expect(await stampOf(disputed)).toBeNull();
  });

  it('keeps a stamp whose purchase Stripe could not classify, or only partly refunded', async () => {
    const unknown = await seedUser();
    const partial = await seedUser();
    await seedPurchase(unknown, 'pi_unknown');
    await seedPurchase(partial, 'pi_partial');

    const result = await run(true, {
      classes: { pi_unknown: { kind: 'unknown', error: 'stripe down' }, pi_partial: { kind: 'standing' } },
    }).promise;

    expect(verdictOf(result, unknown)).toMatchObject({ verdict: 'keep', reason: 'purchase' });
    expect(verdictOf(result, partial)).toMatchObject({ verdict: 'keep', reason: 'purchase' });
    expect(result.errors).toEqual([{ id: 'pi_unknown', message: 'stripe down' }]);
    expect((await rowOf('pi_unknown'))?.reversedAt ?? null).toBeNull();
  });

  it('keeps the user an ownerless purchase resolves to through its payment intent', async () => {
    const buyer = await seedUser();
    await seedPurchase('', 'pi_blank');
    await seedPurchase(new mongoose.Types.ObjectId().toString(), 'pi_gone');

    const result = await run(true, { owners: { pi_blank: buyer, pi_gone: buyer } }).promise;

    expect(result.aborted).toBe(false);
    expect(result.ownerless).toHaveLength(2);
    expect(verdictOf(result, buyer)).toMatchObject({ verdict: 'keep', reason: 'purchase' });
  });

  it('aborts an apply run before any write when an ownerless purchase stays unresolved', async () => {
    const stale = await seedUser();
    const refunded = await seedUser();
    await seedPurchase(refunded, 'pi_refunded');
    await seedPurchase('', 'pi_orphan');
    await seedPurchase('', null);
    const wet = run(true, { classes: { pi_refunded: { kind: 'reversed', reason: 'refunded' } } });

    const result = await wet.promise;

    expect(result.aborted).toBe(true);
    expect(result.blocking).toBe(2);
    expect(result.ownerless.filter(o => o.resolvedUserId === null)).toHaveLength(2);
    expect(await stampOf(stale)).toEqual(STAMP);
    expect(await stampOf(refunded)).toEqual(STAMP);
    expect((await rowOf('pi_refunded'))?.reversedAt ?? null).toBeNull();
    expect(wet.notify).not.toHaveBeenCalled();
  });

  it('reports in a dry run that an unresolved ownerless purchase would abort --apply', async () => {
    const stale = await seedUser();
    await seedPurchase('', 'pi_orphan');
    const logs: string[] = [];

    const result = await run(false, { log: line => logs.push(line) }).promise;

    expect(result.aborted).toBe(false);
    expect(result.blocking).toBe(1);
    expect(logs.some(line => line.includes('--apply would abort'))).toBe(true);
    expect(await stampOf(stale)).toEqual(STAMP);
  });

  it('does not block on a purchase whose owner user was deleted and no customer resolves', async () => {
    const stale = await seedUser();
    await seedPurchase(new mongoose.Types.ObjectId().toString(), 'pi_deleted_owner');

    const result = await run(true).promise;

    expect(result.aborted).toBe(false);
    expect(result.blocking).toBe(0);
    expect(result.ownerless).toEqual([expect.objectContaining({ resolvedUserId: null, blocking: false })]);
    expect(await stampOf(stale)).toBeNull();
  });

  it('records a failed Stripe read once when the owner lookup fails on the same intent', async () => {
    await seedPurchase('', 'pi_down');

    const result = await run(false, {
      classes: { pi_down: { kind: 'unknown', error: 'stripe down' } },
      resolveOwnerByPaymentIntent: async () => {
        throw new Error('stripe down');
      },
    }).promise;

    expect(result.errors).toEqual([{ id: 'pi_down', message: 'stripe down' }]);
  });

  it('keeps a user whose reversal or stamp clear fails and finishes the run', async () => {
    const refunded = await seedUser();
    const failing = await seedUser();
    const stale = await seedUser();
    await seedPurchase(refunded, 'pi_refunded');
    vi.spyOn(creditTransactionRepository, 'markPurchaseReversed').mockRejectedValueOnce(new Error('write failed'));
    const realClear = userRepository.clearPurchaseStampIfUnchanged.bind(userRepository);
    vi.spyOn(userRepository, 'clearPurchaseStampIfUnchanged').mockImplementation(async (id, stamp) => {
      if (id === failing) throw new Error('clear failed');
      return realClear(id, stamp);
    });

    try {
      const result = await run(true, { classes: { pi_refunded: { kind: 'reversed', reason: 'refunded' } } }).promise;

      expect(verdictOf(result, refunded)).toMatchObject({ verdict: 'keep', reason: 'purchase' });
      expect(verdictOf(result, failing)).toMatchObject({ verdict: 'keep', reason: 'error' });
      expect(verdictOf(result, stale)).toMatchObject({ verdict: 'clear', reason: 'no_backing' });
      expect(result.errors.map(e => e.id).sort()).toEqual(['pi_refunded', failing].sort());
      expect(result.reversals).toEqual([]);
      expect(await stampOf(refunded)).toEqual(STAMP);
      expect(await stampOf(failing)).toEqual(STAMP);
      expect(await stampOf(stale)).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not count a reversed ownerless purchase as blocking', async () => {
    const stale = await seedUser();
    await seedPurchase('', 'pi_orphan');

    const result = await run(true, { classes: { pi_orphan: { kind: 'reversed', reason: 'refunded' } } }).promise;

    expect(result.aborted).toBe(false);
    expect(await stampOf(stale)).toBeNull();
  });

  it('keeps a stamp rewritten, or a purchase that lands, while the run is in flight', async () => {
    const rewritten = await seedUser();
    const late = await seedUser();
    const later = new Date(STAMP.getTime() + 60_000);

    const realFind = creditTransactionRepository.findUnreversedPurchase.bind(creditTransactionRepository);
    const spy = vi
      .spyOn(creditTransactionRepository, 'findUnreversedPurchase')
      .mockImplementation(async (userId, ownerType) => {
        if (userId === rewritten)
          await User.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(userId) },
            { $set: { lastCreditsPurchasedAt: later } }
          );
        if (userId === late) await seedPurchase(late, 'pi_late');
        return realFind(userId, ownerType);
      });
    let result: Awaited<ReturnType<typeof reconcilePurchaseStamps>>;
    try {
      result = await run(true).promise;
    } finally {
      spy.mockRestore();
    }

    expect(verdictOf(result, rewritten)).toMatchObject({ verdict: 'keep', reason: 'stamp_changed' });
    expect(verdictOf(result, late)).toMatchObject({ verdict: 'keep', reason: 'purchase' });
    expect(await stampOf(rewritten)).toEqual(later);
    expect(await stampOf(late)).toEqual(STAMP);
  });

  it('does not let an org-owned purchase back a user stamp', async () => {
    const userId = await seedUser();
    const org = await Organization.create({ name: 'Acme', userId, users: [], groups: [] });
    await seedPurchase(org.id, 'pi_org', { ownerType: 'Organization' });

    await run(true).promise;

    expect(await stampOf(userId)).toBeNull();
  });

  it('classifies only purchases that can back a stamped user', async () => {
    const stamped = await seedUser();
    const unstamped = await seedUser(null);
    const org = await Organization.create({ name: 'Acme', userId: stamped, users: [], groups: [] });
    await seedPurchase(stamped, 'pi_stamped');
    await seedPurchase(unstamped, 'pi_unstamped');
    await seedPurchase(org.id, 'pi_org', { ownerType: 'Organization' });
    const classifyPurchase = vi.fn(async (): Promise<PurchaseClassification> => ({ kind: 'standing' }));

    await run(true, { classifyPurchase }).promise;

    expect(classifyPurchase.mock.calls.map(([pi]) => pi)).toEqual(['pi_stamped']);
  });

  it('clears nothing on a second apply run', async () => {
    await seedUser();
    const buyer = await seedUser();
    await seedPurchase(buyer, 'pi_buyer');
    await seedUser(null);

    expect((await run(true).promise).cleared).toBe(1);
    const second = await run(true).promise;

    expect(second.cleared).toBe(0);
    expect(second.users).toEqual([{ userId: buyer, verdict: 'keep', reason: 'purchase' }]);
  });
});
