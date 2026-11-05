import React, { useState } from 'react';
import type { AdminSubscriptionStripeState } from '@client/app/hooks/data/adminSubscriptionDetail';
import { MAX_INVOICES } from '@client/app/utils/adminSubscriptionStripe';
import {
  isCompSubscription,
  isTerminalSubscriptionStatus,
  type AdminSubscriptionDetail,
} from '@client/app/utils/adminSubscriptionDetail';
import { StatStrip, StatTile, formatMoney } from '../../shared';
import { formatCredits } from '../../Users/Profile/actions/creditAdjustment';
import { formatDate, relativeFromNow } from './subscriptionDetailModel';

const renewalTile = (detail: AdminSubscriptionDetail, now: number) => {
  const { subscription } = detail;
  if (isTerminalSubscriptionStatus(subscription.status)) {
    const endedAt = subscription.canceledAt ?? subscription.periodEndsAt;
    return { label: 'Ended', at: endedAt };
  }
  return { label: isCompSubscription(subscription) ? 'Comp ends' : 'Next renewal', at: subscription.periodEndsAt };
};

const creditsComparison = ({ credits }: AdminSubscriptionDetail): string => {
  if (credits.customPerCycle === null) return 'Plan default';
  return credits.defaultPerCycle === null
    ? 'Override, plan default unknown'
    : `Override, plan default ${formatCredits(credits.defaultPerCycle)}`;
};

const lifetimePaidTile = (detail: AdminSubscriptionDetail, stripe: AdminSubscriptionStripeState) => {
  if (isCompSubscription(detail.subscription)) return { value: '-', comparison: 'Comped plan' };
  const data = stripe.data;
  // Loading, Stripe down or unconfigured: a dash, never a zero that reads as "never paid".
  if (!data?.stripeConfigured || data.kind !== 'stripe') return { value: '-', comparison: undefined };
  const [first, ...others] = data.lifetimePaid;
  const note = [
    others.length > 0 ? `+${others.length} other ${others.length === 1 ? 'currency' : 'currencies'}` : null,
    data.invoicesTruncated ? `Latest ${MAX_INVOICES} invoices` : null,
    !first ? 'No paid invoices' : null,
  ].filter(Boolean);
  return {
    value: first ? formatMoney(first.amount, first.currency, { compact: true }) : '-',
    comparison: note.length > 0 ? note.join(', ') : undefined,
  };
};

/** The numbers that answer "is this normal?". MRR stays a dash until the Stripe mirror lands. */
export const SubscriptionDetailStats: React.FC<{
  detail: AdminSubscriptionDetail;
  stripe: AdminSubscriptionStripeState;
}> = ({ detail, stripe }) => {
  const [now] = useState(Date.now);
  const renewal = renewalTile(detail, now);
  const { effectivePerCycle } = detail.credits;
  const lifetime = lifetimePaidTile(detail, stripe);
  return (
    <StatStrip aria-label="Subscription numbers">
      <StatTile label="MRR" value="-" comparison="Arrives with the Stripe mirror" />
      <StatTile
        label="Lifetime paid"
        value={<span data-testid="subscription-detail-lifetime-paid">{lifetime.value}</span>}
        comparison={lifetime.comparison}
      />
      <StatTile
        label={renewal.label}
        value={<span data-testid="subscription-detail-renewal-date">{formatDate(renewal.at) ?? '-'}</span>}
        comparison={renewal.at ? relativeFromNow(renewal.at, now) : undefined}
      />
      <StatTile
        label="Credits per cycle"
        value={
          <span data-testid="subscription-detail-credits-per-cycle">
            {effectivePerCycle === null ? '-' : formatCredits(effectivePerCycle)}
          </span>
        }
        comparison={creditsComparison(detail)}
      />
      {detail.seats && (
        <StatTile
          label="Seats used / paid"
          value={
            <span data-testid="subscription-detail-seats">
              {detail.seats.members.toLocaleString('en-US')} / {detail.seats.paid.toLocaleString('en-US')}
            </span>
          }
        />
      )}
    </StatStrip>
  );
};
