import { Button, Input, Stack, Typography } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  ADOPTION_CLIENTS,
  adoptionQueryParams,
  featureAdoptionQuerySchema,
  featureAdoptionResponseSchema,
  type AdoptionFeature,
} from '@client/app/utils/featureAdoption';
import {
  DataTable,
  ErrorState,
  FilterChip,
  LoadingState,
  SegmentedControl,
  UpdatingBar,
  useAdminListUrlState,
} from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { EVENTS_SEARCH_KEYS } from './eventsTabSearch';

export function AdoptionView() {
  const [state, update] = useAdminListUrlState(EVENTS_SEARCH_KEYS);
  const filters = state.filters;
  const patch = (next: Record<string, string>) => update({ filters: { ...filters, ...next } });
  const parsed = featureAdoptionQuerySchema.safeParse({
    accounts: filters.accounts || undefined,
    client: filters.client || undefined,
    days: filters.days || undefined,
    end: filters.end || undefined,
  });
  const params = parsed.success ? adoptionQueryParams(parsed.data) : '';
  const query = useQuery({
    queryKey: ['feature-adoption', params],
    enabled: parsed.success,
    queryFn: async () =>
      featureAdoptionResponseSchema.parse((await api.get(`/api/admin/analytics/feature-adoption?${params}`)).data),
    staleTime: 60_000,
  });
  const refresh = () => {
    void query.refetch();
  };
  const data = query.data;
  const selected = data?.features.find(row => row.feature === filters.feature);
  const exportData = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `feature-adoption-${data.query.accounts}-${data.query.client}-${data.window.to}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="feature-adoption-view">
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        <SegmentedControl
          options={[
            { value: 'external', label: 'External' },
            { value: 'internal', label: 'Internal' },
            { value: 'all', label: 'Everyone' },
          ]}
          value={filters.accounts || 'external'}
          onChange={accounts => patch({ accounts })}
          aria-label="Adoption audience"
          data-testid="adoption-audience"
        />
        <FilterChip
          id="adoption-days"
          label="Period"
          value={filters.days || '7'}
          options={[7, 28, 90].map(days => ({ value: String(days), label: `${days} complete days` }))}
          onChange={days => patch({ days: days || '7' })}
        />
        <FilterChip
          id="adoption-client"
          label="Client"
          value={filters.client || 'all'}
          options={ADOPTION_CLIENTS.map(client => ({
            value: client,
            label: client === 'all' ? 'All clients' : client === 'unknown' ? 'Unknown / mixed' : client,
          }))}
          onChange={client => patch({ client: client || 'all' })}
        />
        <Input
          type="date"
          size="sm"
          value={filters.end || ''}
          onChange={event => patch({ end: event.target.value })}
          slotProps={{
            input: { 'aria-label': 'Last complete UTC day (blank means yesterday)', 'data-testid': 'adoption-end' },
          }}
        />
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={refresh}
          disabled={!parsed.success}
          loading={query.isFetching}
          data-testid="adoption-refresh"
        >
          Refresh
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={exportData}
          disabled={!data || query.isFetching || query.isError || !parsed.success}
          data-testid="adoption-export"
        >
          Export observations (JSON)
        </Button>
      </Stack>
      <Typography level="body-sm">
        Observed successful use, not total product adoption. Coverage start and completeness, launch date, rollout/plan
        eligibility and eligible population are unknown. Discovery is not measured. Attempts, failures and success rates
        are unavailable. No release-effect or demand verdict is supported.
      </Typography>
      <Typography level="body-sm">
        Chat, image generation and image editing only. One successful operation per feature, user and request ID;
        retries share that key. Tool/background features and worker runs are excluded. Client is the recorded source,
        not a verified device; missing or mixed attribution stays unknown. API and agent can be selected separately.
        Audience uses current Analytics account classification and account-access exclusions.
      </Typography>
      {!parsed.success ? (
        <ErrorState
          message="Invalid adoption filters. Choose a supported audience, client, period and date."
          onRetry={() => patch({ accounts: '', client: '', days: '', end: '' })}
        />
      ) : query.isPending ? (
        <LoadingState label="Loading feature adoption" />
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : 'Feature adoption failed to load.'}
          onRetry={refresh}
        />
      ) : (
        data && (
          <>
            <UpdatingBar active={query.isFetching} testId="adoption-updating" />
            <Typography level="body-sm" data-testid="adoption-window">
              Complete UTC days: {data.window.from} to {data.window.to}; previous: {data.window.previousFrom} to{' '}
              {data.window.previousTo}. Comparisons are observations over equal windows, not signup-cohort retention.
              Maturity is unknown. No previous records means unavailable, not zero. Counts are not population rates.
            </Typography>
            <DataTable<AdoptionFeature>
              rows={data.features}
              getRowId={row => row.feature}
              label="Feature adoption"
              onRetry={refresh}
              testId="adoption-table"
              pagination={false}
              rowTestId={row => `adoption-row-${row.feature}`}
              onRowActivate={row => patch({ feature: row.feature })}
              columns={[
                {
                  id: 'feature',
                  label: 'Feature',
                  render: row => (
                    <Button
                      variant="plain"
                      color="neutral"
                      size="sm"
                      data-testid={`adoption-detail-${row.feature}`}
                      onClick={() => patch({ feature: row.feature })}
                    >
                      {row.label}
                    </Button>
                  ),
                },
                {
                  id: 'users',
                  label: 'Successful users (observed)',
                  numeric: true,
                  render: row => row.successfulUsers,
                },
                {
                  id: 'previous',
                  label: 'Previous users (observed)',
                  numeric: true,
                  render: row => row.previousUsers ?? 'Unavailable',
                },
                {
                  id: 'change',
                  label: 'User change',
                  numeric: true,
                  render: row =>
                    row.userChange === null ? 'Unavailable' : `${row.userChange > 0 ? '+' : ''}${row.userChange}`,
                },
                {
                  id: 'operations',
                  label: 'Successful operations',
                  numeric: true,
                  render: row => row.successfulOperations,
                },
                {
                  id: 'repeat',
                  label: 'Returned / previous users',
                  render: row =>
                    row.repeatDenominator === null ? 'Unavailable' : `${row.repeatUsers} / ${row.repeatDenominator}`,
                },
              ]}
            />
            {selected && (
              <Stack gap={1} data-testid="adoption-detail">
                <Typography level="title-md">{selected.label}: user contributions</Typography>
                <Typography level="body-sm">
                  Returned means the same person successfully used this feature in both complete periods, not multiple
                  events in one session. Small cohorts are shown as counts. Operation-level receipts are not included in
                  this first slice.
                </Typography>
                <Button
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={() => patch({ feature: '' })}
                  data-testid="adoption-close-detail"
                >
                  Close detail
                </Button>
                <DataTable
                  rows={selected.users}
                  getRowId={row => row.userId}
                  label={`${selected.label} users`}
                  onRetry={refresh}
                  pageResetKey={`${params}-${selected.feature}`}
                  testId="adoption-users"
                  columns={[
                    { id: 'user', label: 'User ID', render: row => row.userId },
                    { id: 'current', label: 'Successful operations', numeric: true, render: row => row.operations },
                    {
                      id: 'previous',
                      label: 'Previous operations (observed)',
                      numeric: true,
                      render: row => row.previousOperations,
                    },
                    {
                      id: 'returned',
                      label: 'Returned',
                      render: row => (row.operations > 0 && row.previousOperations > 0 ? 'Yes' : 'No'),
                    },
                  ]}
                />
              </Stack>
            )}
          </>
        )
      )}
    </Stack>
  );
}
