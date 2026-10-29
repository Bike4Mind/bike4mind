import type { AdminSubscriptionRow, SubscriptionStatusFilter } from '@client/app/utils/adminSubscriptionsFilter';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

/**
 * The one status vocabulary for subscriptions (docs/admin-subscriptions-spec.md section 5.4): the list,
 * and later the detail page, profile cards and the org list, all read it from here.
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

const isKnownStatus = (status: string): status is SubscriptionStatusFilter => status in SUBSCRIPTION_STATUS_DISPLAY;

/** Active with a cancel requested (Stripe's canceled_at, stored verbatim) reads as Canceling until the period ends. */
export function subscriptionStatusDisplay(
  row: Pick<AdminSubscriptionRow, 'status' | 'canceledAt'>
): SubscriptionStatusDisplay {
  if (row.status === 'active' && row.canceledAt) return CANCELING;
  return isKnownStatus(row.status)
    ? SUBSCRIPTION_STATUS_DISPLAY[row.status]
    : { label: row.status || 'Unknown', tone: 'neutral' };
}

// Every admin grant, ended ones too: a revoked comp in the Churned view must not read as a lost payer.
export const isCompedRow = (row: Pick<AdminSubscriptionRow, 'source'>): boolean => row.source === 'admin_grant';
