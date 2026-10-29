import React from 'react';
import { Box, Button, Link, Stack, Typography } from '@mui/joy';
import {
  isCompSubscription,
  type AdminSubscriptionDetail,
  type AdminSubscriptionRow,
} from '@client/app/utils/adminSubscriptionDetail';
import { CopyValue, EmptyState, Fact, SectionCard, StatusChip } from '../../../shared';
import { formatCreditDelta, formatCredits } from '../../../Users/Profile/actions/creditAdjustment';
import { subscriptionStatusDisplay } from '../../subscriptionStatusTone';
import {
  INTERVAL_LABELS,
  formatDate,
  ownerDisplayName,
  ownerLink,
  possibleDuplicateIds,
  sourceLabel,
  type OwnerLink,
} from '../subscriptionDetailModel';

type OverviewTabProps = {
  detail: AdminSubscriptionDetail;
  onOpenOwner: (link: OwnerLink) => void;
  onOpenSubscription: (id: string) => void;
  onOpenLedger: (userId: string) => void;
};

const StatusFact: React.FC<{ row: AdminSubscriptionRow; testId?: string }> = ({ row, testId }) => {
  const status = subscriptionStatusDisplay(row);
  return <StatusChip tone={status.tone} label={status.label} dot data-testid={testId} />;
};

const PlanName: React.FC<{ row: AdminSubscriptionRow }> = ({ row }) =>
  row.plan.name ? (
    <>{row.plan.name}</>
  ) : (
    <StatusChip tone="warn" label="Unknown price" data-testid="subscription-detail-unknown-price-chip" />
  );

const PlanAndBillingCard: React.FC<{ detail: AdminSubscriptionDetail }> = ({ detail }) => {
  const { subscription } = detail;
  const start = formatDate(subscription.periodStartsAt);
  const end = formatDate(subscription.periodEndsAt);
  const stripeCustomerId = subscription.owner?.stripeCustomerId ?? null;
  const comp = isCompSubscription(subscription);
  return (
    <SectionCard title="Plan and billing" data-testid="subscription-detail-plan-card">
      <Fact label="Plan" data-testid="subscription-detail-plan">
        <PlanName row={subscription} />
      </Fact>
      <Fact label="Status">
        <StatusFact row={subscription} />
      </Fact>
      <Fact label="Source" data-testid="subscription-detail-source">
        {sourceLabel(subscription)}
      </Fact>
      <Fact label="Period" data-testid="subscription-detail-period">
        {start && end ? `${start} \u2013 ${end}` : null}
      </Fact>
      <Fact label="Interval">{subscription.plan.interval ? INTERVAL_LABELS[subscription.plan.interval] : null}</Fact>
      {/* Amounts arrive with the Stripe mirror (spec section 6.1). */}
      <Fact label="Price" />
      <Fact label="Canceled at">{formatDate(subscription.canceledAt)}</Fact>
      <Fact label="Subscription id">
        {subscription.subscriptionId ? (
          <CopyValue
            value={subscription.subscriptionId}
            label="subscription id"
            mono
            data-testid="subscription-detail-copy-subscription-id-btn"
          />
        ) : null}
      </Fact>
      <Fact label="Stripe customer">
        {stripeCustomerId ? (
          <CopyValue
            value={stripeCustomerId}
            label="Stripe customer id"
            mono
            data-testid="subscription-detail-copy-customer-id-btn"
          />
        ) : null}
      </Fact>
      <Fact label="Created">{formatDate(subscription.createdAt)}</Fact>
      {comp && <Fact label="Granted by">{detail.grantedBy}</Fact>}
      {comp && <Fact label="Grant reason">{detail.grantedReason}</Fact>}
    </SectionCard>
  );
};

const PaymentCard: React.FC = () => (
  <SectionCard title="Payment" body="custom" data-testid="subscription-detail-payment-card">
    <EmptyState
      title="Payment details are not shown yet"
      description="Card, expiry and the latest invoice arrive with the live Stripe read."
      action={null}
    />
  </SectionCard>
);

const RecentGrants: React.FC<{ detail: AdminSubscriptionDetail }> = ({ detail }) => {
  const grants = detail.credits.recentGrants;
  if (grants.length === 0) return null;
  return (
    <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }} data-testid="subscription-detail-recent-grants">
      {grants.map(grant => (
        <Stack
          key={grant.id}
          component="li"
          direction="row"
          justifyContent="space-between"
          gap={2}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          <span>{formatDate(grant.createdAt)}</span>
          <span>{formatCreditDelta(grant.credits)}</span>
        </Stack>
      ))}
    </Box>
  );
};

const CreditsCard: React.FC<{ detail: AdminSubscriptionDetail; onOpenLedger: (userId: string) => void }> = ({
  detail,
  onOpenLedger,
}) => {
  const { credits, subscription } = detail;
  const userOwner = subscription.owner?.kind === 'User' ? subscription.owner : null;
  return (
    <SectionCard
      title="Credits from this plan"
      data-testid="subscription-detail-credits-card"
      action={
        userOwner && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => onOpenLedger(userOwner.id)}
            data-testid="subscription-detail-open-ledger-btn"
          >
            Open ledger
          </Button>
        )
      }
    >
      <Fact label="Per cycle" data-testid="subscription-detail-credits-effective">
        {credits.effectivePerCycle === null ? null : formatCredits(credits.effectivePerCycle)}
      </Fact>
      <Fact label="Plan default">
        {credits.defaultPerCycle === null ? null : formatCredits(credits.defaultPerCycle)}
      </Fact>
      <Fact label="Override" data-testid="subscription-detail-credits-override">
        {credits.customPerCycle === null ? null : formatCredits(credits.customPerCycle)}
      </Fact>
      <Fact label="Owner's recent grants">{credits.recentGrants.length === 0 ? null : <RecentGrants detail={detail} />}</Fact>
    </SectionCard>
  );
};

const OtherSubscriptions: React.FC<{
  detail: AdminSubscriptionDetail;
  onOpenSubscription: (id: string) => void;
}> = ({ detail, onOpenSubscription }) => {
  const duplicates = possibleDuplicateIds(detail);
  return (
    <Stack component="ul" gap={0.75} sx={{ m: 0, p: 0, listStyle: 'none' }}>
      {detail.otherSubscriptions.map(row => (
        <Stack
          key={row.id}
          component="li"
          direction="row"
          alignItems="center"
          flexWrap="wrap"
          gap={1}
          data-testid="subscription-detail-other-subscription"
        >
          <Link
            component="button"
            type="button"
            level="body-sm"
            onClick={() => onOpenSubscription(row.id)}
            data-testid="subscription-detail-other-subscription-link"
          >
            {row.plan.name ?? 'Unknown price'}
          </Link>
          <StatusFact row={row} />
          {duplicates.has(row.id) && (
            <StatusChip tone="warn" label="Possible duplicate" data-testid="subscription-detail-duplicate-chip" />
          )}
        </Stack>
      ))}
    </Stack>
  );
};

const OwnerCard: React.FC<{
  detail: AdminSubscriptionDetail;
  onOpenOwner: (link: OwnerLink) => void;
  onOpenSubscription: (id: string) => void;
}> = ({ detail, onOpenOwner, onOpenSubscription }) => {
  const { subscription } = detail;
  const link = ownerLink(subscription);
  return (
    <SectionCard title="Owner" data-testid="subscription-detail-owner-card">
      <Fact label="Profile">
        {link ? (
          <Link
            component="button"
            type="button"
            level="body-sm"
            onClick={() => onOpenOwner(link)}
            data-testid="subscription-detail-owner-card-link"
          >
            {ownerDisplayName(subscription)}
          </Link>
        ) : (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            {ownerDisplayName(subscription)}
          </Typography>
        )}
      </Fact>
      <Fact label="Kind">{subscription.ownerType === 'Organization' ? 'Organization' : 'User'}</Fact>
      <Fact label="Credit balance" data-testid="subscription-detail-owner-credits">
        {detail.ownerCredits === null ? null : `${formatCredits(detail.ownerCredits)} credits`}
      </Fact>
      <Fact label="Other subscriptions">
        {detail.otherSubscriptions.length === 0 ? null : (
          <OtherSubscriptions detail={detail} onOpenSubscription={onOpenSubscription} />
        )}
      </Fact>
    </SectionCard>
  );
};

const SeatsCard: React.FC<{ detail: AdminSubscriptionDetail }> = ({ detail }) => {
  const { seats } = detail;
  if (!seats) return null;
  // A disagreement is a reconciliation finding, not something to fix from here.
  const mismatch = seats.organizationSeats !== null && seats.organizationSeats !== seats.paid;
  return (
    <SectionCard title="Seats" data-testid="subscription-detail-seats-card">
      <Fact label="Members">{seats.members.toLocaleString('en-US')}</Fact>
      <Fact label="Paid quantity">{seats.paid.toLocaleString('en-US')}</Fact>
      <Fact label="Organization seats">
        {seats.organizationSeats === null ? null : (
          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
            {seats.organizationSeats.toLocaleString('en-US')}
            {mismatch && (
              <StatusChip tone="warn" label="Differs from paid" data-testid="subscription-detail-seat-mismatch-chip" />
            )}
          </Stack>
        )}
      </Fact>
      <Fact label="Platform min / max">{`${seats.min.toLocaleString('en-US')} \u2013 ${seats.max.toLocaleString('en-US')}`}</Fact>
    </SectionCard>
  );
};

/** Our records for this subscription, in two columns; Stripe-live data arrives in later work. */
export const OverviewTab: React.FC<OverviewTabProps> = ({ detail, onOpenOwner, onOpenSubscription, onOpenLedger }) => (
  <Box
    sx={{
      display: 'grid',
      gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
      gap: 2,
      alignItems: 'start',
    }}
    data-testid="subscription-detail-overview"
  >
    <PlanAndBillingCard detail={detail} />
    {!isCompSubscription(detail.subscription) && <PaymentCard />}
    <CreditsCard detail={detail} onOpenLedger={onOpenLedger} />
    <OwnerCard detail={detail} onOpenOwner={onOpenOwner} onOpenSubscription={onOpenSubscription} />
    <SeatsCard detail={detail} />
  </Box>
);
