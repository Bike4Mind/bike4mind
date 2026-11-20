import { Typography, Stack } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { SubscriptionUsage } from '@bike4mind/server-utils/app/utils/subscriptionUsage';
import { ErrorState, LoadingState, SectionCard, Fact } from '../shared';

const COVERAGE_LABELS: Record<SubscriptionUsage['coverage'], string> = {
  observed:
    'Recorded observations only; recording continuity is not guaranteed. No records is not proof of inactivity.',
  incomplete: 'Incomplete or stale recording history; missing usage is unknown.',
  new: 'New subscription: less than 28 days observed. Excluded from follow-up cohorts.',
  internal: 'Internal/test billing owner. Excluded from follow-up cohorts.',
  unknown: 'History or billing owner is unknown. Excluded from follow-up cohorts.',
  unavailable: 'Usage is unavailable. No conclusion about activity can be drawn.',
};
const count = (value: number | null) => (value === null ? 'Unknown' : value.toLocaleString('en-US'));

export function SubscriptionUsageObservation({
  usage,
  compact = false,
}: {
  usage?: SubscriptionUsage;
  compact?: boolean;
}) {
  if (!usage) return <Typography level="body-sm">Usage unavailable</Typography>;
  if (compact)
    return (
      <Stack
        gap={0.5}
        title={`${COVERAGE_LABELS[usage.coverage]} Window: ${usage.from} to ${usage.to}. Queried: ${usage.queriedAt}. Latest stored event: ${usage.latestRecordedAt ?? 'Unknown'}.`}
        data-testid="subscription-usage-cell"
      >
        <Typography level="body-sm">
          {count(usage.firstPartyRequests)} first-party / {count(usage.apiRequests)} API
        </Typography>
        <Typography level="body-xs">
          {count(usage.creditsConsumed)} credits; {usage.coverage}
        </Typography>
        <Typography level="body-xs">
          Last success (28d): {usage.lastSuccessfulAt?.slice(0, 10) ?? 'Unknown / none recorded'}
        </Typography>
      </Stack>
    );
  return (
    <Stack gap={0.5} data-testid="subscription-usage-observation">
      <Typography level="body-sm">
        {count(usage.firstPartyRequests)} first-party / {count(usage.apiRequests)} API successful provider requests
      </Typography>
      <Typography level="body-sm">{count(usage.creditsConsumed)} credits consumed</Typography>
      <Typography level="body-xs">
        Last successful recorded usage (28d): {usage.lastSuccessfulAt ?? 'Unknown / none recorded'}
      </Typography>
      <Typography level="body-xs">{COVERAGE_LABELS[usage.coverage]}</Typography>
      <Typography level="body-xs">
        Window: {usage.from} to {usage.to}. Queried: {usage.queriedAt}.
      </Typography>
      <Typography level="body-xs">
        Store records since: {usage.recordedSince ?? 'Unknown'}. Latest stored event:{' '}
        {usage.latestRecordedAt ?? 'Unknown'}.
      </Typography>
    </Stack>
  );
}

export function SubscriptionUsageSummary({ subscriptionId, status }: { subscriptionId: string; status: string }) {
  const query = useQuery({
    queryKey: ['admin', 'subscriptions', 'usage', subscriptionId],
    queryFn: async () =>
      (await api.get<SubscriptionUsage>('/api/admin/subscriptions/usage', { params: { subscriptionId } })).data,
    staleTime: 30_000,
  });
  return (
    <SectionCard title="Billing status versus usage">
      <Fact label="Billing status">{status}</Fact>
      <Fact label="Billed-owner usage (28 days)">
        {query.isPending ? (
          <LoadingState label="Loading subscriber usage" />
        ) : query.isError ? (
          <ErrorState message="Subscriber usage could not be loaded." onRetry={() => void query.refetch()} />
        ) : (
          <SubscriptionUsageObservation usage={query.data} />
        )}
      </Fact>
      <Fact label="Definitions">
        <Typography level="body-xs">
          Billed-owner usage only, never personal activity of members. Provider requests follow Analytics source
          definitions (web, CLI, Desktop and agent; API separately). Credits include charged failed calls, not purchases
          or refunds. These are observations, not churn predictions.
        </Typography>
      </Fact>
    </SectionCard>
  );
}
