import type {
  AdminSubscriptionOwnerAlert,
  AdminSubscriptionRow,
  SubscriptionStatusFilter,
} from '@client/app/utils/adminSubscriptionsFilter';
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

/** Shown beside the status chip of a live subscription that still bills a deleted or blocked account. */
export const OWNER_ALERT_DISPLAY: Readonly<
  Record<AdminSubscriptionOwnerAlert, SubscriptionStatusDisplay & { title: string }>
> = {
  owner_deleted: {
    label: 'Owner deleted',
    tone: 'bad',
    title: 'The paying account is deleted but Stripe still bills it. Cancel it in Stripe.',
  },
  owner_blocked: {
    label: 'Owner blocked',
    tone: 'bad',
    title: 'The paying account is banned, suspended or disputed but Stripe still bills it. Cancel it in Stripe.',
  },
};

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
