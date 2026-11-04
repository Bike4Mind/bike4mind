import { billingEventRepository, organizationRepository, userRepository } from '@bike4mind/database';
import type { BillingEventData, BillingEventOwnerType } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { Config } from '@bike4mind/server-utils/utils/config';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';

export type BillingEventOwner = { ownerType: BillingEventOwnerType; ownerId: string };

/** What a webhook branch already knows and the event payload cannot tell. */
export type BillingEventHints = { owner?: BillingEventOwner; data?: Partial<BillingEventData> };

export type StripeEventLike = {
  id: string;
  type: string;
  created: number;
  data: { object: unknown; previous_attributes?: unknown };
};

export type BillingEventProjection = {
  subscriptionId: string | null;
  customerId: string | null;
  /** The `metadata.stage` (or a credit pack's `metadata.environment`) the object carries, if any. */
  stage: string | null;
  metadataOwner: BillingEventOwner | null;
  amount: number | null;
  currency: string | null;
  data: BillingEventData;
};

export type RecordBillingEventOutcome = 'recorded' | 'duplicate' | 'foreign_stage' | 'unowned' | 'failed';

type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
/** A Stripe reference is an id string, or the expanded object. */
const idOf = (value: unknown): string | undefined => str(value) ?? str(asObj(value)?.id);
const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => asObj(current)?.[key], value);
const firstItem = (subscription: unknown): Obj | undefined => {
  const items = at(subscription, 'items', 'data');
  return Array.isArray(items) ? asObj(items[0]) : undefined;
};

const ownerFromMetadata = (metadata: unknown): BillingEventOwner | null => {
  const organizationId = str(at(metadata, 'organizationId'));
  if (organizationId) return { ownerType: 'organization', ownerId: organizationId };
  const userId = str(at(metadata, 'userId'));
  return userId ? { ownerType: 'user', ownerId: userId } : null;
};

/** Drops undefined keys and empty arrays so the stored projection stays small. */
const compact = (data: BillingEventData): BillingEventData =>
  Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
  ) as BillingEventData;

const projectInvoice = (event: StripeEventLike, invoice: Obj): BillingEventProjection => {
  const details = asObj(at(invoice, 'parent', 'subscription_details')) ?? asObj(invoice.subscription_details);
  const metadata = details?.metadata;
  const failed = event.type === 'invoice.payment_failed';
  return {
    subscriptionId: idOf(details?.subscription) ?? idOf(invoice.subscription) ?? null,
    customerId: idOf(invoice.customer) ?? null,
    stage: str(at(metadata, 'stage')) ?? null,
    metadataOwner: ownerFromMetadata(metadata),
    amount: (failed ? num(invoice.amount_due) : (num(invoice.amount_paid) ?? num(invoice.amount_due))) ?? null,
    currency: str(invoice.currency) ?? null,
    data: {
      invoiceId: str(invoice.id),
      paymentIntentId: idOf(invoice.payment_intent),
      status: str(invoice.status),
      billingReason: str(invoice.billing_reason),
      attemptCount: num(invoice.attempt_count),
    },
  };
};

const projectSubscription = (event: StripeEventLike, subscription: Obj): BillingEventProjection => {
  const item = firstItem(subscription);
  const previous = asObj(event.data.previous_attributes);
  const previousItem = previous && firstItem(previous);
  return {
    subscriptionId: str(subscription.id) ?? null,
    customerId: idOf(subscription.customer) ?? null,
    stage: str(at(subscription, 'metadata', 'stage')) ?? null,
    metadataOwner: ownerFromMetadata(subscription.metadata),
    amount: null,
    currency: str(subscription.currency) ?? null,
    data: {
      status: str(subscription.status),
      priceId: idOf(item?.price),
      quantity: num(item?.quantity) ?? num(subscription.quantity),
      cancelAtPeriodEnd: bool(subscription.cancel_at_period_end),
      reason: str(at(subscription, 'cancellation_details', 'reason')),
      ...(previous && {
        previousStatus: str(previous.status),
        previousPriceId: idOf(previousItem?.price),
        previousQuantity: num(previousItem?.quantity) ?? num(previous.quantity),
        previousCancelAtPeriodEnd: bool(previous.cancel_at_period_end),
      }),
    },
  };
};

const projectOther = (event: StripeEventLike, object: Obj): BillingEventProjection => {
  const base = {
    subscriptionId: null,
    customerId: idOf(object.customer) ?? null,
    stage: str(at(object, 'metadata', 'stage')) ?? str(at(object, 'metadata', 'environment')) ?? null,
    metadataOwner: null,
    currency: str(object.currency) ?? null,
  };
  switch (str(object.object)) {
    case 'charge': {
      const refunds = at(object, 'refunds', 'data');
      return {
        ...base,
        amount: (event.type === 'charge.refunded' ? num(object.amount_refunded) : num(object.amount)) ?? null,
        data: {
          chargeId: str(object.id),
          paymentIntentId: idOf(object.payment_intent),
          status: str(object.status),
          refundIds: Array.isArray(refunds)
            ? refunds.map(refund => idOf(refund)).filter(id => id !== undefined)
            : undefined,
        },
      };
    }
    case 'dispute':
      return {
        ...base,
        amount: num(object.amount) ?? null,
        data: {
          disputeId: str(object.id),
          chargeId: idOf(object.charge),
          paymentIntentId: idOf(object.payment_intent),
          status: str(object.status),
          reason: str(object.reason),
        },
      };
    case 'payment_intent':
      return {
        ...base,
        metadataOwner: ownerFromMetadata(object.metadata),
        // `||`, not `??`: an amount_received of 0 means nothing was captured yet, so show the intended amount.
        amount: num(object.amount_received) || num(object.amount) || null,
        data: { paymentIntentId: str(object.id), status: str(object.status) },
      };
    case 'checkout.session':
      return {
        ...base,
        subscriptionId: idOf(object.subscription) ?? null,
        amount: num(object.amount_total) ?? null,
        data: { status: str(object.status), paymentIntentId: idOf(object.payment_intent) },
      };
    case 'customer':
      return { ...base, customerId: str(object.id) ?? null, amount: null, data: {} };
    default:
      return {
        ...base,
        amount: null,
        data: {
          chargeId: idOf(object.charge),
          paymentIntentId: idOf(object.payment_intent),
          reason: str(object.reason),
        },
      };
  }
};

/** The fields a BillingEvent keeps, read from the payload alone. Pure; never copies card or payment-method data. */
export const projectStripeEvent = (event: StripeEventLike): BillingEventProjection => {
  const object = asObj(event.data.object) ?? {};
  const kind = str(object.object);
  const projection =
    kind === 'invoice'
      ? projectInvoice(event, object)
      : kind === 'subscription'
        ? projectSubscription(event, object)
        : projectOther(event, object);
  return { ...projection, data: compact({ objectId: str(object.id), ...projection.data }) };
};

const toOwner = (row: { ownerType: string; ownerId: string }): BillingEventOwner => ({
  ownerType: row.ownerType === SubscriptionOwnerType.Organization ? 'organization' : 'user',
  ownerId: row.ownerId,
});

/**
 * The owner this stage knows for the event, from local rows only (no Stripe calls): the subscription row,
 * then the customer's user or organization.
 */
const resolveLocalOwner = async (projection: BillingEventProjection): Promise<BillingEventOwner | null> => {
  if (projection.subscriptionId) {
    const row = await subscriptionRepository.findByStripeSubscriptionId(projection.subscriptionId);
    if (row) return toOwner(row);
  }
  if (projection.customerId) {
    const user = await userRepository.findByStripeCustomerId(projection.customerId);
    if (user) return { ownerType: 'user', ownerId: user.id };
    const organization = await organizationRepository.findByStripeCustomerId(projection.customerId);
    if (organization) return { ownerType: 'organization', ownerId: organization.id };
  }
  return null;
};

/**
 * Stores one Stripe event as a BillingEvent (docs/admin-subscriptions-spec.md 6.2). The webhook calls it once
 * the event's side effects succeeded, so a failed delivery leaves no row and its redelivery re-runs them.
 * Stage ownership is checked first: an object stamped with another stage is never stored, and an unstamped
 * one only when this stage has a local owner for it. Never throws: the side effects already landed, and a
 * 500 here would make Stripe repeat them.
 */
export async function recordBillingEvent(
  event: StripeEventLike,
  hints: BillingEventHints,
  logger: Logger
): Promise<RecordBillingEventOutcome> {
  try {
    const projection = projectStripeEvent(event);
    if (projection.stage && projection.stage !== Config.STAGE) {
      logger.debug(`Not storing billing event ${event.id}: stage ${projection.stage} is not ours`);
      return 'foreign_stage';
    }

    const localOwner = hints.owner ?? (await resolveLocalOwner(projection));
    if (!projection.stage && !localOwner) {
      logger.debug(`Not storing billing event ${event.id}: no owner in this stage`);
      return 'unowned';
    }
    const owner = localOwner ?? projection.metadataOwner;

    const inserted = await billingEventRepository.record({
      stripeEventId: event.id,
      type: event.type,
      ownerType: owner?.ownerType ?? null,
      ownerId: owner?.ownerId ?? null,
      subscriptionId: projection.subscriptionId,
      amount: projection.amount,
      currency: projection.currency,
      occurredAt: new Date(event.created * 1000),
      data: compact({ ...projection.data, ...hints.data }),
    });
    return inserted ? 'recorded' : 'duplicate';
  } catch (error) {
    logger.error(`Failed to store billing event ${event.id}`, { error });
    await emitMetric('Lumina5/Billing', 'BillingEventRecordFailed', 1, { type: event.type });
    return 'failed';
  }
}
