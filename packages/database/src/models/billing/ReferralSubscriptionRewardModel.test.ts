import { beforeEach, describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import {
  ReferralSubscriptionRewardModel,
  referralSubscriptionRewardRepository as repo,
  type NewReferralSubscriptionReward,
} from './ReferralSubscriptionRewardModel';

const now = new Date('2026-11-01T00:00:00.000Z');
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

const reward = (overrides: Partial<NewReferralSubscriptionReward> = {}): NewReferralSubscriptionReward => ({
  invoiceId: 'in_1',
  paymentIntentId: 'pi_1',
  payerId: 'friend1',
  inviterId: 'inviter1',
  step: 'first_payment',
  credits: 6000,
  releaseAt: days(14),
  ...overrides,
});

describe('ReferralSubscriptionRewardModel', () => {
  setupMongoTest();

  // The shared setup drops the database before every test, which drops the indexes with it.
  beforeEach(async () => {
    await ReferralSubscriptionRewardModel.createIndexes();
  });

  describe('create', () => {
    it('holds a reward with credits as pending and counts its step', async () => {
      const created = await repo.create(reward(), now);

      expect(created).toMatchObject({ status: 'pending', credits: 6000, refundTargetCredits: 0, takenBackCredits: 0 });
      expect(created?.releasedAt).toBeUndefined();
      expect(await repo.findClaimedSteps('friend1')).toHaveLength(1);
    });

    it('records a step with no credits as already released, still counting the step', async () => {
      const created = await repo.create(reward({ credits: 0 }), now);

      expect(created).toMatchObject({ status: 'released', releasedAt: now });
      expect(await repo.findClaimedSteps('friend1')).toHaveLength(1);
      expect(await repo.findDue(days(30), 10)).toEqual([]);
    });

    it('returns null for a second reward on the same invoice', async () => {
      await repo.create(reward());
      expect(await repo.create(reward({ step: 'second_payment' }))).toBeNull();
    });

    it('lets only one of two concurrent invoices take the same step', async () => {
      const results = await Promise.all([
        repo.create(reward({ invoiceId: 'in_a', paymentIntentId: 'pi_a' })),
        repo.create(reward({ invoiceId: 'in_b', paymentIntentId: 'pi_b' })),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repo.findClaimedSteps('friend1')).toHaveLength(1);
    });

    it('keeps one payer separate from another', async () => {
      await repo.create(reward());
      expect(await repo.create(reward({ invoiceId: 'in_2', payerId: 'friend2' }))).not.toBeNull();
      expect(await repo.findClaimedSteps('friend1')).toHaveLength(1);
    });
  });

  describe('lookups', () => {
    it('finds a reward by invoice and by payment intent, and reports none otherwise', async () => {
      const created = await repo.create(reward());

      expect(await repo.findByInvoiceId('in_1')).toMatchObject({ id: created?.id });
      expect(await repo.findByPaymentIntentId('pi_1')).toMatchObject({ id: created?.id });
      expect(await repo.findByPaymentIntentId('pi_none')).toBeNull();
    });

    it('lists only pending rewards whose hold has ended, oldest first, up to the limit', async () => {
      await repo.create(
        reward({ invoiceId: 'in_late', paymentIntentId: 'pi_late', payerId: 'p1', releaseAt: days(-1) })
      );
      await repo.create(
        reward({ invoiceId: 'in_early', paymentIntentId: 'pi_early', payerId: 'p2', releaseAt: days(-5) })
      );
      await repo.create(
        reward({ invoiceId: 'in_held', paymentIntentId: 'pi_held', payerId: 'p3', releaseAt: days(3) })
      );

      const due = await repo.findDue(now, 10);
      expect(due.map(r => r.invoiceId)).toEqual(['in_early', 'in_late']);
      expect((await repo.findDue(now, 1)).map(r => r.invoiceId)).toEqual(['in_early']);
    });
  });

  describe('claimForRelease', () => {
    it('lets exactly one concurrent caller claim a due reward', async () => {
      const created = await repo.create(reward({ releaseAt: days(-1) }));

      const claims = await Promise.all([
        repo.claimForRelease(created!.id, now),
        repo.claimForRelease(created!.id, now),
      ]);

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)).toMatchObject({ status: 'released', releasedAt: now });
    });

    it('refuses a reward whose hold has not ended', async () => {
      const created = await repo.create(reward());
      expect(await repo.claimForRelease(created!.id, now)).toBeNull();
    });
  });

  describe('cancelPending', () => {
    it('frees the payer step only for a refund', async () => {
      const created = await repo.create(reward());

      expect(await repo.cancelPending(created!.id, 'refunded', now)).toBe(true);
      expect(await repo.findClaimedSteps('friend1')).toHaveLength(0);
      expect(await repo.findByInvoiceId('in_1')).toMatchObject({
        status: 'cancelled',
        closeReason: 'refunded',
        closedAt: now,
      });
      expect(await repo.create(reward({ invoiceId: 'in_2', paymentIntentId: 'pi_2' }))).not.toBeNull();
    });

    it.each(['disputed', 'inviter_blocked', 'payer_blocked'] as const)(
      'keeps the step used when the reason is %s',
      async reason => {
        const created = await repo.create(reward());

        expect(await repo.cancelPending(created!.id, reason, now)).toBe(true);
        expect(await repo.findClaimedSteps('friend1')).toHaveLength(1);
        expect(await repo.create(reward({ invoiceId: 'in_2', paymentIntentId: 'pi_2' }))).toBeNull();
      }
    );

    it('does nothing once the reward is released or already closed', async () => {
      const released = await repo.create(reward({ releaseAt: days(-1) }));
      await repo.claimForRelease(released!.id, now);
      expect(await repo.cancelPending(released!.id, 'refunded', now)).toBe(false);

      const cancelled = await repo.create(reward({ invoiceId: 'in_2', paymentIntentId: 'pi_2', payerId: 'friend2' }));
      await repo.cancelPending(cancelled!.id, 'disputed', now);
      expect(await repo.cancelPending(cancelled!.id, 'refunded', now)).toBe(false);
      expect(await repo.findClaimedSteps('friend2')).toHaveLength(1);
    });
  });

  describe('recordTakeBack', () => {
    const released = async () => {
      const created = await repo.create(reward({ releaseAt: days(-1) }));
      await repo.claimForRelease(created!.id, now);
      return created!.id;
    };

    it('records a partial refund and leaves the reward released', async () => {
      const id = await released();

      expect(
        await repo.recordTakeBack(
          id,
          0,
          { refundTargetCredits: 3000, takenBackCredits: 2500, fullyRefunded: false },
          now
        )
      ).toBe(true);
      expect(await repo.findByInvoiceId('in_1')).toMatchObject({
        status: 'released',
        refundTargetCredits: 3000,
        takenBackCredits: 2500,
      });
    });

    it('marks a full refund taken_back but keeps the payer step used', async () => {
      const id = await released();

      await repo.recordTakeBack(id, 0, { refundTargetCredits: 6000, takenBackCredits: 6000, fullyRefunded: true }, now);

      expect(await repo.findByInvoiceId('in_1')).toMatchObject({ status: 'taken_back', closeReason: 'refunded' });
      expect(await repo.findClaimedSteps('friend1')).toHaveLength(1);
      expect(await repo.create(reward({ invoiceId: 'in_2', paymentIntentId: 'pi_2' }))).toBeNull();
    });

    it('refuses a stale target so a concurrent or redelivered event applies once', async () => {
      const id = await released();
      const update = { refundTargetCredits: 3000, takenBackCredits: 3000, fullyRefunded: false };

      const results = await Promise.all([
        repo.recordTakeBack(id, 0, update, now),
        repo.recordTakeBack(id, 0, update, now),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repo.recordTakeBack(id, 0, update, now)).toBe(false);
    });

    it('ignores a reward that is still pending', async () => {
      const created = await repo.create(reward());
      expect(
        await repo.recordTakeBack(
          created!.id,
          0,
          { refundTargetCredits: 1, takenBackCredits: 1, fullyRefunded: false },
          now
        )
      ).toBe(false);
    });
  });
});
