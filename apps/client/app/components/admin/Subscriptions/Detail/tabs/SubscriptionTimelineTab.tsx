import React, { useMemo, useState } from 'react';
import { Box, Button } from '@mui/joy';
import type { AuditEntry, SubscriptionTimelineItem, SubscriptionTimelineKind } from '@bike4mind/common';
import { useAdminSubscriptionTimeline } from '@client/app/hooks/data/adminSubscriptionDetail';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import { EmptyState, ErrorState, formatMoney, RelativeTime, SectionCard, SegmentedControl } from '../../../shared';
import { describeAuditEntry } from '../../../Users/Profile/tabs/auditSentence';
import { adminMeta } from '../../../Users/Profile/tabs/timelineItems';
import {
  TimelineList,
  TimelineSkeleton,
  type TimelineItem,
  type TimelineTile,
} from '../../../Users/Profile/tabs/TimelineList';

type KindFilter = 'all' | SubscriptionTimelineKind;

const FILTER_OPTIONS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'billing', label: 'Billing' },
  { value: 'admin', label: 'Admin' },
  { value: 'credit', label: 'Credits' },
];

const BAD_BILLING_TYPES = new Set([
  'invoice.payment_failed',
  'payment_intent.payment_failed',
  'charge.dispute.created',
  'radar.early_fraud_warning.created',
]);
const WARN_BILLING_TYPES = new Set(['charge.refunded', 'customer.subscription.deleted', 'review.opened']);
const GOOD_BILLING_TYPES = new Set(['invoice.payment_succeeded', 'invoice.paid', 'customer.subscription.created']);

const billingTile = (type: string): TimelineTile => {
  if (BAD_BILLING_TYPES.has(type)) return { text: 'ST', tone: 'bad' };
  if (WARN_BILLING_TYPES.has(type)) return { text: 'ST', tone: 'warn' };
  if (GOOD_BILLING_TYPES.has(type)) return { text: 'ST', tone: 'good' };
  return { text: 'ST', tone: 'info' };
};

/** Muted line under a Stripe event: its amount, then the Stripe ids an admin searches the Dashboard by. */
const billingMeta = (item: Extract<SubscriptionTimelineItem, { kind: 'billing' }>): string =>
  [
    item.amount !== null && item.currency ? formatMoney(item.amount, item.currency) : undefined,
    item.data.invoiceId,
    item.data.disputeId,
    item.data.refundIds?.join(', '),
    item.data.reason && `Reason: ${item.data.reason.replace(/_/g, ' ')}`,
    item.stripeEventId,
  ]
    .filter(Boolean)
    .join(' \u00b7 ');

const toListItem = (item: SubscriptionTimelineItem, onOpenAudit: (entry: AuditEntry) => void): TimelineItem => {
  const base = { id: `${item.kind}-${item.id}`, aside: <RelativeTime at={item.occurredAt} /> };
  switch (item.kind) {
    case 'billing':
      return { ...base, tile: billingTile(item.type), summary: item.summary, meta: billingMeta(item) };
    case 'admin':
      return {
        ...base,
        tile: { text: 'AD', tone: 'neutral' },
        summary: describeAuditEntry(item.audit),
        meta: adminMeta(item.audit),
        onOpen: () => onOpenAudit(item.audit),
      };
    case 'credit':
      return {
        ...base,
        tile: { text: 'CR', tone: item.credits < 0 ? 'bad' : 'good' },
        summary: item.summary,
        meta: item.description,
      };
  }
};

/** Stripe billing events, admin actions and plan credit moves for one subscription, newest first. */
export const SubscriptionTimelineTab: React.FC<{ subscriptionId: string }> = ({ subscriptionId }) => {
  const [filter, setFilter] = useState<KindFilter>('all');
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const timeline = useAdminSubscriptionTimeline(subscriptionId, filter === 'all' ? undefined : filter);
  const items = useMemo(
    () => (timeline.data?.pages.flatMap(page => page.items) ?? []).map(item => toListItem(item, setSelected)),
    [timeline.data]
  );

  const body = () => {
    if (timeline.isLoading) return <TimelineSkeleton />;
    if (timeline.isError) {
      return <ErrorState message="The timeline could not be loaded." onRetry={() => void timeline.refetch()} />;
    }
    if (items.length === 0) {
      return filter === 'all' ? (
        <EmptyState
          title="Nothing on the timeline yet"
          description="Stripe billing events, admin changes and plan credits for this subscription appear here."
          action={null}
        />
      ) : (
        <EmptyState
          title="Nothing of this type yet"
          description="Show every type to see the rest of the timeline."
          action={
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => setFilter('all')}
              data-testid="subscription-timeline-show-all-btn"
            >
              Show all
            </Button>
          }
        />
      );
    }
    return (
      <TimelineList items={items} rowTestId="subscription-timeline-row" data-testid="subscription-timeline-list" />
    );
  };

  return (
    <>
      <SectionCard
        title="Timeline"
        body="custom"
        action={
          <SegmentedControl
            options={FILTER_OPTIONS}
            value={filter}
            onChange={setFilter}
            aria-label="Show events of type"
            data-testid="subscription-timeline-filter"
          />
        }
        data-testid="subscription-timeline"
      >
        {body()}
        {timeline.hasNextPage && (
          <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'admin.border' }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={timeline.isFetchingNextPage}
              onClick={() => void timeline.fetchNextPage()}
              data-testid="subscription-timeline-more-btn"
            >
              Load more
            </Button>
          </Box>
        )}
      </SectionCard>
      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </>
  );
};
