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
});
