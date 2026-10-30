import {
  isCompSubscription,
  isTerminalSubscriptionStatus,
  type AdminSubscriptionDetail,
  type AdminSubscriptionRow,
} from '@client/app/utils/adminSubscriptionDetail';

/** Display helpers for the subscription detail page. Pure, so the action matrix is unit-testable. */

export const ADMIN_SUBSCRIPTIONS_TAB_SLUG = 'subscriptions';

export type SubscriptionAction = 'extend' | 'end' | 'credits' | 'remove';

export const ownerDisplayName = (row: Pick<AdminSubscriptionRow, 'owner'>): string => {
  const { owner } = row;
  if (!owner) return 'Deleted owner';
  if (owner.kind === 'Organization') return owner.name || 'Unnamed organization';
  return owner.name || owner.email || owner.username || 'Unnamed user';
};

/** Where the owner's admin page lives: users have a profile page, organizations open on the console tab. */
export type OwnerLink = { kind: 'user'; userId: string } | { kind: 'organization'; organizationId: string };

export const ownerLink = (row: Pick<AdminSubscriptionRow, 'owner'>): OwnerLink | null => {
  if (!row.owner) return null;
  return row.owner.kind === 'User'
    ? { kind: 'user', userId: row.owner.id }
    : { kind: 'organization', organizationId: row.owner.id };
};

/** A Stripe row that still bills: removing only our record would keep charging the customer. */
export const isLiveStripeSubscription = (row: Pick<AdminSubscriptionRow, 'source' | 'status'>): boolean =>
  row.source === 'stripe' && !isTerminalSubscriptionStatus(row.status);

export const REMOVE_LIVE_STRIPE_REASON = 'Cancel it first; removing the record alone keeps charging the customer.';
export const NO_ACTING_USER_REASON = 'No account can act for this owner: the user or billing owner no longer exists.';

export type SubscriptionActionAvailability = {
  /** Extend comp and End comp, the header's two buttons. */
  compActions: boolean;
  editCredits: { visible: boolean; disabledReason: string | null };
  remove: { disabledReason: string | null };
};

/** Which header actions a subscription offers (docs/admin-subscriptions-spec.md sections 5.2 and 7). */
export const subscriptionActionAvailability = (
  detail: Pick<AdminSubscriptionDetail, 'subscription' | 'actingUserId'>
): SubscriptionActionAvailability => {
  const { subscription, actingUserId } = detail;
  const terminal = isTerminalSubscriptionStatus(subscription.status);
  const noActor = actingUserId === null ? NO_ACTING_USER_REASON : null;
  return {
    compActions: isCompSubscription(subscription) && !terminal,
    editCredits: { visible: !terminal, disabledReason: noActor },
    remove: { disabledReason: isLiveStripeSubscription(subscription) ? REMOVE_LIVE_STRIPE_REASON : noActor },
  };
};

/** "12 Mar 2026", in UTC so a period boundary reads the same for every admin. */
export const formatDate = (value: string | Date | null | undefined): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 86400 * 365],
  ['month', 86400 * 30],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * "in 3 months" or "2 days ago". The shared RelativeTime is past-only, and a renewal or comp end is
 * usually ahead.
 */
export const relativeFromNow = (value: string | Date, now: number): string => {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const unit = RELATIVE_UNITS.find(([, size]) => Math.abs(seconds) >= size);
  return unit ? formatter.format(Math.round(seconds / unit[1]), unit[0]) : formatter.format(0, 'minute');
};

/** `months` calendar months after `from` (UTC), clamped to the month's last day: 31 Jan + 1 = 28/29 Feb. */
export const addMonths = (from: Date, months: number): Date => {
  const result = new Date(from.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
};

/** A lapsed comp, or one with no end date, extends from today, not from a past end date. */
export const compExtensionBase = (row: Pick<AdminSubscriptionRow, 'periodEndsAt'>, now: number): Date =>
  new Date(row.periodEndsAt ? Math.max(new Date(row.periodEndsAt).getTime(), now) : now);

export const INTERVAL_LABELS: Readonly<Record<string, string>> = { monthly: 'Monthly', yearly: 'Yearly' };

export const sourceLabel = (row: Pick<AdminSubscriptionRow, 'source' | 'subscriptionId'>): string =>
  isCompSubscription(row) ? 'Comp' : 'Stripe';

/**
 * The owner's other rows that look like duplicates: more than one live subscription across this row and
 * the others marks every live other one.
 */
export const possibleDuplicateIds = (
  detail: Pick<AdminSubscriptionDetail, 'subscription' | 'otherSubscriptions'>
): ReadonlySet<string> => {
  const live = [detail.subscription, ...detail.otherSubscriptions].filter(
    row => !isTerminalSubscriptionStatus(row.status)
  );
  if (live.length < 2) return new Set();
  return new Set(live.filter(row => row.id !== detail.subscription.id).map(row => row.id));
};

/** Props every action dialog takes; `onAudit` switches the page to the Admin log tab. */
export type SubscriptionDialogProps = {
  detail: AdminSubscriptionDetail;
  onClose: () => void;
  onAudit: () => void;
};

/** The audit reason of an undo, the same convention as the profile's Undo toasts. */
export const undoReason = (reason: string): string => `Undo: ${reason}`.slice(0, 500);
