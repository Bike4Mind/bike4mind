import { z } from 'zod';
import type { AdminSubscriptionRow } from './adminSubscriptionsFilter';

export type { AdminSubscriptionRow };

/**
 * The admin subscription detail page's contract, shared by the page and its routes under
 * /api/admin/subscriptions/[id]. Pure and React-free: the server imports it. See
 * docs/admin-subscriptions-spec.md sections 5.2 and 7.
 */

// Must stay in sync with TERMINAL_SUBSCRIPTION_STATUSES in packages/server-utils/src/lib/subscriptions/types.ts,
// which the client bundle cannot import.
export const TERMINAL_SUBSCRIPTION_STATUS_VALUES: readonly string[] = ['canceled', 'incomplete_expired'];

export const isTerminalSubscriptionStatus = (status: string): boolean =>
  TERMINAL_SUBSCRIPTION_STATUS_VALUES.includes(status);

// Must stay in sync with resolveSubscriptionSource in packages/server-utils/src/lib/subscriptions/types.ts: a
// pre-migration row has no `source` (the list maps it to 'stripe') and is a comp only by this id prefix.
export const LEGACY_COMP_SUBSCRIPTION_ID_PREFIX = 'admin_granted_';

/** Comps live only in Mongo, so a comp is extended, ended or reopened here and never at Stripe. */
export const isCompSubscription = (row: Pick<AdminSubscriptionRow, 'source' | 'subscriptionId'>): boolean =>
  row.source === 'admin_grant' || row.subscriptionId.startsWith(LEGACY_COMP_SUBSCRIPTION_ID_PREFIX);

/** Furthest a comp end date may be set, in months from now. */
export const COMP_MAX_MONTHS_AHEAD = 60;

/**
 * Body of POST /api/admin/subscriptions/[id]/comp, plus the audited `reason`. Each change is its own undo:
 * `setEndsAt` restores the previous end date, `reopen` reverses `end`.
 */
export const AdminCompChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('setEndsAt'), periodEndsAt: z.iso.datetime() }),
  z.object({ action: z.literal('end') }),
  z.object({ action: z.literal('reopen') }),
]);
export type AdminCompChange = z.infer<typeof AdminCompChangeSchema>;

export type AdminCompChangeResponse = { subscription: AdminSubscriptionRow };

/**
 * Body of POST /api/admin/subscriptions/[id]/sync, plus the audited `reason`. `expectedUpdatedAt` is the
 * row version the admin previewed; a row changed since then is a 409.
 */
export const AdminSubscriptionSyncSchema = z.object({ expectedUpdatedAt: z.iso.datetime() });
export type AdminSubscriptionSync = z.infer<typeof AdminSubscriptionSyncSchema>;

/** One value Sync from Stripe would change. Dates are ISO strings, absent values null. */
export type AdminSubscriptionSyncChange = { field: string; before: string | null; after: string | null };

/** Response of GET /api/admin/subscriptions/[id]/sync: a live Stripe read, nothing written. */
export type AdminSubscriptionSyncPreview = {
  changes: AdminSubscriptionSyncChange[];
  /** Stripe has no such subscription, so Sync marks the row canceled. */
  stripeMissing: boolean;
  stripeStatus: string | null;
  /** The row version to send back as `expectedUpdatedAt`. */
  updatedAt: string;
};

export type AdminSubscriptionSyncResponse = {
  subscription: AdminSubscriptionRow;
  changes: AdminSubscriptionSyncChange[];
};

type DateLike = Date | string | null | undefined;

const isoOrNull = (value: DateLike): string | null => (value ? new Date(value).toISOString() : null);

/** A cancellation is scheduled by the period-end flag or by a custom cancel date. The routes and the model share it. */
export const isScheduledToCancel = (subscription: {
  cancelAtPeriodEnd?: boolean | null;
  cancelAt?: DateLike;
}): boolean => Boolean(subscription.cancelAtPeriodEnd || subscription.cancelAt);

/**
 * The business state an admin reviews before a Stripe write. It deliberately leaves out `lastSyncedAt`: our own
 * customer.subscription.updated webhook re-stamps that seconds after every write without changing anything the admin
 * looked at, so a stamp compare would 409 the Undo.
 */
export const stripeStateToken = (subscription: {
  status?: string;
  cancelAtPeriodEnd?: boolean | null;
  cancelAt?: DateLike;
  periodEndsAt?: DateLike;
}): string =>
  JSON.stringify([
    subscription.status ?? null,
    Boolean(subscription.cancelAtPeriodEnd),
    isoOrNull(subscription.cancelAt),
    isoOrNull(subscription.periodEndsAt),
  ]);

/** Mirror state a Stripe-write action is previewed against; `stateToken` is what the write sends back. */
export type AdminSubscriptionStripeState = {
  lastSyncedAt: string | null;
  cancelAtPeriodEnd: boolean;
  stateToken: string;
};

export const stripeStateOf = (doc: {
  status?: string;
  cancelAtPeriodEnd?: boolean | null;
  cancelAt?: DateLike;
  periodEndsAt?: DateLike;
  lastSyncedAt?: DateLike;
}): AdminSubscriptionStripeState => ({
  lastSyncedAt: isoOrNull(doc.lastSyncedAt),
  cancelAtPeriodEnd: Boolean(doc.cancelAtPeriodEnd),
  stateToken: stripeStateToken(doc),
});

/**
 * Body of the admin Stripe-write routes (cancel, resume) under /api/admin/subscriptions/[id]. The key is minted
 * once per dialog open and reused across retries; `expectedState` is the `stripe.stateToken` the admin reviewed.
 */
export const AdminStripeWriteBodySchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  expectedState: z.string().min(1).max(256),
});
export type AdminStripeWriteBody = z.infer<typeof AdminStripeWriteBodySchema>;

export type AdminStripeWriteResponse = { subscription: AdminSubscriptionRow; stripe: AdminSubscriptionStripeState };

export type AdminSubscriptionCreditGrant = {
  id: string;
  credits: number;
  createdAt: string;
};

export type AdminSubscriptionSeats = {
  /** `Subscription.quantity`: the seats this plan pays for. */
  paid: number;
  /** `organization.seats`: the seats the org may fill. Disagreeing with `paid` is a reconciliation finding. */
  organizationSeats: number | null;
  /** Members plus the owner, the same count seat validation uses. */
  members: number;
  min: number;
  max: number;
};

/** Response of GET /api/admin/subscriptions/[id]. Everything here comes from Mongo; Stripe-live data does not. */
export type AdminSubscriptionDetail = {
  subscription: AdminSubscriptionRow;
  grantedBy: string | null;
  grantedReason: string | null;
  credits: {
    /** The plan's own rate; `null` when the price id is not in the catalog. */
    defaultPerCycle: number | null;
    /** `Subscription.customCreditsPerCycle`, the admin override. */
    customPerCycle: number | null;
    effectivePerCycle: number | null;
    /** The owner's latest subscription-type ledger rows, newest first. */
    recentGrants: AdminSubscriptionCreditGrant[];
  };
  /** The owner's current balance; `null` when the owner record is gone. */
  ownerCredits: number | null;
  /** The owner's other subscription rows, newest first; a second live one is a duplicate to look at. */
  otherSubscriptions: AdminSubscriptionRow[];
  /** Organization-owned rows only. */
  seats: AdminSubscriptionSeats | null;
  /** The open reconciliation finding for this row, or null when Mongo and Stripe agree as of the last run. */
  mismatch: {
    kind: 'drift' | 'orphan_stripe' | 'orphan_mongo';
    /** Display strings, dates as ISO; the Mongo value is null when the row has none. */
    fields: { field: string; mongo: string | null; stripe: string | null }[];
    firstSeenAt: string;
    lastSeenAt: string;
  } | null;
  /**
   * The user id the per-user subscription routes (credits, remove) take: the owner, or an org's billing owner.
   * `null` when no such user exists, which disables those actions.
   */
  actingUserId: string | null;
  /** Mirror state the Stripe-write actions are previewed against; `null` for comps, which never touch Stripe. */
  stripe: AdminSubscriptionStripeState | null;
};

export type AdminSubscriptionByStripeIdResponse = { id: string };
