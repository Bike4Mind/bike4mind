import React from 'react';
import { Link } from '@tanstack/react-router';
import { Box, Skeleton, Stack, Typography } from '@mui/joy';
import dayjs from 'dayjs';
import { SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { useGetUserSubscriptions } from '@client/app/hooks/data/subscriptions';
import { isTerminalSubscriptionStatus } from '@client/app/utils/adminSubscriptionDetail';
import { ErrorState } from '../shared/ErrorState';
import { StatusChip } from '../shared/StatusChip';
import { showsCompedChip, subscriptionStatusDisplay } from './Detail/subscriptionStatus';

type SummaryRow = {
  id: string;
  planName: string;
  organizationName: string | null;
  status: string;
  isComped: boolean;
  dateLabel: string;
  creditsPerCycle: number | null;
};

type SourceFields = { source?: SubscriptionSource | string; status: string };

const formatDate = (date: Date | string): string => dayjs(date).format('MMM D, YYYY');

const dateLabel = (row: { status: string; periodEndsAt: Date | string; canceledAt: Date | string | null }): string => {
  if (row.canceledAt) return `Ended ${formatDate(row.canceledAt)}`;
  if (isTerminalSubscriptionStatus(row.status)) return `Ended ${formatDate(row.periodEndsAt)}`;
  return `Renews ${formatDate(row.periodEndsAt)}`;
};

const isComped = ({ source, status }: SourceFields): boolean =>
  showsCompedChip({ source: source === SubscriptionSource.AdminGrant ? 'admin_grant' : 'stripe', status });

const SummaryRowLink: React.FC<{ row: SummaryRow }> = ({ row }) => {
  const statusDisplay = subscriptionStatusDisplay(row.status);
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
      status: subscription.status,
      isComped: isComped(subscription),
      dateLabel: dateLabel(subscription),
      creditsPerCycle: subscription.effectiveCreditsPerCycle ?? null,
    })),
    ...data.teamSubscriptions.map(({ organization, subscription }) => ({
      id: subscription.id,
      planName: 'Team plan',
      organizationName: organization.name,
      status: subscription.status,
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
