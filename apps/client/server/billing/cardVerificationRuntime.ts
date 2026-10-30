import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type Stripe from 'stripe';
import {
  adminSettingsRepository,
  cacheRepository,
  CreditGrantIdentityClaim,
  mongoose,
  userRepository,
} from '@bike4mind/database';
import { settingsMap } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { stripe, isStripeConfigured } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { Config, isProduction } from '@bike4mind/server-utils/utils/config';
import { ipBucket } from '@bike4mind/server-utils/utils/ipBucket';
import { verifyTurnstile } from '@bike4mind/server-utils/utils/turnstile';
import { ForbiddenError, ServiceUnavailableError, TooManyRequestsError } from '@bike4mind/server-utils/utils/errors';
import { getTurnstilePolicy, turnstileAllowedHostnames } from '@server/utils/auth/turnstile';
import { signupProtection } from '@server/auth/signupProtection';
import { CardVerification, type CardVerificationRecord } from './cardVerificationModel';
import { authenticatedSetupAttempt, parseCardDefensePolicy } from './cardVerificationPolicy';
import { hasCardVerificationGrant } from './grantVerifiedCardCredits';
import {
  CardVerificationRefused,
  completeCardVerification,
  removeVerificationCard,
  resumeCardVerificationSetup,
  type CardVerificationContext,
  type CardVerificationDependencies,
} from './cardVerificationLifecycle';

const DAY = 86400000;
const NOTIFY_RETRY_WINDOW = 7 * DAY;
const ACCOUNT_ATTESTATION_TTL_MS = 5 * 60 * 1000;
const logger = new Logger({ metadata: { service: 'card-verification' } });
interface CardVerificationFailureRecord {
  attemptId: string;
  userId: string;
  ipDigest: string;
  at: Date;
}
const failureSchema = new mongoose.Schema<CardVerificationFailureRecord>({
  attemptId: { type: String, required: true },
  userId: { type: String, required: true },
  ipDigest: { type: String, required: true },
  at: { type: Date, required: true },
});
failureSchema.index({ attemptId: 1 }, { unique: true });
failureSchema.index({ userId: 1, at: 1 });
failureSchema.index({ ipDigest: 1, at: 1 });
failureSchema.index({ at: 1 }, { expireAfterSeconds: 172800 });
export const CardVerificationFailure =
  (mongoose.models.CardVerificationFailure as mongoose.Model<CardVerificationFailureRecord> | undefined) ??
  mongoose.model<CardVerificationFailureRecord>('CardVerificationFailure', failureSchema);

export async function ensureCardVerificationIndexes() {
  await CardVerification.createIndexes();
  await CardVerificationFailure.createIndexes();
  await CreditGrantIdentityClaim.createIndexes();
}

// Per-process memos so the offer GET does not hit Stripe and listIndexes on every request.
let attestedAccount: { id: string; expiresAt: number } | undefined;
let indexesReady = false;

export function resetCardVerificationRuntimeCache() {
  attestedAccount = undefined;
  indexesReady = false;
}

async function currentStripeAccountId(): Promise<string> {
  if (attestedAccount && attestedAccount.expiresAt > Date.now()) return attestedAccount.id;
  const account = await stripe.accounts.retrieve(null);
  attestedAccount = { id: account.id, expiresAt: Date.now() + ACCOUNT_ATTESTATION_TTL_MS };
  return account.id;
}

async function verificationIndexesReady() {
  if (indexesReady) return;
  for (const [model, field] of [
    [CardVerification, 'verificationId'],
    [CardVerificationFailure, 'attemptId'],
  ] as const) {
    const indexes = await model.collection.listIndexes().toArray();
    if (
      !indexes.some(
        index =>
          index.unique === true &&
          !index.sparse &&
          !index.partialFilterExpression &&
          Object.keys(index.key).length === 1 &&
          index.key[field] === 1
      )
    )
      throw new ServiceUnavailableError('Verification storage is not ready.');
  }
  indexesReady = true;
}

/** Per-IP limit subject: IPv6 is bucketed by /64 so one holder cannot rotate addresses for a fresh budget. */
export function cardNetworkDigest(ip: string): string {
  const key = Config.CARD_VERIFICATION_IDENTITY_KEY ?? '';
  if (key.length < 32) throw new ServiceUnavailableError('Card verification is unavailable.');
  return createHmac('sha256', key)
    .update(`network:${ipBucket(ip)}`)
    .digest('hex');
}

export async function cardAccountEligible(userId: string): Promise<boolean> {
  const user = await userRepository.findById(userId);
  if (
    !user?.emailVerified ||
    user.disputePending ||
    userService.accountBlockReasons(user).length ||
    userService.isAiAccessRevoked(user)
  )
    return false;
  return !(await userService.protectSignupCredits(userId, {
    users: userRepository,
    adminSettings: adminSettingsRepository,
    signupProtection,
  }));
}

export async function cardVerificationRuntime(): Promise<CardVerificationDependencies> {
  const [enabledRow, creditsRow, challenge] = await Promise.all([
    adminSettingsRepository.findBySettingName('cardUnlockEnabled'),
    adminSettingsRepository.findBySettingName('cardUnlockCredits'),
    getTurnstilePolicy(),
  ]);
  const enabled = settingsMap.cardUnlockEnabled.schema.parse(enabledRow?.settingValue);
  const credits = settingsMap.cardUnlockCredits.schema.parse(creditsRow?.settingValue);
  const defense = parseCardDefensePolicy(process.env.CARD_VERIFICATION_DEFENSE_POLICY);
  const identityKey = Config.CARD_VERIFICATION_IDENTITY_KEY ?? '';
  const ready =
    enabled &&
    isStripeConfigured() &&
    challenge.active &&
    identityKey.length >= 32 &&
    !!defense &&
    !!Config.CARD_VERIFICATION_WEBHOOK_SECRET?.startsWith('whsec_') &&
    process.env.CARD_VERIFICATION_RECOVERY_ENABLED === 'true';
  const policy = {
    enabled: !!ready,
    cardUnlockCredits: credits,
    identityKey,
    environment: Config.STAGE,
    livemode: isProduction(),
  };
  if (!ready || !defense) return { stripe, policy: async () => policy };
  await verificationIndexesReady();
  // The attestation is private, account-bound and expires; it is not an imaginary Stripe risk-score field.
  if ((await currentStripeAccountId()) !== defense.accountId)
    return { stripe, policy: async () => ({ ...policy, enabled: false }) };

  const failureCounts = async (userId: string, ipDigest: string) => {
    const at = { $gte: new Date(Date.now() - DAY) };
    const [user, ip] = await Promise.all([
      CardVerificationFailure.countDocuments({ userId, at }),
      CardVerificationFailure.countDocuments({ ipDigest, at }),
    ]);
    if (user >= defense.accountDailyFailures || ip >= defense.ipDailyFailures)
      throw new TooManyRequestsError('Card verification is locked for today. Try again later.');
  };

  return {
    stripe,
    policy: async () => policy,
    guards: {
      eligible: cardAccountEligible,
      authorizeAttempt: async (context: CardVerificationContext) => {
        if (!isIP(context.ip) || !/^\d+$/.test(context.asn) || Number(context.asn) <= 0)
          throw new ServiceUnavailableError('Card verification requires trusted network information.');
        const ipDigest = cardNetworkDigest(context.ip);
        await failureCounts(context.userId, ipDigest);
        // Only challenge-passing attempts may spend the shared counters, so junk tokens cannot exhaust an ASN.
        const challengeResult = await verifyTurnstile({
          token: context.turnstileToken,
          secret: challenge.secret,
          ip: context.ip,
          expectedAction: 'card_verification',
          allowedHostnames: turnstileAllowedHostnames(),
          requireAllowedHostnames: true,
          allowTestSecret: !isProduction(),
        });
        if (!challengeResult.ok) throw new ForbiddenError('Verification failed. Refresh and try again.');
        for (const [scope, value, limit] of [
          ['account', context.userId, defense.accountAttempts],
          ['ip', ipDigest, defense.ipAttempts],
          ['asn', context.asn, defense.asnAttempts],
        ] as const) {
          const result = await cacheRepository.tryIncrementWithinLimitFixedWindow(
            `card-verification:attempt:${scope}:${value}`,
            limit,
            defense.attemptsWindowMs
          );
          if (!result.success) throw new TooManyRequestsError('Too many verification attempts. Try again later.');
        }
      },
      approveRisk: async intent => {
        const expanded = await stripe.setupIntents.retrieve(intent.id, { expand: ['latest_attempt'] });
        const attempt = expanded.latest_attempt;
        return typeof attempt === 'object' && attempt !== null && authenticatedSetupAttempt(expanded, attempt);
      },
      recordFailure: async (intent: Stripe.SetupIntent, record: CardVerificationRecord) => {
        if (!record.ipDigest) throw new Error('Verification failure has no trusted network binding');
        const attemptId = typeof intent.latest_attempt === 'string' ? intent.latest_attempt : intent.latest_attempt?.id;
        if (!attemptId) {
          if (intent.status === 'canceled') return;
          throw new Error('Verification failure has no provider attempt');
        }
        let inserted = false;
        try {
          const result = await CardVerificationFailure.updateOne(
            { attemptId },
            { $setOnInsert: { userId: record.userId, ipDigest: record.ipDigest, at: new Date() } },
            { upsert: true }
          );
          inserted = result.upsertedCount === 1;
        } catch (error) {
          if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
        }
        if (inserted) {
          logger.warn('card-verification-failed', { environment: record.environment });
          const count = await CardVerificationFailure.countDocuments({
            at: { $gte: new Date(Date.now() - defense.failureSpikeWindowMs) },
          });
          if (count >= defense.failureSpikeCount) logger.warn('card-verification-failure-spike');
        }
        try {
          await failureCounts(record.userId, record.ipDigest);
        } catch (error) {
          if (error instanceof TooManyRequestsError && intent.status !== 'succeeded' && intent.status !== 'canceled') {
            const current = await stripe.setupIntents.retrieve(intent.id);
            if (current.status === 'succeeded') return;
            if (current.status !== 'canceled') await stripe.setupIntents.cancel(intent.id);
            await CardVerification.updateOne(
              { verificationId: record.verificationId, state: 'pending' },
              { $set: { state: 'refused' } }
            );
          }
          if (!(error instanceof TooManyRequestsError)) throw error;
        }
      },
    },
  };
}

function cleanupRuntime(): CardVerificationDependencies {
  return {
    stripe,
    policy: async () => ({
      enabled: false,
      cardUnlockCredits: 0,
      identityKey: '',
      environment: Config.STAGE,
      livemode: isProduction(),
    }),
  };
}

/** Returns 'busy' when another worker (client, webhook or recovery) holds this verification's lease. */
export async function finishCardVerification(verificationId: string, userId: string, remove = false) {
  const lease = randomUUID();
  const key = `card-verification:completion:${verificationId}`;
  if (!(await cacheRepository.tryAcquireLease(key, lease, 1, 120000))) return 'busy' as const;
  try {
    if (remove) {
      await removeVerificationCard(verificationId, userId, cleanupRuntime());
      return 'removed' as const;
    }
    const existing = await CardVerification.findOne({
      verificationId,
      userId,
      environment: Config.STAGE,
      livemode: isProduction(),
    }).lean();
    if (existing?.state === 'granted' || existing?.state === 'refused') {
      if (!existing.saveCard || existing.state === 'refused')
        await removeVerificationCard(verificationId, userId, cleanupRuntime());
      if (existing.state === 'granted') await notifyVerification(verificationId, userId);
      return existing.state === 'granted' ? ('already_granted' as const) : ('refused' as const);
    }
    const runtime = await cardVerificationRuntime();
    const outcome = await completeCardVerification(verificationId, userId, runtime);
    if (outcome === 'granted') logger.info('card-verification-granted', { entry: existing?.entry ?? 'billing' });
    if (outcome === 'granted' || outcome === 'already_granted') await notifyVerification(verificationId, userId);
    return outcome;
  } finally {
    await cacheRepository.releaseLease(key, lease);
  }
}

async function notifyVerification(verificationId: string, userId: string) {
  const record = await CardVerification.findOne({ verificationId, userId, state: 'granted' }).lean();
  if (!record || record.notifiedAt) return;
  const user = await userRepository.findById(userId);
  if (!user?.email) {
    // Nothing to send to; mark it handled so recovery stops revisiting the row.
    await CardVerification.updateOne({ verificationId, userId }, { $set: { notifiedAt: new Date() } });
    return;
  }
  const { default: mailer } = await import('@server/utils/mailer');
  const sent = await mailer.sendEmail(
    user.email,
    {
      subject: 'Your card was verified, not charged',
      text: `Your card was verified, not charged. ${record.credits} promotional credits were added. No subscription was created and nothing auto-renews. ${record.detached ? 'Your card was removed after verification.' : 'You chose to save your card. You can remove it in Billing.'}`,
    },
    { mirror: false, logRecipient: false }
  );
  if (sent) await CardVerification.updateOne({ verificationId, userId }, { $set: { notifiedAt: new Date() } });
}

async function retrieveBoundIntent(row: CardVerificationRecord, setupIntentId: string) {
  const intent = await stripe.setupIntents.retrieve(setupIntentId);
  const customer = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;
  if (
    intent.id !== setupIntentId ||
    intent.livemode !== row.livemode ||
    customer !== row.customerId ||
    intent.metadata?.verificationId !== row.verificationId ||
    intent.metadata?.purpose !== 'card_verification' ||
    intent.metadata?.environment !== row.environment
  )
    throw new CardVerificationRefused('not_found');
  return intent;
}

async function expirePendingVerification(row: CardVerificationRecord): Promise<boolean> {
  if (row.setupIntentId) {
    const intent = await retrieveBoundIntent(row, row.setupIntentId);
    if (intent.status === 'succeeded' || intent.status === 'processing') return false;
    if (intent.status !== 'canceled') await stripe.setupIntents.cancel(intent.id);
  }
  await CardVerification.updateOne(
    { verificationId: row.verificationId, state: 'pending' },
    { $set: { state: 'refused' } }
  );
  return true;
}

/**
 * With the offer off, a succeeded default-detach setup never reaches completion (which records the card),
 * so retire it without a grant and detach the card the user was promised would be removed.
 */
async function releaseUngrantedCard(row: CardVerificationRecord): Promise<void> {
  if (row.state !== 'pending' || row.saveCard || !row.setupIntentId) return;
  const intent = await retrieveBoundIntent(row, row.setupIntentId);
  if (intent.status !== 'succeeded') return;
  const paymentMethodId = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
  if (!paymentMethodId) return;
  const retired = await CardVerification.updateOne(
    { verificationId: row.verificationId, state: 'pending' },
    { $set: { state: 'refused', paymentMethodId } }
  );
  if (retired.modifiedCount === 1) await finishCardVerification(row.verificationId, row.userId, true);
}

/** Client secret of the caller's own unconfirmed setup, so the original Elements session can be reopened. */
export async function resumableVerificationSecret(verificationId: string, userId: string): Promise<string | null> {
  const record = await CardVerification.findOne({
    verificationId,
    userId,
    state: 'pending',
    environment: Config.STAGE,
    livemode: isProduction(),
  }).lean();
  if (!record?.setupIntentId || !record.customerId || !record.createdAt) return null;
  if (Date.now() - record.createdAt.getTime() > 23 * 3600000) return null;
  const intent = await stripe.setupIntents.retrieve(record.setupIntentId);
  const customer = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;
  if (
    intent.livemode !== record.livemode ||
    customer !== record.customerId ||
    intent.metadata?.verificationId !== verificationId ||
    intent.metadata?.purpose !== 'card_verification' ||
    intent.metadata?.environment !== record.environment ||
    !['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)
  )
    return null;
  return intent.client_secret;
}

export async function reconcileCardVerifications() {
  const rows = await CardVerification.find({
    environment: Config.STAGE,
    livemode: isProduction(),
    $or: [
      { state: 'verified' },
      { state: 'pending' },
      { state: 'refused', paymentMethodId: { $exists: true }, detached: false },
      {
        state: 'granted',
        $or: [
          { notifiedAt: null, createdAt: { $gte: new Date(Date.now() - NOTIFY_RETRY_WINDOW) } },
          { saveCard: false, detached: false },
        ],
      },
    ],
  })
    .sort({ updatedAt: 1 })
    .limit(100)
    .lean();
  let failures = 0;
  let runtime: Promise<CardVerificationDependencies> | undefined;
  for (const row of rows) {
    try {
      if (
        row.state === 'pending' &&
        (!row.createdAt || row.createdAt.getTime() < Date.now() - 23 * 3600000) &&
        (await expirePendingVerification(row))
      )
        continue;
      if (row.state === 'refused') await finishCardVerification(row.verificationId, row.userId, true);
      else {
        if (row.state === 'verified' && !row.saveCard)
          await finishCardVerification(row.verificationId, row.userId, true);
        if (row.state === 'pending' || row.state === 'verified') {
          runtime ??= cardVerificationRuntime();
          const deps = await runtime;
          if (!(await deps.policy()).enabled) {
            await releaseUngrantedCard(row);
            continue;
          }
          if (!(await cardAccountEligible(row.userId))) {
            if (row.state === 'pending' && !(await expirePendingVerification(row))) continue;
            await CardVerification.updateOne(
              { verificationId: row.verificationId, state: row.state },
              { $set: { state: 'refused' } }
            );
            await finishCardVerification(row.verificationId, row.userId, true);
            continue;
          }
          if (!row.setupIntentId) {
            await resumeCardVerificationSetup(row.verificationId, row.userId, deps);
            continue;
          }
        }
        await finishCardVerification(row.verificationId, row.userId);
      }
    } catch (error) {
      if (error instanceof CardVerificationRefused && ['ineligible', 'card_in_use'].includes(error.code))
        logger.warn('card-verification-recovery-refused', {
          verificationId: row.verificationId,
          state: row.state,
          code: error.code,
        });
      if (!(
        error instanceof CardVerificationRefused && ['unavailable', 'ineligible', 'card_in_use'].includes(error.code)
      ))
        failures += 1;
    } finally {
      await CardVerification.updateOne({ verificationId: row.verificationId }, { $set: { updatedAt: new Date() } });
    }
  }
  if (failures) throw new Error(`Verification recovery failed for ${failures} records`);
}

export async function verificationOffer(userId: string) {
  const runtime = await cardVerificationRuntime().catch((error: unknown) => {
    logger.warn('card-verification-offer-unavailable', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return cleanupRuntime();
  });
  const policy = await runtime.policy();
  const rows = await CardVerification.find({
    userId,
    environment: policy.environment,
    livemode: policy.livemode,
    $or: [
      { state: { $in: ['verified', 'granted'] } },
      { state: 'pending', createdAt: { $gte: new Date(Date.now() - DAY) } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const granted = await hasCardVerificationGrant(userId);
  return {
    available: policy.enabled && !granted && (await cardAccountEligible(userId)),
    credits: policy.cardUnlockCredits,
    saved: rows.filter(row => row.state === 'granted' && row.saveCard && !row.detached).map(row => row.verificationId),
    pending: rows
      .filter(
        row =>
          row.state === 'verified' ||
          (row.state === 'pending' && row.setupIntentId) ||
          (row.state === 'granted' && !row.detached && !row.saveCard)
      )
      .map(row => row.verificationId),
    siteKey: policy.enabled ? (await getTurnstilePolicy()).siteKey : '',
  };
}

export const verificationIdSchema = z.string().uuid();
export function verificationFailure(error: unknown) {
  if (!(error instanceof CardVerificationRefused)) throw error;
  if (error.code === 'not_found') return { status: 404, error: 'Verification not found.' };
  if (error.code === 'unavailable') return { status: 503, error: 'Card verification is unavailable.' };
  if (error.code === 'ineligible')
    return { status: 403, error: 'This account is not eligible for the card verification offer.' };
  if (error.code === 'card_in_use')
    return { status: 409, error: 'This card is in use as a payment method, so it cannot be removed here.' };
  return {
    status: 403,
    error:
      error.code === 'unsupported_card'
        ? 'This card is not supported. Use a non-prepaid credit or debit card without a wallet.'
        : 'This card could not qualify for an unlock.',
  };
}
