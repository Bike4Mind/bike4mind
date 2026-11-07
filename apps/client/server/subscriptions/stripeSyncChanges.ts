import type { AdminSubscriptionSyncChange } from '@client/app/utils/adminSubscriptionDetail';
import type { ApplyStripeSubscriptionStateResult } from './applyStripeSubscriptionState';

// Every value applyStripeSubscriptionState writes except lastSyncedAt, which changes on every run.
const SYNCED_FIELDS = [
  'status',
  'priceId',
  'quantity',
  'periodStartsAt',
  'periodEndsAt',
  'canceledAt',
  'unitAmount',
  'currency',
  'interval',
  'intervalCount',
  'cancelAtPeriodEnd',
  'cancelAt',
  'trialEndsAt',
  'stripeCustomerId',
] as const;

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);

/**
 * The values a Stripe-wins write changes: each synced field whose value differs between the row it
 * replaced and what it wrote, plus the organization's seats. An absent value and null count as equal.
 */
export function stripeSyncChanges(
  result: Pick<ApplyStripeSubscriptionStateResult, 'before' | 'after' | 'seats'>
): AdminSubscriptionSyncChange[] {
  const { before, after, seats } = result;
  const changes: AdminSubscriptionSyncChange[] = [];
  for (const field of SYNCED_FIELDS) {
    const [was, now] = [text(before?.[field]), text(after[field])];
    if (was !== now) changes.push({ field, before: was, after: now });
  }
  if (seats && seats.before !== seats.after) {
    changes.push({ field: 'seats', before: String(seats.before), after: String(seats.after) });
  }
  return changes;
}
