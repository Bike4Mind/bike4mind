import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import type {
  BillingActivityKind,
  BillingFundingCredits,
  BillingLink,
  BillingOverview,
  BillingPaymentKind,
  SubscriptionStanding,
} from '@client/app/utils/adminBillingOverview';
import { adminOrganizationHref } from '../organizationsTabSearch';
import { ADMIN_STRIPE_DISPUTES_TAB_SLUG } from '../adminTabParams';

/** Display rules for the Billing overview. Pure, so links and labels are unit-tested without rendering. */

export const billingLinkHref = (link: BillingLink): string => {
  switch (link.kind) {
    case 'subscription': {
      const path = `/admin/subscriptions/${encodeURIComponent(link.subscriptionId)}`;
      return link.tab === 'overview' ? path : `${path}?tab=${link.tab}`;
    }
    case 'userCredits':
      return `/admin/users/${encodeURIComponent(link.userId)}?tab=credits`;
    case 'userActivity':
      return `/admin/users/${encodeURIComponent(link.userId)}?${new URLSearchParams({
        tab: 'activity',
        types: 'usage,spend',
        from: link.from,
        to: link.to,
      })}`;
    case 'organization':
      return adminOrganizationHref(link.organizationId);
    case 'disputes':
      return `/admin?tab=${ADMIN_STRIPE_DISPUTES_TAB_SLUG}`;
  }
};

export const STANDING_CHIPS: Readonly<Record<SubscriptionStanding, { tone: AdminStatusTone; label: string }>> = {
  paid: { tone: 'good', label: 'Paid' },
  past_due: { tone: 'warn', label: 'Payment due' },
  trial: { tone: 'info', label: 'Trial' },
  comped: { tone: 'neutral', label: 'Comped' },
  ended: { tone: 'neutral', label: 'Ended' },
  none: { tone: 'neutral', label: 'No subscription' },
};

export const PAYMENT_KIND_LABELS: Readonly<Record<BillingPaymentKind, string>> = {
  credit_purchase: 'Credit purchase',
  subscription_payment: 'Subscription',
  refund: 'Refund',
  dispute: 'Dispute',
};

export const ACTIVITY_KIND_LABELS: Readonly<Record<BillingActivityKind, string>> = {
  payment: 'Payment',
  refund: 'Refund',
  dispute: 'Dispute',
  credit_issued: 'Credits added',
  consumption: 'Usage',
};

export const FUNDING_LABELS: Readonly<Record<keyof BillingFundingCredits, string>> = {
  purchased: 'Purchased',
  subscription: 'Subscription',
  granted: 'Granted',
  unknown: 'Unknown origin',
};

type Subscription = Extract<BillingOverview['subscription'], { status: 'ok' }>['current'];

/** "Renews", "Ends" or "Comp ends", with the date it applies to; null when neither is known. */
export const subscriptionNextDate = (subscription: NonNullable<Subscription>): { label: string; at: string } | null => {
  if (subscription.cancelAt) return { label: 'Ends', at: subscription.cancelAt };
  if (!subscription.periodEndsAt) return null;
  return { label: subscription.comped ? 'Comp ends' : 'Renews', at: subscription.periodEndsAt };
};

/** True when the window starts before a store began recording, so part of it is not covered. */
export const windowStartsBefore = (windowFrom: string, recordedSince: string | null): boolean =>
  recordedSince !== null && new Date(windowFrom).getTime() < new Date(recordedSince).getTime();

/** "12 Mar 2026", in UTC, so every admin reads the same day. */
export const formatDay = (value: string): string =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
