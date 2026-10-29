import React from 'react';
import { Link } from '@tanstack/react-router';
import { Box, Skeleton, Stack, Typography } from '@mui/joy';
import dayjs from 'dayjs';
import { useGetUserSubscriptions } from '@client/app/hooks/data/subscriptions';
import { isTerminalSubscriptionStatus } from '@client/app/utils/adminSubscriptionDetail';
import { ErrorState } from '../shared/ErrorState';
import { StatusChip } from '../shared/StatusChip';
import {
  isCancelScheduled,
  showsCompedChip,
  subscriptionStatusDisplay,
  type SubscriptionStatusDisplay,
  type SubscriptionStatusFields,
} from './Detail/subscriptionStatus';

type SummaryRow = {
  id: string;
  planName: string;
  organizationName: string | null;
  statusDisplay: SubscriptionStatusDisplay;
  isComped: boolean;
  dateLabel: string;
  creditsPerCycle: number | null;
};

type DateFields = SubscriptionStatusFields & {
  periodEndsAt: Date | string;
  canceledAt: Date | string | null;
};

const formatDate = (date: Date | string): string => dayjs(date).format('MMM D, YYYY');

// canceledAt is when the cancel was requested, so it is the end date only for a row cut short before its period end.
const endedAt = (row: DateFields): Date | string => {
  if (row.cancelAt) return row.cancelAt;
  if (row.canceledAt && dayjs(row.canceledAt).isBefore(row.periodEndsAt)) return row.canceledAt;
  return row.periodEndsAt;
};

const dateLabel = (row: DateFields): string => {
  if (isTerminalSubscriptionStatus(row.status)) return `Ended ${formatDate(endedAt(row))}`;
  if (isCancelScheduled(row)) return `Ends ${formatDate(row.cancelAt ?? row.periodEndsAt)}`;
  return `Renews ${formatDate(row.periodEndsAt)}`;
};

const isComped = (row: { source?: string; subscriptionId?: string; status: string }): boolean =>
  showsCompedChip({
    source: row.source === 'admin_grant' ? 'admin_grant' : 'stripe',
    subscriptionId: row.subscriptionId ?? '',
    status: row.status,
  });

const SummaryRowLink: React.FC<{ row: SummaryRow }> = ({ row }) => {
  const { statusDisplay } = row;
  return (
    <Link
      to="/admin/subscriptions/$subscriptionId"
      params={{ subscriptionId: row.id }}
      data-testid="subscription-summary-row-link"
      style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          gap: 0.5,
          columnGap: 2,
          p: 1.5,
          borderRadius: 'md',
          '&:hover': { bgcolor: 'admin.surface' },
        }}
      >
        <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap" sx={{ minWidth: 0 }}>
          <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
            {row.planName}
          </Typography>
          {row.organizationName && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="subscription-summary-org">
              {row.organizationName}
            </Typography>
          )}
          <StatusChip tone={statusDisplay.tone} label={statusDisplay.label} data-testid="subscription-summary-status" />
          {row.isComped && <StatusChip tone="info" label="Comped" data-testid="subscription-summary-comped" />}
        </Stack>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted', textAlign: 'right' }}>
          {row.dateLabel}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="subscription-summary-credits">
          {row.creditsPerCycle === null ? '-' : `${row.creditsPerCycle.toLocaleString()} credits`}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted', textAlign: 'right' }}>
          MRR -
        </Typography>
      </Box>
    </Link>
  );
};

const SummarySkeleton: React.FC = () => (
  <Stack gap={1} sx={{ p: 1.5 }} data-testid="subscription-summary-loading">
    <Skeleton variant="text" width="60%" />
    <Skeleton variant="text" width="40%" />
  </Stack>
);

/** Read-only subscription rows for one user; editing lives on the subscription detail page. */
export const SubscriptionSummaryList: React.FC<{ userId: string }> = ({ userId }) => {
  const { data, isLoading, isError, refetch } = useGetUserSubscriptions(userId);

  if (isLoading) return <SummarySkeleton />;
  if (isError || !data) {
    return <ErrorState message="Could not load subscriptions." onRetry={() => void refetch()} />;
  }

  const rows: SummaryRow[] = [
    ...data.individualSubscriptions.map(subscription => ({
      id: subscription.id,
      planName: subscription.planName ?? 'Individual plan',
      organizationName: null,
      statusDisplay: subscriptionStatusDisplay(subscription),
      isComped: isComped(subscription),
      dateLabel: dateLabel(subscription),
      creditsPerCycle: subscription.effectiveCreditsPerCycle ?? null,
    })),
    ...data.teamSubscriptions.map(({ organization, subscription }) => ({
      id: subscription.id,
      planName: 'Team plan',
      organizationName: organization.name,
      statusDisplay: subscriptionStatusDisplay(subscription),
      isComped: isComped(subscription),
      dateLabel: dateLabel(subscription),
      creditsPerCycle: subscription.effectiveCreditsPerCycle ?? null,
    })),
  ];

  if (rows.length === 0) {
    return (
      <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }} data-testid="subscription-summary-empty">
        No subscriptions
      </Typography>
    );
  }

  return (
    <Stack data-testid="subscription-summary-list">
      {rows.map(row => (
        <SummaryRowLink key={row.id} row={row} />
      ))}
    </Stack>
  );
};
