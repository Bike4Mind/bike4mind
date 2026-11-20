import { Types } from 'mongoose';
import {
  adminAuditLogRepository,
  billingEventRepository,
  CREDIT_BALANCE_EVENT_TYPES,
  CreditTransaction,
} from '@bike4mind/database';
import {
  billingEventSummary,
  CreditHolderType,
  type AuditLogCursor,
  type SubscriptionTimelineItem,
  type SubscriptionTimelineKind,
} from '@bike4mind/common';
import { createdAtCursorClauses } from './userActivity';

const QUERY_MAX_TIME_MS = 15_000;

/** Stripe events that name no subscription but belong on the owner's subscription Timeline. */
export const OWNER_LEVEL_BILLING_EVENT_TYPES = [
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
  'radar.early_fraud_warning.created',
  'customer.deleted',
] as const;

/** Refund and dispute clawbacks always land on the paying user (pages/api/stripe/webhook.ts). */
const CLAWBACK_REASONS = ['refund_clawback', 'dispute_clawback'] as const;

export type SubscriptionTimelineSubject = {
  /** The Mongo `_id`; org revoke audits name it instead of the Stripe id. */
  id: string;
  /** `sub_...` for Stripe-billed rows, `admin_grant_...` for comps. */
  stripeSubscriptionId: string | null;
  owner: { kind: 'user' | 'organization'; id: string };
};

type PageOptions = { limit: number; cursor?: AuditLogCursor };

type SourcePage = { items: SubscriptionTimelineItem[]; hasMore: boolean };

const EMPTY: SourcePage = { items: [], hasMore: false };

const fetchBillingItems = async (subject: SubscriptionTimelineSubject, page: PageOptions): Promise<SourcePage> => {
  const subscriptionId = subject.stripeSubscriptionId;
  if (!subscriptionId) return EMPTY;
  // A comp has no Stripe events of its own, so the owner's refunds and disputes would be about something else.
  const stripeBilled = subscriptionId.startsWith('sub_');
  const { records, hasMore } = await billingEventRepository.listForSubscription(
    {
      subscriptionId,
      ...(stripeBilled && {
        owner: { ownerType: subject.owner.kind, ownerId: subject.owner.id },
        ownerLevelTypes: OWNER_LEVEL_BILLING_EVENT_TYPES,
      }),
    },
    page
  );
  return {
    items: records.map(record => ({
      kind: 'billing',
      id: record.id,
      occurredAt: record.occurredAt,
      type: record.type,
      summary: billingEventSummary(record.type, record.data ?? {}),
      stripeEventId: record.stripeEventId,
      amount: record.amount,
      currency: record.currency,
      data: record.data ?? {},
    })),
    hasMore,
  };
};

const fetchAdminItems = async (subject: SubscriptionTimelineSubject, page: PageOptions): Promise<SourcePage> => {
  const { entries, nextCursor } = await adminAuditLogRepository.listForSubscriptionOrOwner(
    {
      owner: subject.owner,
      subscriptionIds: subject.stripeSubscriptionId ? [subject.stripeSubscriptionId, subject.id] : [subject.id],
    },
    page
  );
  return {
    items: entries.map(audit => ({
      kind: 'admin',
      id: audit.id,
      occurredAt: audit.occurredAt,
      type: audit.action,
      summary: audit.summary,
      audit,
    })),
    hasMore: nextCursor !== null,
  };
};

type CreditRow = {
  _id: Types.ObjectId;
  type: string;
  credits: number;
  reason?: string;
  description?: string;
  createdAt: Date;
};

const formatSignedCredits = (credits: number): string =>
  `${credits > 0 ? '+' : credits < 0 ? '-' : ''}${Math.abs(credits).toLocaleString('en-US')} credits`;

const creditSummary = (row: CreditRow): string => {
  if (row.reason === 'refund_clawback') return `Credits clawed back for a refund: ${formatSignedCredits(row.credits)}`;
  if (row.reason === 'dispute_clawback')
    return `Credits clawed back for a dispute: ${formatSignedCredits(row.credits)}`;
  return `Plan credits granted: ${formatSignedCredits(row.credits)}`;
};

/**
 * Plan credit grants to the owner, and the refund and dispute clawbacks taken from it. The ledger does not
 * name a subscription, so an owner's grants from an earlier subscription and a credit-pack clawback show too.
 */
export const subscriptionCreditFilter = (subject: SubscriptionTimelineSubject, cursor?: AuditLogCursor) => ({
  $and: [
    // Must repeat the partial filter of credit_tx_owner_balance_events for the planner to use it.
    {
      ownerId: subject.owner.id,
      ownerType: subject.owner.kind === 'user' ? CreditHolderType.User : CreditHolderType.Organization,
      type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] },
    },
    { $or: [{ type: 'subscription' }, { reason: { $in: [...CLAWBACK_REASONS] } }] },
    ...createdAtCursorClauses(cursor),
  ],
});

const fetchCreditItems = async (subject: SubscriptionTimelineSubject, page: PageOptions): Promise<SourcePage> => {
  const rows = await CreditTransaction.find(subscriptionCreditFilter(subject, page.cursor))
    .sort({ createdAt: -1, _id: -1 })
    .limit(page.limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<CreditRow[]>();
  return {
    items: rows.slice(0, page.limit).map(row => ({
      kind: 'credit',
      id: row._id.toString(),
      occurredAt: row.createdAt,
      type: row.type,
      summary: creditSummary(row),
      credits: row.credits,
      ...(row.reason && { reason: row.reason }),
      ...(row.description && { description: row.description }),
    })),
    hasMore: rows.length > page.limit,
  };
};

const SOURCES: Readonly<
  Record<SubscriptionTimelineKind, (subject: SubscriptionTimelineSubject, page: PageOptions) => Promise<SourcePage>>
> = {
  billing: fetchBillingItems,
  admin: fetchAdminItems,
  credit: fetchCreditItems,
};

export const compareNewestFirst = (a: SubscriptionTimelineItem, b: SubscriptionTimelineItem): number => {
  const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
};

/**
 * Merges source pages into one. Each source returned its newest rows after the same (occurredAt, id) cursor,
 * so the first `limit` merged rows are globally correct and the last of them is the next cursor.
 */
export const mergeSubscriptionTimelinePages = (
  pages: SourcePage[],
  limit: number
): { items: SubscriptionTimelineItem[]; nextCursor: AuditLogCursor | null } => {
  const merged = pages.flatMap(page => page.items).sort(compareNewestFirst);
  const items = merged.slice(0, limit);
  const hasMore = merged.length > limit || pages.some(page => page.hasMore);
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null };
};

/**
 * One page of a subscription's Timeline: one bounded indexed read per selected source, merged newest first.
 * A failing source fails the page rather than silently reading as "nothing happened".
 */
export const listSubscriptionTimeline = async (
  subject: SubscriptionTimelineSubject,
  options: { kinds: readonly SubscriptionTimelineKind[] } & PageOptions
) => {
  const { kinds, ...page } = options;
  const pages = await Promise.all(kinds.map(kind => SOURCES[kind](subject, page)));
  return mergeSubscriptionTimelinePages(pages, page.limit);
};
