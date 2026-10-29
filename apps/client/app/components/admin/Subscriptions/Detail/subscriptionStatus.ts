import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import type { AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionDetail';
import { isCompSubscription, isTerminalSubscriptionStatus } from '@client/app/utils/adminSubscriptionDetail';

/**
 * The status vocabulary of docs/admin-subscriptions-spec.md section 5.4, for the detail page and the profile
 * summary card. The redesigned list ships its own copy; fold the two together once both are on main.
 */

export type SubscriptionStatusDisplay = { label: string; tone: AdminStatusTone };

const STATUS_DISPLAY: Readonly<Record<string, SubscriptionStatusDisplay>> = {
  active: { label: 'Active', tone: 'good' },
  trialing: { label: 'Trial', tone: 'info' },
  past_due: { label: 'Past due', tone: 'warn' },
  unpaid: { label: 'Unpaid', tone: 'bad' },
  incomplete: { label: 'Incomplete', tone: 'warn' },
  // Neutral, not bad: an ended subscription is an outcome, not a fault.
  incomplete_expired: { label: 'Expired', tone: 'neutral' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'neutral' },
};

const CANCELING: SubscriptionStatusDisplay = { label: 'Canceling', tone: 'warn' };

/** The fields that decide a status chip; a list row and a profile subscription both carry them. */
export type SubscriptionStatusFields = {
  status: string;
  cancelAt?: Date | string | null;
  cancelAtPeriodEnd?: boolean;
};

export const isCancelScheduled = (row: SubscriptionStatusFields): boolean =>
  !isTerminalSubscriptionStatus(row.status) && (!!row.cancelAt || !!row.cancelAtPeriodEnd);

export const subscriptionStatusDisplay = (row: SubscriptionStatusFields): SubscriptionStatusDisplay => {
  if ((row.status === 'active' || row.status === 'trialing') && isCancelScheduled(row)) return CANCELING;
  return STATUS_DISPLAY[row.status] ?? { label: row.status, tone: 'neutral' };
};

/** The "Comped" chip shown next to the status chip; a comp that has ended is just Canceled. */
export const showsCompedChip = (row: Pick<AdminSubscriptionRow, 'source' | 'status' | 'subscriptionId'>): boolean =>
  isCompSubscription(row) && !isTerminalSubscriptionStatus(row.status);
