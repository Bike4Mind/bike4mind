import { CreditHolderType, settingsMap } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  REFERRAL_REWARD_STEPS,
  referralSubscriptionRewardRepository,
  User,
  userRepository,
  withTransaction,
  type ReferralRewardCloseReason,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { creditService } from '@bike4mind/services';
import { getStripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { PROFESSIONAL_PRICE_ID } from '@client/lib/userSubscriptions/constants';
import type Stripe from 'stripe';
import { alertIfRewardsSpike, isBlockedInviter, REFERRAL_REWARD_REASON, type RewardParty } from './firstAnswerReward';

const logger = new Logger({ metadata: { service: 'referralSubscriptionReward' } });

const DAY_MS = 24 * 60 * 60 * 1000;

// Sign-up and renewal invoices count; plan changes and prorations never do. Which step a payment takes
// comes from how many steps the payer has already used, not from the billing reason.
const COUNTED_BILLING_REASONS = new Set<string | null>(['subscription_create', 'subscription_cycle']);

// A refund event for the reward is retried when a concurrent event or the release job moved it first.
const MAX_REVERSAL_ATTEMPTS = 3;

const PARTY_FIELDS = 'isSynthetic deletedAt isBanned disputePending moderation.status';

// In Stripe v22 the payment intent lives on invoice.payments (expand it when retrieving the invoice).
const invoicePaymentIntentId = (invoice: Stripe.Invoice): string | undefined => {
  const payment = invoice.payments?.data[0]?.payment;
  if (payment?.type !== 'payment_intent') return undefined;
  return (
    (typeof payment.payment_intent === 'string' ? payment.payment_intent : payment.payment_intent?.id) || undefined
  );
};

/**
 * Full price means the one Professional line with no coupon or discount. It is checked by price id, not by
 * amount, so a payer charged in another currency still counts.
 */
export function isFullPriceProfessionalInvoice(invoice: Stripe.Invoice, subscription: Stripe.Subscription): boolean {
  // An unset price env resolves to '', which would match any line without a price.
  if (!PROFESSIONAL_PRICE_ID) return false;
  if (!COUNTED_BILLING_REASONS.has(invoice.billing_reason)) return false;
  if (!(invoice.amount_paid > 0)) return false;

  const items = subscription.items.data;
  if (items.length !== 1 || items[0].price.id !== PROFESSIONAL_PRICE_ID) return false;

  const lines = invoice.lines?.data ?? [];
  if (lines.length !== 1 || lines[0].pricing?.price_details?.price !== PROFESSIONAL_PRICE_ID) return false;

  if ((invoice.discounts?.length ?? 0) > 0) return false;
  if ((invoice.total_discount_amounts ?? []).some(discount => discount.amount > 0)) return false;
  if ((lines[0].discount_amounts ?? []).some(discount => discount.amount > 0)) return false;
  return true;
}

/** Transaction id and lot reference of a reward's grant; the take-back finds the lot through it. */
const rewardGrantRef = ({ inviterId, invoiceId }: { inviterId: string; invoiceId: string }) =>
  `referral-subscription:${inviterId}:${invoiceId}`;

const REWARD_SETTINGS = ['ReferralFirstPaymentCredits', 'ReferralSecondPaymentCredits', 'ReferralHoldDays'] as const;

/**
 * Called from the paid-invoice worker for a personal subscription. Holds a reward for the payer's inviter
 * when this is the friend's 1st or 2nd full-price Professional payment. Nothing is credited here: the
 * release job grants it when the hold ends. The amount is read now and locked on the row. A step whose
 * amount is 0 is still recorded (as already released, with no credits) so the next payment takes the right
 * step. Dormant while both payment amounts are 0. Never throws, so a failure cannot make the invoice
 * handler retry.
 */
export async function recordSubscriptionPaymentReward({
  invoice,
  subscription,
  payerId,
  now = new Date(),
}: {
  invoice: Stripe.Invoice;
  subscription: Stripe.Subscription;
  payerId: string;
  now?: Date;
}): Promise<void> {
  try {
    if (!isFullPriceProfessionalInvoice(invoice, subscription)) return;

    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: [...REWARD_SETTINGS], skipCache: true }
    );
    const firstCredits = getSettingsValue('ReferralFirstPaymentCredits', settings, 0);
    const secondCredits = getSettingsValue('ReferralSecondPaymentCredits', settings, 0);
    if (!(firstCredits > 0) && !(secondCredits > 0)) return;

    // A payer who is banned, disputing a charge or suspended earns the inviter nothing, same as the inviter.
    const payer = await User.findById(payerId)
      .select(`referredByUserId ${PARTY_FIELDS}`)
      .lean<{ referredByUserId?: string | null } & RewardParty>();
    if (!payer?.referredByUserId || isBlockedInviter(payer)) return;

    const inviterId = String(payer.referredByUserId);
    if (inviterId === payerId) return;
    const inviter = await User.findById(inviterId).select(PARTY_FIELDS).lean<RewardParty>();
    if (!inviter || isBlockedInviter(inviter)) return;

    if (await referralSubscriptionRewardRepository.findByInvoiceId(invoice.id)) return;

    const holdDays = getSettingsValue(
      'ReferralHoldDays',
      settings,
      settingsMap.ReferralHoldDays.schema.parse(undefined)
    );

    // A null create means the invoice is taken or a concurrent invoice of this payer took the step; in the
    // second case the used steps are re-read and this invoice takes the next free one. The first free step
    // is picked, not the used count, because a refund inside the hold frees an earlier step out of order.
    for (let attempt = 0; attempt < 2; attempt++) {
      const usedSteps = await referralSubscriptionRewardRepository.findClaimedSteps(payerId);
      const step = REFERRAL_REWARD_STEPS.find(candidate => !usedSteps.includes(candidate));
      if (!step) return;

      const reward = await referralSubscriptionRewardRepository.create(
        {
          invoiceId: invoice.id,
          paymentIntentId: invoicePaymentIntentId(invoice),
          payerId,
          inviterId,
          step,
          credits: step === 'first_payment' ? firstCredits : secondCredits,
          releaseAt: new Date(now.getTime() + holdDays * DAY_MS),
        },
        now
      );
      if (reward) {
        logger.info('[referral] recorded subscription reward', { rewardId: reward.id, step, invoiceId: invoice.id });
        return;
      }
      if (await referralSubscriptionRewardRepository.findByInvoiceId(invoice.id)) return;
    }
    logger.warn('[referral] subscription reward not recorded after concurrent step claims', {
      invoiceId: invoice.id,
      payerId,
    });
  } catch (err) {
    logger.error('[referral] recording subscription reward failed', { invoiceId: invoice.id, payerId, err });
  }
}

export type PaymentOutcome = 'paid' | Extract<ReferralRewardCloseReason, 'refunded' | 'disputed'>;

/** Reads a payment's refund and dispute state from Stripe. */
export async function fetchStripePaymentOutcome(paymentIntentId: string): Promise<PaymentOutcome> {
  const intent = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') return 'paid';
  if (charge.disputed) return 'disputed';
  return charge.amount_refunded > 0 ? 'refunded' : 'paid';
}

export interface ReleaseSubscriptionRewardsResult {
  candidates: number;
  released: number;
  cancelled: number;
  failed: number;
}

/**
 * Credits every held reward whose hold has ended. An inviter or payer who has since been deleted,
 * suspended, banned or put under a chargeback earns nothing and the reward is cancelled. So is a reward
 * whose payment Stripe shows as refunded or disputed: the refund webhook cancels it too, but it misses a
 * refund that arrived before the reward was recorded or whose handling failed. Each claim and grant commit
 * in one transaction, and the grant's transactionId is stable, so overlapping runs and retries never pay
 * twice.
 */
export async function releaseDueSubscriptionRewards({
  now = new Date(),
  limit = 200,
  paymentOutcome = fetchStripePaymentOutcome,
}: {
  now?: Date;
  limit?: number;
  paymentOutcome?: (paymentIntentId: string) => Promise<PaymentOutcome>;
} = {}): Promise<ReleaseSubscriptionRewardsResult> {
  const due = await referralSubscriptionRewardRepository.findDue(now, limit);
  const result: ReleaseSubscriptionRewardsResult = { candidates: due.length, released: 0, cancelled: 0, failed: 0 };
  if (due.length === 0) return result;

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['ReferralAlertRewardsPerDay'], skipCache: true }
  );
  const alertThreshold = getSettingsValue(
    'ReferralAlertRewardsPerDay',
    settings,
    settingsMap.ReferralAlertRewardsPerDay.schema.parse(undefined)
  );

  for (const candidate of due) {
    try {
      const [inviter, payer] = await Promise.all([
        User.findById(candidate.inviterId).select(PARTY_FIELDS).lean<RewardParty>(),
        User.findById(candidate.payerId).select(PARTY_FIELDS).lean<RewardParty>(),
      ]);
      const blocked: ReferralRewardCloseReason | null =
        !inviter || isBlockedInviter(inviter)
          ? 'inviter_blocked'
          : !payer || isBlockedInviter(payer)
            ? 'payer_blocked'
            : null;
      if (blocked) {
        if (await referralSubscriptionRewardRepository.cancelPending(candidate.id, blocked, now)) result.cancelled++;
        continue;
      }

      // A Stripe failure throws into the catch below, so the reward is retried next run rather than paid.
      const outcome = candidate.paymentIntentId ? await paymentOutcome(candidate.paymentIntentId) : 'paid';
      if (outcome !== 'paid') {
        if (await referralSubscriptionRewardRepository.cancelPending(candidate.id, outcome, now)) result.cancelled++;
        continue;
      }

      const creditTransactionId = await withTransaction(async () => {
        const claimed = await referralSubscriptionRewardRepository.claimForRelease(candidate.id, now);
        if (!claimed) return null;
        const grant = await creditService.addCreditsWithLedgerRow(
          {
            ownerId: claimed.inviterId,
            ownerType: CreditHolderType.User,
            credits: claimed.credits,
            type: 'generic_add',
            transactionId: rewardGrantRef(claimed),
            reason: REFERRAL_REWARD_REASON,
            description: 'Referral reward: subscription payment from an invited friend',
            metadata: { step: claimed.step, referredUserId: claimed.payerId, invoiceId: claimed.invoiceId },
          },
          {
            db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
            creditHolderMethods: userRepository,
            lotRef: rewardGrantRef(claimed),
          }
        );
        return grant.creditTransactionId ?? '';
      });
      if (creditTransactionId === null) continue;

      result.released++;
      if (creditTransactionId) {
        try {
          await alertIfRewardsSpike(creditTransactionId, alertThreshold);
        } catch (err) {
          logger.error('[referral] reward spike alert failed', { rewardId: candidate.id, err });
        }
      }
    } catch (err) {
      result.failed++;
      logger.error('[referral] releasing subscription reward failed - retried next run', {
        rewardId: candidate.id,
        inviterId: candidate.inviterId,
        err,
      });
    }
  }

  logger.info('[referral] subscription reward release complete', { ...result, capped: due.length === limit });
  return result;
}

/**
 * Applies a Stripe refund (or a chargeback, passed as a full refund with reason 'disputed') to the reward
 * for that payment. Inside the hold it cancels the reward; only a refund frees the payer's step. After
 * release only the refunded share is taken back, capped at what is left unspent of the reward's own lot and
 * at the inviter's balance: an already spent part is not recovered from other credits and the balance never
 * goes negative. Takes the charge's cumulative refunded amount, so a redelivered or repeated event applies
 * once; when the release job or another event moves the reward first it is re-read and retried. A dispute
 * the payer later wins does not restore a cancelled or taken-back reward. Never throws, so the payer's own
 * clawback is unaffected.
 */
export async function reverseSubscriptionRewardForRefund({
  paymentIntentId,
  amountRefunded,
  amountCaptured,
  reason = 'refunded',
  now = new Date(),
}: {
  paymentIntentId: string;
  amountRefunded: number;
  amountCaptured: number;
  reason?: Extract<ReferralRewardCloseReason, 'refunded' | 'disputed'>;
  now?: Date;
}): Promise<void> {
  try {
    if (!(amountRefunded > 0)) return;

    for (let attempt = 0; attempt < MAX_REVERSAL_ATTEMPTS; attempt++) {
      const reward = await referralSubscriptionRewardRepository.findByPaymentIntentId(paymentIntentId);
      if (!reward) return;

      if (reward.status === 'pending') {
        if (await referralSubscriptionRewardRepository.cancelPending(reward.id, reason, now)) return;
        continue; // released in between: take back from the released reward instead
      }
      if (reward.status !== 'released' || !(amountCaptured > 0)) return;

      const refundedShare = Math.min(1, amountRefunded / amountCaptured);
      const refundTargetCredits = Math.round(reward.credits * refundedShare);
      const newlyDue = refundTargetCredits - reward.refundTargetCredits;
      if (newlyDue <= 0) return;

      const recorded = await withTransaction(async () => {
        const [inviter, rewardLots] = await Promise.all([
          User.findById(reward.inviterId).select('currentCredits').lean<{ currentCredits?: number }>(),
          creditLotRepository.findByStripeRef(rewardGrantRef(reward)),
        ]);
        const unspentReward = rewardLots.reduce((sum, lot) => sum + Math.max(0, lot.amount - lot.consumedAssigned), 0);
        const takeBack = Math.max(0, Math.min(newlyDue, unspentReward, inviter?.currentCredits ?? 0));

        const applied = await referralSubscriptionRewardRepository.recordTakeBack(
          reward.id,
          reward.refundTargetCredits,
          {
            refundTargetCredits,
            takenBackCredits: reward.takenBackCredits + takeBack,
            fullyRefunded: refundedShare >= 1,
          },
          now
        );
        if (!applied) return false;
        if (takeBack > 0) {
          await creditService.subtractCredits(
            {
              type: 'generic_deduct',
              ownerId: reward.inviterId,
              ownerType: CreditHolderType.User,
              credits: takeBack,
              reason: 'referral_reward_takeback',
              description: 'Referral reward taken back after a refund',
              metadata: { step: reward.step, referredUserId: reward.payerId, invoiceId: reward.invoiceId },
            },
            { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
          );
          // Shrinks the reward's own lot too, so the lot sweep cannot charge the take-back to another lot.
          await creditService.clawbackCreditLotsByStripeRef(rewardGrantRef(reward), 'proportional', takeBack, {
            db: { creditLots: creditLotRepository },
          });
        }
        return true;
      });
      if (recorded) return;
    }
    logger.warn('[referral] subscription reward reversal gave up after concurrent updates', { paymentIntentId });
  } catch (err) {
    logger.error('[referral] reversing subscription reward failed', { paymentIntentId, err });
  }
}
