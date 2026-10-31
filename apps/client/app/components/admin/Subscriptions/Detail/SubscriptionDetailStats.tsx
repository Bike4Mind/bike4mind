import React, { useState } from 'react';
import {
  isCompSubscription,
  isTerminalSubscriptionStatus,
  type AdminSubscriptionDetail,
} from '@client/app/utils/adminSubscriptionDetail';
import { StatStrip, StatTile } from '../../shared';
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

/** The numbers that answer "is this normal?". Money tiles stay dashes until the Stripe mirror lands. */
export const SubscriptionDetailStats: React.FC<{ detail: AdminSubscriptionDetail }> = ({ detail }) => {
  const [now] = useState(Date.now);
  const renewal = renewalTile(detail, now);
  const { effectivePerCycle } = detail.credits;
  return (
    <StatStrip aria-label="Subscription numbers">
      <StatTile label="MRR" value="-" comparison="Arrives with the Stripe mirror" />
      <StatTile label="Lifetime paid" value="-" comparison="Read from Stripe in a later release" />
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
