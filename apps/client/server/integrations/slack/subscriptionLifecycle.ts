import type Stripe from 'stripe';
import { Logger } from '@bike4mind/observability';
import { ADMIN_TAB_PARAM, classifyStage, toAbsoluteUrl } from '@bike4mind/common';
import { Config } from '@bike4mind/server-utils/utils/config';
import { SubscriptionOwnerType, type ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import { detectSubscriptionChanges } from '@bike4mind/server-utils/lib/subscriptions/subscriptionChanges';
import { planChangeDirection, planDetails, type PlanChangeDirection } from '@server/analytics/billingEventDetails';
import { minorUnitsPerMajor } from '@server/integrations/stripe/currency';
import { subscriptionRepository } from '@server/models/Subscription';
import { postMessageToSlack } from './slack';

// Subscription lifecycle posts to the SlackSubscriptionsWebhookUrl channel. The event types carry
// internal IDs, plan names and amounts only: there is no field a customer name or email could ride in.

export interface LifecycleOwner {
  ownerType: SubscriptionOwnerType;
  ownerId: string;
}

/** A plan as planDetails() names it. */
export interface LifecyclePlan {
  plan: string;
  interval?: string;
}

export interface LifecycleMoney {
  amountMinor: number;
  currency: string;
}

export type BillingInterval = 'day' | 'week' | 'month' | 'year';

export interface LifecycleRecurringPrice extends LifecycleMoney {
  interval?: BillingInterval;
}

const END_REASON_LABELS = {
  cancellation_requested: 'cancellation requested',
  canceled_by_retention_policy: 'canceled by retention policy',
  payment_failed: 'payment failed',
  payment_disputed: 'payment disputed',
  unknown: 'unknown',
} as const;

export type SubscriptionEndReason = keyof typeof END_REASON_LABELS;

export type SubscriptionLifecycleEvent =
  | {
      kind: 'new_paid';
      owner: LifecycleOwner;
      plan: LifecyclePlan;
      price: LifecycleRecurringPrice;
      /** What the opening invoice charged, when a coupon, proration or tax made it differ from the price. */
      firstCharge: LifecycleMoney | null;
      quantity: number;
    }
  | {
      kind: 'plan_changed';
      owner: LifecycleOwner;
      direction: PlanChangeDirection;
      from: LifecyclePlan;
      to: LifecyclePlan;
      price: LifecycleRecurringPrice | null;
      quantity: number;
    }
  | { kind: 'cancel_scheduled'; owner: LifecycleOwner; plan: LifecyclePlan; endsAt: Date | null }
  | { kind: 'cancel_reverted'; owner: LifecycleOwner; plan: LifecyclePlan }
  | { kind: 'ended'; owner: LifecycleOwner; plan: LifecyclePlan; reason: SubscriptionEndReason }
  | { kind: 'payment_failed'; owner: LifecycleOwner; plan: LifecyclePlan; amountDue: LifecycleMoney };

const INTERVAL_SUFFIXES: Record<BillingInterval, string> = { day: '/day', week: '/wk', month: '/mo', year: '/yr' };

const PLAN_CHANGE_TITLES: Record<PlanChangeDirection, string> = {
  upgrade: ':arrow_up: *Plan upgraded*',
  downgrade: ':arrow_down: *Plan downgraded*',
  same_tier: ':left_right_arrow: *Plan changed (same tier)*',
  unknown: ':left_right_arrow: *Plan changed*',
};

function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMoney({ amountMinor, currency }: LifecycleMoney): string {
  if (!Number.isFinite(amountMinor) || !currency) return 'unknown';
  const major = amountMinor / minorUnitsPerMajor(currency);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(major);
  } catch {
    return `${major} ${escapeSlackText(currency.toUpperCase())}`;
  }
}

function formatRecurring(price: LifecycleRecurringPrice): string {
  return `${formatMoney(price)}${price.interval ? INTERVAL_SUFFIXES[price.interval] : ''}`;
}

function planLabel({ plan, interval }: LifecyclePlan): string {
  return escapeSlackText(interval ? `${plan} (${interval})` : plan);
}

function adminOwnerPath({ ownerType, ownerId }: LifecycleOwner): string {
  if (ownerType === SubscriptionOwnerType.Organization) {
    // The admin console opens an organization's profile from these params (see
    // apps/client/app/components/admin/organizationsTabSearch.ts).
    return `/admin?${new URLSearchParams({ [ADMIN_TAB_PARAM]: 'organizations', orgId: ownerId })}`;
  }
  return `/admin/users/${encodeURIComponent(ownerId)}`;
}

function appUrlFromEnv(): string | null {
  return process.env.APP_URL?.trim() || null;
}

/** An owner's internal ID plus a link to it in the admin console; the bare ID when APP_URL is unset. */
export function adminOwnerSlackRef(owner: LifecycleOwner, appUrl: string | null = appUrlFromEnv()): string {
  const id = `\`${escapeSlackText(owner.ownerId)}\``;
  if (!appUrl) return id;
  return `${id} - <${escapeSlackText(toAbsoluteUrl(appUrl, adminOwnerPath(owner)))}|Open in admin>`;
}

export function buildSubscriptionLifecycleMessage(event: SubscriptionLifecycleEvent, appUrl: string | null): string {
  const lines: string[] = [];
  const seatsLine = (quantity: number) =>
    event.owner.ownerType === SubscriptionOwnerType.Organization ? [`*Seats:* ${quantity}`] : [];

  switch (event.kind) {
    case 'new_paid':
      lines.push(
        ':tada: *New paid subscription*',
        `*Plan:* ${planLabel(event.plan)}`,
        `*Amount:* ${formatRecurring(event.price)}`,
        ...(event.firstCharge ? [`*First charge:* ${formatMoney(event.firstCharge)}`] : []),
        ...seatsLine(event.quantity)
      );
      break;
    case 'plan_changed':
      lines.push(PLAN_CHANGE_TITLES[event.direction], `*Plan:* ${planLabel(event.from)} -> ${planLabel(event.to)}`);
      if (event.price) lines.push(`*Amount:* ${formatRecurring(event.price)}`);
      lines.push(...seatsLine(event.quantity));
      break;
    case 'cancel_scheduled':
      lines.push(':hourglass_flowing_sand: *Cancellation scheduled*', `*Plan:* ${planLabel(event.plan)}`);
      if (event.endsAt && !Number.isNaN(event.endsAt.getTime())) {
        lines.push(`*Ends:* ${event.endsAt.toISOString().slice(0, 10)}`);
      }
      break;
    case 'cancel_reverted':
      lines.push(':recycle: *Cancellation reverted*', `*Plan:* ${planLabel(event.plan)}`);
      break;
    case 'ended':
      lines.push(
        ':wave: *Subscription ended*',
        `*Plan:* ${planLabel(event.plan)}`,
        `*Reason:* ${END_REASON_LABELS[event.reason]}`
      );
      break;
    case 'payment_failed':
      lines.push(
        ':warning: *Subscription payment failed*',
        `*Plan:* ${planLabel(event.plan)}`,
        `*Amount due:* ${formatMoney(event.amountDue)}`
      );
      break;
  }

  const ownerLabel = event.owner.ownerType === SubscriptionOwnerType.Organization ? 'Organization' : 'User';
  lines.push(`*${ownerLabel}:* ${adminOwnerSlackRef(event.owner, appUrl)}`);
  return lines.join('\n');
}

// Every other stage resolves the same fallback webhooks, so its test traffic would land in the real channel.
function postsFromThisStage(): boolean {
  return classifyStage(Config.STAGE) === 'production';
}

/** Never throws: callers are webhook and event handlers whose retry would repeat their writes. */
export async function postSubscriptionLifecycleToSlack(event: SubscriptionLifecycleEvent): Promise<void> {
  if (!postsFromThisStage()) return;
  try {
    await postMessageToSlack(buildSubscriptionLifecycleMessage(event, appUrlFromEnv()), 'SlackSubscriptionsWebhookUrl');
  } catch (error) {
    Logger.error('Error posting subscription lifecycle event to Slack:', error);
  }
}

function lifecycleOwner(row: Pick<ISubscription, 'ownerType' | 'ownerId'>): LifecycleOwner {
  return { ownerType: row.ownerType, ownerId: row.ownerId };
}

function billingInterval(interval: string | undefined): BillingInterval | undefined {
  return interval && Object.hasOwn(INTERVAL_SUFFIXES, interval) ? (interval as BillingInterval) : undefined;
}

function recurringPrice(price: Stripe.Price | undefined, quantity: number): LifecycleRecurringPrice | null {
  if (!price || price.unit_amount == null) return null;
  return {
    amountMinor: price.unit_amount * quantity,
    currency: price.currency,
    interval: billingInterval(price.recurring?.interval),
  };
}

export function subscriptionEndReason(reason: string | null | undefined): SubscriptionEndReason {
  return reason && Object.hasOwn(END_REASON_LABELS, reason) ? (reason as SubscriptionEndReason) : 'unknown';
}

export function endedLifecycleEvent(row: ISubscription, reason: string | null | undefined): SubscriptionLifecycleEvent {
  return {
    kind: 'ended',
    owner: lifecycleOwner(row),
    plan: planDetails(row.priceId),
    reason: subscriptionEndReason(reason),
  };
}

export function paymentFailedLifecycleEvent(
  row: ISubscription,
  invoice: Pick<Stripe.Invoice, 'amount_due' | 'currency'>
): SubscriptionLifecycleEvent {
  return {
    kind: 'payment_failed',
    owner: lifecycleOwner(row),
    plan: planDetails(row.priceId),
    amountDue: { amountMinor: invoice.amount_due, currency: invoice.currency },
  };
}

/**
 * new_paid for the invoice that opened a subscription, once the invoice handler has recorded it.
 * The row is the evidence: the handler returns without writing for a customer with no user or an
 * unknown price.
 */
export async function postNewPaidSubscriptionToSlack(
  invoice: Pick<Stripe.Invoice, 'amount_paid' | 'currency'>,
  subscription: Pick<Stripe.Subscription, 'id' | 'items'>
): Promise<void> {
  if (!postsFromThisStage()) return;
  try {
    const row = await subscriptionRepository.findByStripeSubscriptionId(subscription.id);
    if (!row) return;
    const item = subscription.items.data[0];
    const quantity = item?.quantity ?? 1;
    const paid: LifecycleMoney = { amountMinor: invoice.amount_paid, currency: invoice.currency };
    const price = recurringPrice(item?.price, quantity);
    const differs =
      price !== null &&
      (price.amountMinor !== paid.amountMinor || price.currency.toLowerCase() !== paid.currency.toLowerCase());
    await postSubscriptionLifecycleToSlack({
      kind: 'new_paid',
      owner: lifecycleOwner(row),
      plan: planDetails(row.priceId),
      price: price ?? { ...paid, interval: billingInterval(item?.price.recurring?.interval) },
      firstCharge: differs ? paid : null,
      quantity,
    });
  } catch (error) {
    Logger.error('Error posting new paid subscription to Slack:', error);
  }
}

/**
 * plan_changed, cancel_scheduled, cancel_reverted and ended for one customer.subscription.updated.
 * Its sync can reach canceled before customer.subscription.deleted does, and whichever write moves
 * the row into canceled posts the end (the deleted branch of apps/client/pages/api/stripe/webhook.ts).
 */
export function subscriptionChangeLifecycleEvents(
  before: ISubscription,
  subscription: Pick<
    Stripe.Subscription,
    'items' | 'status' | 'canceled_at' | 'cancel_at' | 'cancel_at_period_end' | 'cancellation_details'
  >
): SubscriptionLifecycleEvent[] {
  const { plan, cancel, ended } = detectSubscriptionChanges(before, subscription);
  const owner = lifecycleOwner(before);
  const item = subscription.items.data[0];
  const events: SubscriptionLifecycleEvent[] = [];

  if (plan) {
    const quantity = item?.quantity ?? 1;
    events.push({
      kind: 'plan_changed',
      owner,
      direction: planChangeDirection(plan.fromPriceId, plan.toPriceId),
      from: planDetails(plan.fromPriceId),
      to: planDetails(plan.toPriceId),
      price: recurringPrice(item?.price, quantity),
      quantity,
    });
  }

  if (cancel === 'scheduled') {
    const endsAt = subscription.cancel_at ?? (subscription.cancel_at_period_end ? item?.current_period_end : null);
    events.push({
      kind: 'cancel_scheduled',
      owner,
      plan: planDetails(item?.price.id ?? before.priceId),
      endsAt: endsAt ? new Date(endsAt * 1000) : null,
    });
  } else if (cancel === 'reverted') {
    events.push({ kind: 'cancel_reverted', owner, plan: planDetails(item?.price.id ?? before.priceId) });
  }

  if (ended) events.push(endedLifecycleEvent(before, subscription.cancellation_details?.reason));

  return events;
}

/** Posts what subscriptionChangeLifecycleEvents finds. Never throws. */
export async function postSubscriptionChangesToSlack(
  before: ISubscription,
  subscription: Parameters<typeof subscriptionChangeLifecycleEvents>[1]
): Promise<void> {
  if (!postsFromThisStage()) return;
  try {
    for (const event of subscriptionChangeLifecycleEvents(before, subscription)) {
      await postSubscriptionLifecycleToSlack(event);
    }
  } catch (error) {
    Logger.error('Error posting subscription changes to Slack:', error);
  }
}
