import { z } from 'zod';
import type { AuditEntry } from './AdminAuditLogTypes';

/**
 * The small projection of a Stripe event that a BillingEvent row keeps (docs/admin-subscriptions-spec.md 6.2).
 * Ids, statuses and amounts only: never card details or the raw payload.
 */
export type BillingEventData = {
  /** Id of the event's own Stripe object (`in_...`, `sub_...`, `ch_...`, `dp_...`). */
  objectId?: string;
  invoiceId?: string;
  paymentIntentId?: string;
  chargeId?: string;
  status?: string;
  previousStatus?: string;
  billingReason?: string;
  attemptCount?: number;
  priceId?: string;
  previousPriceId?: string;
  quantity?: number;
  previousQuantity?: number;
  cancelAtPeriodEnd?: boolean;
  previousCancelAtPeriodEnd?: boolean;
  refundIds?: string[];
  disputeId?: string;
  /** Cancellation, dispute or refund reason as Stripe states it. */
  reason?: string;
  /** Set when this delivery sent the owner a payment-failed email. */
  dunningNoticeSent?: boolean;
};

export type BillingEventOwnerType = 'user' | 'organization';

/** The sources merged into a subscription's Timeline tab; see apps/client/server/utils/subscriptionTimeline.ts. */
export const SUBSCRIPTION_TIMELINE_KINDS = ['billing', 'admin', 'credit'] as const;
export const SubscriptionTimelineKindSchema = z.enum(SUBSCRIPTION_TIMELINE_KINDS);
export type SubscriptionTimelineKind = z.infer<typeof SubscriptionTimelineKindSchema>;

type SubscriptionTimelineItemBase = {
  id: string;
  occurredAt: Date;
  /** One plain-language line, e.g. "Payment failed". */
  summary: string;
};

export type SubscriptionTimelineBillingItem = SubscriptionTimelineItemBase & {
  kind: 'billing';
  /** The Stripe event type, e.g. `invoice.payment_failed`. */
  type: string;
  stripeEventId: string;
  /** Minor units. */
  amount: number | null;
  currency: string | null;
  data: BillingEventData;
};

/** Carries the full audit row so the UI can open it in the audit drawer. */
export type SubscriptionTimelineAdminItem = SubscriptionTimelineItemBase & {
  kind: 'admin';
  type: string;
  audit: AuditEntry;
};

export type SubscriptionTimelineCreditItem = SubscriptionTimelineItemBase & {
  kind: 'credit';
  /** The ledger transaction type, e.g. `subscription` or `generic_deduct`. */
  type: string;
  /** Signed delta. */
  credits: number;
  reason?: string;
  description?: string;
};

export type SubscriptionTimelineItem =
  SubscriptionTimelineBillingItem | SubscriptionTimelineAdminItem | SubscriptionTimelineCreditItem;

export type SubscriptionTimelinePage = { items: SubscriptionTimelineItem[]; nextCursor: string | null };

const BILLING_EVENT_TITLES: Readonly<Record<string, string>> = {
  'customer.subscription.created': 'Subscription created',
  'customer.subscription.deleted': 'Subscription canceled',
  'customer.subscription.trial_will_end': 'Trial ending soon',
  'invoice.paid': 'Invoice paid',
  'invoice.finalized': 'Invoice finalized',
  'invoice.payment_failed': 'Payment failed',
  'charge.refunded': 'Refunded',
  'charge.dispute.created': 'Disputed',
  'checkout.session.completed': 'Checkout completed',
  'checkout.session.expired': 'Checkout expired',
  'payment_intent.succeeded': 'Payment succeeded',
  'payment_intent.payment_failed': 'Payment attempt failed',
  'customer.deleted': 'Stripe customer deleted',
  'radar.early_fraud_warning.created': 'Early fraud warning',
  'review.opened': 'Payment review opened',
};

const INVOICE_PAID_TITLES: Readonly<Record<string, string>> = {
  subscription_create: 'First payment',
  subscription_cycle: 'Renewed',
  subscription_update: 'Plan change invoiced',
};

const subscriptionUpdateTitle = (data: BillingEventData): string => {
  const changes: string[] = [];
  if (data.previousPriceId !== undefined && data.previousPriceId !== data.priceId) changes.push('Plan changed');
  if (data.previousQuantity !== undefined && data.previousQuantity !== data.quantity) {
    changes.push(`Seats changed from ${data.previousQuantity} to ${data.quantity ?? '?'}`);
  }
  if (data.previousCancelAtPeriodEnd !== undefined && data.previousCancelAtPeriodEnd !== data.cancelAtPeriodEnd) {
    changes.push(data.cancelAtPeriodEnd ? 'Cancellation scheduled' : 'Cancellation withdrawn');
  }
  if (data.previousStatus !== undefined && data.previousStatus !== data.status && data.status) {
    changes.push(`Status changed to ${data.status.replace(/_/g, ' ')}`);
  }
  return changes.length > 0 ? changes.join(', ') : 'Subscription updated';
};

/** The plain-language line for a stored Stripe event; an unknown type reads as the raw type. */
export const billingEventSummary = (type: string, data: BillingEventData): string => {
  switch (type) {
    case 'customer.subscription.updated':
      return subscriptionUpdateTitle(data);
    case 'invoice.payment_succeeded':
      return (data.billingReason && INVOICE_PAID_TITLES[data.billingReason]) || 'Payment succeeded';
    case 'invoice.payment_failed': {
      const attempt = data.attemptCount ? ` (attempt ${data.attemptCount})` : '';
      return `Payment failed${attempt}${data.dunningNoticeSent ? ', dunning email sent' : ''}`;
    }
    case 'charge.dispute.closed':
      return data.status === 'won' ? 'Dispute won' : `Dispute closed${data.status ? ` (${data.status})` : ''}`;
    default:
      return BILLING_EVENT_TITLES[type] ?? type;
  }
};
