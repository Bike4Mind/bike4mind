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
    const attempt = await paymentAttemptRepository.recordOutcome(outcome('pi_1', 'u1', 'fp_2'));

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
    const attempt = await paymentAttemptRepository.recordOutcome({
      ...outcome('pi_sub', 'u1', 'fp_1'),
      kind: 'subscription',
      hostingNetwork: true,
    });

    expect(attempt).toMatchObject({ kind: 'subscription', ipHash: null, hostingNetwork: true });
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
});
