import { createHmac, randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { CardVerification, type CardVerificationRecord } from './cardVerificationModel';
import { grantVerifiedCardCredits } from './grantVerifiedCardCredits';

export type CardVerificationPolicy = {
  enabled: boolean;
  cardUnlockCredits: number;
  identityKey: string;
  environment: string;
  livemode: boolean;
};

export type CardVerificationContext = {
  userId: string;
  turnstileToken: unknown;
  ip: string;
  asn: string;
  ipDigest?: string;
  entry?: 'exhaustion' | 'billing';
};

export interface CardVerificationGuards {
  /** Must enforce a single-use challenge and persistent account/IP/ASN attempt and daily failure limits. */
  authorizeAttempt(context: CardVerificationContext): Promise<void>;
  /** Must use supported provider evidence and refuse unknown, review, blocked and high-risk outcomes. */
  approveRisk(intent: Stripe.SetupIntent): Promise<boolean>;
  /** Must durably count distinct setup attempts and feed failure-spike alerts; webhook replays must not count twice. */
  recordFailure(intent: Stripe.SetupIntent, verification: CardVerificationRecord): Promise<void>;
  eligible(userId: string): Promise<boolean>;
}

export interface CardVerificationDependencies {
  stripe: Stripe;
  policy: () => Promise<CardVerificationPolicy>;
  guards?: CardVerificationGuards;
}

export class CardVerificationRefused extends Error {
  constructor(readonly code: 'unavailable' | 'not_found' | 'ineligible' | 'unsupported_card' | 'risk_refused') {
    super(`Card verification ${code}`);
  }
}

function configured(policy: CardVerificationPolicy, guards?: CardVerificationGuards): guards is CardVerificationGuards {
  return !!(
    policy.enabled &&
    guards &&
    policy.environment &&
    policy.identityKey.length >= 32 &&
    Number.isSafeInteger(policy.cardUnlockCredits) &&
    policy.cardUnlockCredits > 0
  );
}

function reference(value: string | { id: string } | null): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null);
}

function metadata(record: CardVerificationRecord) {
  return { purpose: 'card_verification', verificationId: record.verificationId, environment: record.environment };
}

export async function beginCardVerification(
  context: CardVerificationContext,
  saveCard: boolean,
  deps: CardVerificationDependencies
): Promise<{ verificationId: string; clientSecret: string }> {
  const policy = await deps.policy();
  if (!configured(policy, deps.guards)) throw new CardVerificationRefused('unavailable');
  if (!context.userId || !context.ip || !context.asn) throw new CardVerificationRefused('unavailable');
  if (!(await deps.guards.eligible(context.userId))) throw new CardVerificationRefused('ineligible');
  await deps.guards.authorizeAttempt(context);
  const record: CardVerificationRecord = {
    verificationId: randomUUID(),
    userId: context.userId,
    environment: policy.environment,
    livemode: policy.livemode,
    credits: policy.cardUnlockCredits,
    saveCard: saveCard === true,
    state: 'pending',
    detached: false,
    ipDigest: context.ipDigest,
    asn: context.asn,
    entry: context.entry,
  };
  await CardVerification.create(record);
  return resumeCardVerificationSetup(record.verificationId, context.userId, deps);
}

/** Server recovery only: a public retry must pass the challenge and attempt gate again. */
export async function resumeCardVerificationSetup(
  verificationId: string,
  userId: string,
  deps: CardVerificationDependencies
): Promise<{ verificationId: string; clientSecret: string }> {
  const policy = await deps.policy();
  if (!configured(policy, deps.guards)) throw new CardVerificationRefused('unavailable');
  const record = await CardVerification.findOne({ verificationId, userId }).lean();
  if (!record || record.environment !== policy.environment || record.livemode !== policy.livemode)
    throw new CardVerificationRefused('not_found');
  if (record.state !== 'pending' || !(await deps.guards.eligible(userId)))
    throw new CardVerificationRefused('ineligible');
  if (!record.createdAt || Date.now() - record.createdAt.getTime() > 23 * 60 * 60 * 1000)
    throw new CardVerificationRefused('unavailable');
  // A dedicated customer keeps default cleanup away from existing subscription payment methods.
  const customer = record.customerId
    ? await deps.stripe.customers.retrieve(record.customerId)
    : await deps.stripe.customers.create(
        { metadata: metadata(record) },
        { idempotencyKey: `card-verification:customer:${verificationId}` }
      );
  if (customer.deleted) throw new CardVerificationRefused('unavailable');
  if (
    customer.livemode !== record.livemode ||
    customer.metadata?.verificationId !== verificationId ||
    customer.metadata?.purpose !== 'card_verification' ||
    customer.metadata?.environment !== record.environment
  )
    throw new CardVerificationRefused('not_found');
  await CardVerification.updateOne({ verificationId }, { $set: { customerId: customer.id } });
  const intent = record.setupIntentId
    ? await deps.stripe.setupIntents.retrieve(record.setupIntentId)
    : await deps.stripe.setupIntents.create(
        {
          customer: customer.id,
          usage: 'on_session',
          payment_method_types: ['card'],
          payment_method_options: { card: { request_three_d_secure: 'any' } },
          metadata: metadata(record),
        },
        { idempotencyKey: `card-verification:setup:${verificationId}` }
      );
  if (
    !intent.client_secret ||
    intent.livemode !== record.livemode ||
    reference(intent.customer) !== customer.id ||
    intent.metadata?.verificationId !== verificationId ||
    intent.metadata?.purpose !== 'card_verification' ||
    intent.metadata?.environment !== record.environment
  )
    throw new CardVerificationRefused('not_found');
  await CardVerification.updateOne({ verificationId }, { $set: { setupIntentId: intent.id } });
  return { verificationId, clientSecret: intent.client_secret };
}

export async function completeCardVerification(
  verificationId: string,
  userId: string,
  deps: CardVerificationDependencies
): Promise<'granted' | 'already_granted' | 'pending' | 'refused'> {
  const policy = await deps.policy();
  if (!configured(policy, deps.guards)) throw new CardVerificationRefused('unavailable');
  const record = await CardVerification.findOne({ verificationId, userId }).lean();
  if (!record || record.environment !== policy.environment || record.livemode !== policy.livemode)
    throw new CardVerificationRefused('not_found');
  if (record.state === 'refused') {
    await removeVerificationCard(verificationId, userId, deps);
    return 'refused';
  }
  if (!record.setupIntentId || !record.customerId) throw new CardVerificationRefused('unavailable');
  if (record.state === 'pending') {
    const intent = await deps.stripe.setupIntents.retrieve(record.setupIntentId);
    if (
      intent.id !== record.setupIntentId ||
      intent.livemode !== record.livemode ||
      reference(intent.customer) !== record.customerId ||
      intent.metadata?.purpose !== 'card_verification' ||
      intent.metadata?.verificationId !== verificationId ||
      intent.metadata?.environment !== record.environment ||
      intent.usage !== 'on_session' ||
      intent.payment_method_types.length !== 1 ||
      intent.payment_method_types[0] !== 'card'
    )
      throw new CardVerificationRefused('not_found');
    if (intent.last_setup_error || intent.status === 'canceled') await deps.guards.recordFailure(intent, record);
    if (intent.status === 'canceled') {
      await CardVerification.updateOne({ verificationId, state: 'pending' }, { $set: { state: 'refused' } });
      return 'refused';
    }
    if (intent.status !== 'succeeded') return 'pending';
    const paymentMethodId = reference(intent.payment_method);
    if (!paymentMethodId) throw new CardVerificationRefused('unsupported_card');
    const method = await deps.stripe.paymentMethods.retrieve(paymentMethodId);
    if (
      method.id !== paymentMethodId ||
      reference(method.customer) !== record.customerId ||
      method.livemode !== record.livemode
    )
      throw new CardVerificationRefused('not_found');
    const supported =
      method.type === 'card' &&
      method.card?.fingerprint &&
      !method.card.wallet &&
      ['credit', 'debit'].includes(method.card.funding);
    await CardVerification.updateOne({ verificationId, state: 'pending' }, { $set: { paymentMethodId } });
    let approved: boolean;
    try {
      approved = !!supported && !intent.last_setup_error && (await deps.guards.approveRisk(intent));
    } catch (error) {
      await CardVerification.updateOne({ verificationId, state: 'pending' }, { $set: { state: 'refused' } });
      await removeVerificationCard(verificationId, userId, deps);
      throw error;
    }
    if (!approved) {
      await CardVerification.updateOne(
        { verificationId, state: 'pending' },
        { $set: { state: 'refused', paymentMethodId } }
      );
      try {
        await deps.guards.recordFailure(intent, record);
      } finally {
        await removeVerificationCard(verificationId, userId, deps);
      }
      throw new CardVerificationRefused(supported ? 'risk_refused' : 'unsupported_card');
    }
    const identityDigest = createHmac('sha256', policy.identityKey)
      .update(JSON.stringify(['stripe-card', record.environment, record.livemode, method.card!.fingerprint]))
      .digest('hex');
    await CardVerification.updateOne(
      { verificationId, state: 'pending' },
      { $set: { state: 'verified', paymentMethodId, identityDigest } }
    );
  }
  try {
    const outcome = await grantVerifiedCardCredits(verificationId, userId, deps.guards.eligible);
    if (outcome === 'refused') await removeVerificationCard(verificationId, userId, deps);
    return outcome;
  } finally {
    if (!record.saveCard) await removeVerificationCard(verificationId, userId, deps);
  }
}

export async function removeVerificationCard(
  verificationId: string,
  userId: string,
  { stripe, policy: readPolicy }: CardVerificationDependencies
): Promise<void> {
  const policy = await readPolicy();
  const record = await CardVerification.findOne({ verificationId, userId }).lean();
  if (!record || record.environment !== policy.environment || record.livemode !== policy.livemode)
    throw new CardVerificationRefused('not_found');
  if (record.detached || !record.paymentMethodId || !record.customerId) return;
  const method = await stripe.paymentMethods.retrieve(record.paymentMethodId);
  if (method.livemode !== record.livemode) throw new CardVerificationRefused('not_found');
  if (method.customer !== null) {
    if (reference(method.customer) !== record.customerId) throw new CardVerificationRefused('not_found');
    const customer = await stripe.customers.retrieve(record.customerId);
    if (
      customer.deleted ||
      customer.livemode !== record.livemode ||
      customer.metadata?.verificationId !== verificationId ||
      customer.metadata?.purpose !== 'card_verification' ||
      customer.metadata?.environment !== record.environment ||
      customer.invoice_settings.default_payment_method ||
      customer.default_source
    )
      throw new CardVerificationRefused('ineligible');
    for await (const subscription of stripe.subscriptions.list({ customer: record.customerId, status: 'all' })) {
      if (!['canceled', 'incomplete_expired'].includes(subscription.status))
        throw new CardVerificationRefused('ineligible');
    }
    await stripe.paymentMethods.detach(record.paymentMethodId);
  }
  await CardVerification.updateOne(
    { verificationId, userId },
    { $set: { detached: true }, $unset: { paymentMethodId: 1 } }
  );
}
