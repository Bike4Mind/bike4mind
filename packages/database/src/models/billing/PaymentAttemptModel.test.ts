import { describe, it, expect } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import {
  PAYMENT_ATTEMPT_RETENTION_SECONDS,
  PaymentAttemptModel,
  paymentAttemptRepository,
} from './PaymentAttemptModel';

const start = {
  userId: 'u1',
  kind: 'credits' as const,
  amount: 10000,
  currency: 'usd',
  ipHash: 'net_a',
  hostingNetwork: true,
};
const outcome = (paymentIntentId: string, userId: string, cardFingerprint: string | null) => ({
  paymentIntentId,
  userId,
  kind: 'credits' as const,
  amount: 10000,
  currency: 'usd',
  outcome: 'succeeded' as const,
  cardFingerprint,
  riskLevel: 'normal',
  hostingNetwork: null,
});

describe('PaymentAttemptModel', () => {
  setupMongoTest();

  it('expires attempts after the retention window', () => {
    const ttl = PaymentAttemptModel.schema.indexes().find(([, options]) => options.expireAfterSeconds !== undefined);
    expect(ttl?.[0]).toEqual({ createdAt: 1 });
    expect(ttl?.[1].expireAfterSeconds).toBe(PAYMENT_ATTEMPT_RETENTION_SECONDS);
  });

  it('keeps the started network and adds each card that tried the same intent', async () => {
    await PaymentAttemptModel.createIndexes();
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start });
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start, ipHash: 'net_b' });

    await paymentAttemptRepository.recordOutcome({ ...outcome('pi_1', 'u1', 'fp_1'), outcome: 'failed' });
    const { attempt } = await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_2'));

    expect(attempt).toMatchObject({
      paymentIntentId: 'pi_1',
      ipHash: 'net_a',
      hostingNetwork: true,
      outcome: 'succeeded',
      cardFingerprints: ['fp_1', 'fp_2'],
    });
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
  });

  it('creates the attempt when start-payment never saw it', async () => {
    const { attempt, changed } = await paymentAttemptRepository.recordOutcome({
      ...outcome('pi_sub', 'u1', 'fp_1'),
      kind: 'subscription',
      hostingNetwork: true,
    });

    expect(attempt).toMatchObject({ kind: 'subscription', ipHash: null, hostingNetwork: true });
    expect(changed).toBe(true);
  });

  it('reports a redelivered outcome as unchanged, and a new outcome or card as changed', async () => {
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start });

    const failed = { ...outcome('pi_1', 'u1', 'fp_1'), outcome: 'failed' as const };
    expect((await paymentAttemptRepository.recordOutcome(failed)).changed).toBe(true);
    expect((await paymentAttemptRepository.recordOutcome(failed)).changed).toBe(false);
    expect((await paymentAttemptRepository.recordOutcome({ ...failed, cardFingerprint: null })).changed).toBe(false);
    expect((await paymentAttemptRepository.recordOutcome({ ...failed, cardFingerprint: 'fp_2' })).changed).toBe(true);
    expect((await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_2'))).changed).toBe(true);
    expect((await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_2'))).changed).toBe(false);
  });

  it('counts the accounts behind one card', async () => {
    await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_shared'));
    await paymentAttemptRepository.recordOutcome(outcome('pi_2', 'u1', 'fp_shared'));
    await paymentAttemptRepository.recordOutcome(outcome('pi_3', 'u2', 'fp_shared'));
    await paymentAttemptRepository.recordOutcome(outcome('pi_4', 'u3', 'fp_other'));

    expect(await paymentAttemptRepository.countAccountsForCard('fp_shared')).toBe(2);
    expect(await paymentAttemptRepository.countAccountsForCard('fp_unseen')).toBe(0);
  });

  it('counts recent distinct cards per account and per network', async () => {
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start });
    await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_1'));
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_2', ...start });
    await paymentAttemptRepository.recordOutcome({ ...outcome('pi_2', 'u1', 'fp_2'), outcome: 'failed' });
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_3', ...start, userId: 'u2' });
    await paymentAttemptRepository.recordOutcome(outcome('pi_3', 'u2', 'fp_3'));

    const since = new Date(Date.now() - 60_000);
    expect(await paymentAttemptRepository.countRecentCards({ userId: 'u1', ipHash: 'net_a', since })).toEqual({
      userCards: 2,
      networkCards: 3,
    });
    expect(await paymentAttemptRepository.countRecentCards({ userId: 'u1', ipHash: null, since })).toEqual({
      userCards: 2,
      networkCards: null,
    });
    expect(
      await paymentAttemptRepository.countRecentCards({
        userId: 'u1',
        ipHash: 'net_a',
        since: new Date(Date.now() + 1000),
      })
    ).toEqual({ userCards: 0, networkCards: 0 });
  });

  it('keeps an attempt marked Radar-blocked once any outcome was blocked, and counts them', async () => {
    const since = new Date(Date.now() - 60_000);
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start });
    await paymentAttemptRepository.recordOutcome({
      ...outcome('pi_1', 'u1', 'fp_1'),
      outcome: 'failed',
      radarBlocked: true,
    });
    const { attempt } = await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_2'));
    expect(attempt.radarBlocked).toBe(true);

    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_2', ...start, userId: 'u2' });
    await paymentAttemptRepository.recordOutcome({
      ...outcome('pi_2', 'u2', 'fp_3'),
      outcome: 'failed',
      radarBlocked: true,
    });
    await paymentAttemptRepository.recordOutcome({ ...outcome('pi_3', 'u1', 'fp_4'), outcome: 'failed' });

    expect(await paymentAttemptRepository.countRadarBlocked({ userId: 'u1', ipHash: 'net_a', since })).toEqual({
      account: 1,
      network: 2,
    });
    expect(await paymentAttemptRepository.countRadarBlocked({ userId: 'u1', ipHash: null, since })).toEqual({
      account: 1,
      network: null,
    });
    expect(
      await paymentAttemptRepository.countRadarBlocked({
        userId: 'u1',
        ipHash: 'net_a',
        since: new Date(Date.now() + 1000),
      })
    ).toEqual({ account: 0, network: 0 });
  });

  it('links accounts by shared card and by shared payment network', async () => {
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start });
    await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_1'));
    await paymentAttemptRepository.recordOutcome(outcome('pi_2', 'u2', 'fp_1'));
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_3', ...start, userId: 'u3' });
    await paymentAttemptRepository.recordOutcome(outcome('pi_4', 'u4', 'fp_9'));

    const keys = await paymentAttemptRepository.linkKeysForUser('u1');
    expect(keys).toEqual({ cardFingerprints: ['fp_1'], ipHashes: ['net_a'] });

    const linked = await paymentAttemptRepository.findLinkedUserIds({ userId: 'u1', ...keys, limit: 10 });
    expect(linked.byCard).toEqual(['u2']);
    expect(linked.byNetwork).toEqual(['u3']);
    expect(
      await paymentAttemptRepository.findLinkedUserIds({ userId: 'u1', cardFingerprints: [], ipHashes: [], limit: 10 })
    ).toEqual({ byCard: [], byNetwork: [] });
  });

  const visitA = 'a'.repeat(32);
  const visitB = 'b'.repeat(32);

  it('keeps the visit a payment started in through its outcome, and reads it back by payment intent', async () => {
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start, visitId: visitA });
    // A repeated start does not replace it, and neither does the webhook's outcome.
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start, visitId: visitB });
    await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_1'));
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_2', ...start });

    expect(await paymentAttemptRepository.findVisitId('pi_1')).toBe(visitA);
    expect(await paymentAttemptRepository.findVisitId('pi_2')).toBeNull();
    expect(await paymentAttemptRepository.findVisitId('pi_unseen')).toBeNull();
  });

  it('names no visit on an attempt the webhook created', async () => {
    await paymentAttemptRepository.recordOutcome({ ...outcome('pi_sub', 'u1', 'fp_1'), kind: 'subscription' });
    expect(await paymentAttemptRepository.findVisitId('pi_sub')).toBeNull();
  });

  it("keeps a Checkout's visit under its session id, with nothing the risk checks count", async () => {
    await PaymentAttemptModel.createIndexes();
    await paymentAttemptRepository.recordCheckoutStart({ checkoutSessionId: 'cs_1', userId: 'u1', visitId: visitA });
    await paymentAttemptRepository.recordCheckoutStart({ checkoutSessionId: 'cs_1', userId: 'u1', visitId: visitB });

    expect(await paymentAttemptRepository.findVisitId('cs_1')).toBe(visitA);
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
    expect(await PaymentAttemptModel.findOne({ paymentIntentId: 'cs_1' }).lean()).toMatchObject({
      userId: 'u1',
      kind: 'subscription',
      outcome: 'started',
      amount: null,
      ipHash: null,
      hostingNetwork: null,
      cardFingerprints: [],
      radarBlocked: false,
    });

    const since = new Date(Date.now() - 60_000);
    expect(await paymentAttemptRepository.linkKeysForUser('u1')).toEqual({ cardFingerprints: [], ipHashes: [] });
    expect(await paymentAttemptRepository.countRecentCards({ userId: 'u1', ipHash: null, since })).toEqual({
      userCards: 0,
      networkCards: null,
    });
    expect(await paymentAttemptRepository.countRadarBlocked({ userId: 'u1', ipHash: null, since })).toEqual({
      account: 0,
      network: null,
    });
    expect((await paymentAttemptRepository.summarizeWindow(since)).attempts).toBe(0);
  });

  it('summarizes a window of attempts without exposing users or cards', async () => {
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start });
    await paymentAttemptRepository.recordOutcome({ ...outcome('pi_1', 'u1', 'fp_1'), outcome: 'failed' });
    await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_2'));
    await paymentAttemptRepository.recordOutcome({
      ...outcome('pi_2', 'u2', 'fp_2'),
      outcome: 'failed',
      riskLevel: 'highest',
      radarBlocked: true,
    });
    await paymentAttemptRepository.recordOutcome({ ...outcome('pi_3', 'u3', null), riskLevel: 'elevated' });
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_4', ...start, hostingNetwork: false });
    await PaymentAttemptModel.collection.insertOne({
      paymentIntentId: 'pi_old',
      userId: 'u9',
      kind: 'credits',
      outcome: 'succeeded',
      cardFingerprints: ['fp_9'],
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });

    const summary = await paymentAttemptRepository.summarizeWindow(new Date(Date.now() - 60_000));
    expect(summary).toEqual({
      attempts: 4,
      succeeded: 2,
      failed: 1,
      radarBlocked: 1,
      elevatedRisk: 2,
      hostingNetwork: 1,
      distinctCards: 2,
    });
    expect(await paymentAttemptRepository.summarizeWindow(new Date(Date.now() + 60_000))).toEqual({
      attempts: 0,
      succeeded: 0,
      failed: 0,
      radarBlocked: 0,
      elevatedRisk: 0,
      hostingNetwork: 0,
      distinctCards: 0,
    });
  });
  it('finds settled payments of a risk level created at or before the cutoff, newest first, past newer other rows', async () => {
    const cutoff = new Date('2026-11-01T00:00:00Z');
    const at = (offsetMs: number) => new Date(cutoff.getTime() + offsetMs);
    const row = (paymentIntentId: string, createdAt: Date, overrides: Record<string, unknown> = {}) => ({
      paymentIntentId,
      userId: 'u1',
      kind: 'credits',
      outcome: 'succeeded',
      riskLevel: 'normal',
      cardFingerprints: ['fp_1'],
      createdAt,
      ...overrides,
    });
    await PaymentAttemptModel.collection.insertMany([
      row('pi_old', at(-2 * 60_000)),
      row('pi_edge', at(0)),
      row('pi_elevated', at(-60_000), { riskLevel: 'elevated' }),
      row('pi_failed', at(-60_000), { outcome: 'failed' }),
      row('pi_other_user', at(-60_000), { userId: 'u2' }),
      row('pi_too_new', at(60_000)),
      ...Array.from({ length: 60 }, (_, i) => row(`pi_started_${i}`, at(-30_000), { outcome: 'started' })),
    ]);

    const settled = await paymentAttemptRepository.findSettledByUser('u1', {
      riskLevel: 'normal',
      createdBefore: cutoff,
      limit: 50,
    });

    expect(settled.map(attempt => attempt.paymentIntentId)).toEqual(['pi_edge', 'pi_old']);
  });
  it('finds the account that started a payment intent', async () => {
    await paymentAttemptRepository.recordStart({ paymentIntentId: 'pi_1', ...start });

    expect(await paymentAttemptRepository.findUserId('pi_1')).toBe('u1');
    expect(await paymentAttemptRepository.findUserId('pi_unknown')).toBeNull();
  });
});
