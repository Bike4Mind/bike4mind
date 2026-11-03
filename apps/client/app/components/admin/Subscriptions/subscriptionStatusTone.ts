import type { AdminSubscriptionRow, SubscriptionStatusFilter } from '@client/app/utils/adminSubscriptionsFilter';
import { isCompSubscription, isTerminalSubscriptionStatus } from '@client/app/utils/adminSubscriptionDetail';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

/**
 * The one status vocabulary for subscriptions (docs/admin-subscriptions-spec.md section 5.4): the list, the
 * detail page and the profile summary card all read it from here.
 */

export type SubscriptionStatusDisplay = { label: string; tone: AdminStatusTone };

export const SUBSCRIPTION_STATUS_DISPLAY: Readonly<Record<SubscriptionStatusFilter, SubscriptionStatusDisplay>> = {
  active: { label: 'Active', tone: 'good' },
  trialing: { label: 'Trial', tone: 'info' },
  past_due: { label: 'Past due', tone: 'warn' },
  unpaid: { label: 'Unpaid', tone: 'bad' },
  incomplete: { label: 'Incomplete', tone: 'warn' },
  incomplete_expired: { label: 'Expired', tone: 'neutral' },
  // An outcome, not a fault (DESIGN_GUIDE "Status tones").
  canceled: { label: 'Canceled', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'neutral' },
};

const CANCELING: SubscriptionStatusDisplay = { label: 'Canceling', tone: 'warn' };

/** Shown beside the status chip of an admin grant. Comps are not revenue, so they never show a price. */
export const COMPED_DISPLAY: SubscriptionStatusDisplay = { label: 'Comped', tone: 'neutral' };

/** The fields that decide a status chip; a list row and a profile subscription both carry them. */
export type SubscriptionStatusFields = {
  status: string;
  cancelAt?: Date | string | null;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date | string | null;
};

const isKnownStatus = (status: string): status is SubscriptionStatusFilter => status in SUBSCRIPTION_STATUS_DISPLAY;

/**
 * A live row with a cancel on the way. Stripe's canceled_at is stored verbatim, so on a live row it is the
 * request time: it counts alongside the mirrored cancelAt/cancelAtPeriodEnd until those are backfilled.
 */
export const isCancelScheduled = (row: SubscriptionStatusFields): boolean =>
  !isTerminalSubscriptionStatus(row.status) && (!!row.cancelAt || !!row.cancelAtPeriodEnd || !!row.canceledAt);

export function subscriptionStatusDisplay(row: SubscriptionStatusFields): SubscriptionStatusDisplay {
  if ((row.status === 'active' || row.status === 'trialing') && isCancelScheduled(row)) return CANCELING;
  return isKnownStatus(row.status)
    ? SUBSCRIPTION_STATUS_DISPLAY[row.status]
    : { label: row.status || 'Unknown', tone: 'neutral' };
}

// Every admin grant, ended ones too: a revoked comp in the Churned view must not read as a lost payer.
export const isCompedRow = (row: Pick<AdminSubscriptionRow, 'source' | 'subscriptionId'>): boolean =>
  isCompSubscription(row);
