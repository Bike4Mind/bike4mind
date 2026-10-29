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
  /**
   * The user id the per-user subscription routes (credits, remove) take: the owner, or an org's billing owner.
   * `null` when no such user exists, which disables those actions.
   */
  actingUserId: string | null;
};

export type AdminSubscriptionByStripeIdResponse = { id: string };
