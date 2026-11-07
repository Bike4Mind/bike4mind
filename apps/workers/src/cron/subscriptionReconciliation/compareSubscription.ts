import {
  SEAT_BILLING_STATUSES,
  stripeSubscriptionRowFields,
  type StripeSubscriptionRowSource,
} from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import type { ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';

/** A recent row write, Stripe creation or cancellation may still have its webhook in flight. */
export const GRACE_MS = 30 * 60 * 1000;

export interface MismatchField {
  field: string;
  mongo: string | null;
  stripe: string | null;
}

export type ComparableRow = Pick<
  ISubscription,
  'status' | 'priceId' | 'quantity' | 'periodEndsAt' | 'cancelAtPeriodEnd' | 'unitAmount'
> & { updatedAt?: Date };

type Value = string | number | boolean | Date | null | undefined;

// Dates compare to the second: Stripe's have no sub-second part, Mongo's might.
const text = (value: Value): string | null | undefined =>
  value === undefined
    ? undefined
    : value === null
      ? null
      : String(value instanceof Date ? Math.floor(value.getTime() / 1000) : value);

/**
 * Where a row and Stripe's subscription disagree, over the fields the Stripe-wins write sets (it
 * compares `stripeSubscriptionRowFields`, which Sync writes). A mirror field the row never recorded
 * (undefined, a row not yet backfilled) is not comparable and not flagged. `orgSeats` is the owning
 * organization's seat count, compared with Stripe's billed quantity. No Stripe or database access.
 */
export function diffSubscription(
  row: ComparableRow,
  stripeSub: StripeSubscriptionRowSource,
  orgSeats?: number
): MismatchField[] {
  const stripe = stripeSubscriptionRowFields(stripeSub);
  const fields: MismatchField[] = [];
  const check = (field: string, mongo: Value, stripeValue: Value) => {
    const [m, s] = [text(mongo), text(stripeValue)];
    if (m !== undefined && m !== s) fields.push({ field, mongo: m, stripe: s ?? null });
  };

  check('status', row.status, stripe.status);
  check('priceId', row.priceId, stripe.priceId);
  check('quantity', row.quantity, stripe.quantity);
  check('periodEndsAt', row.periodEndsAt, stripe.periodEndsAt);
  check('cancelAtPeriodEnd', row.cancelAtPeriodEnd, stripe.cancelAtPeriodEnd);
  check('unitAmount', row.unitAmount, stripe.unitAmount);
  // A subscription that is not billing (incomplete, unpaid, paused) does not set the organization's seats.
  if (SEAT_BILLING_STATUSES.has(stripe.status)) check('seats', orgSeats, stripe.quantity);
  return fields;
}

/**
 * Whether a Stripe subscription belongs to this stage: stamped with it at checkout, or, for a
 * subscription that predates the stamp, production only. Same rule as the credit purchase cron.
 */
export function isStageSubscription(sub: { metadata?: Record<string, string> | null }, stage: string): boolean {
  const stamped = sub.metadata?.stage;
  return stamped ? stamped === stage : stage === 'production';
}

/** Stripe exposes creation and cancellation times, but no general subscription update timestamp. */
export function withinGrace(
  row: { updatedAt?: Date } | null,
  stripeSub: { created: number; canceled_at?: number | null },
  now: Date
): boolean {
  const cutoff = now.getTime() - GRACE_MS;
  return (
    Math.max(stripeSub.created, stripeSub.canceled_at ?? 0) * 1000 > cutoff || (row?.updatedAt?.getTime() ?? 0) > cutoff
  );
}
