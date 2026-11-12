import React, { useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Option, Select, Sheet, Stack, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  API_KEY_COMPLETION_SOURCES,
  COMPLETION_SOURCES,
  CreditHolderType,
  type ApiKeyCompletionSource,
  type CompletionSource,
  type IPlatformEndpointUsage,
  type IPlatformEndpointUsageResponse,
  type NamedPlatformConsumerUsage,
  type UsageOwnerType,
} from '@bike4mind/common';
import { BreakdownTable } from '@client/app/components/common/BreakdownTable';
import { AdminPageHeader, DataTable, FilterBar, LoadingState, ErrorState, EmptyState } from '../../shared';
import { formatCredits, formatUsd, modelKey, modelLabel } from '../utils/format';
import { zeroFillDailySeries } from '../utils/dailySeries';
import { useEndpointUsage } from '../hooks/useEndpointUsage';
import { usePlatformUsage } from '../hooks/usePlatformUsage';
import { DailyAreaChart } from './DailyAreaChart';
import ViewUserProfile from './ViewUserProfile';

// The route accepts 1-365.
const DAY_RANGES = [7, 30, 90, 365] as const;
type DayRange = (typeof DAY_RANGES)[number];

const ALL = 'all';
type SourceFilter = CompletionSource | typeof ALL;
type EndpointSourceFilter = ApiKeyCompletionSource | typeof ALL;
type OwnerTypeFilter = UsageOwnerType | typeof ALL;

const OWNER_TYPE_OPTIONS: { value: OwnerTypeFilter; label: string }[] = [
  { value: ALL, label: 'All owners' },
  { value: CreditHolderType.User, label: 'Users' },
  { value: CreditHolderType.Organization, label: 'Organizations' },
];

const formatPercent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;
const formatMs = (ms: number) => `${Math.round(ms).toLocaleString()} ms`;

const ConsumerOwner: React.FC<{ consumer: NamedPlatformConsumerUsage }> = ({ consumer }) => {
  if (!consumer.ownerId) {
    return (
      <Typography level="body-sm" color="neutral">
        Unknown owner
      </Typography>
    );
  }
  const isOrg = consumer.ownerType === CreditHolderType.Organization;
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Chip size="sm" variant="soft" color={isOrg ? 'primary' : 'neutral'}>
        {isOrg ? 'Org' : 'User'}
      </Chip>
      <Typography level="body-sm" title={consumer.ownerId}>
        {consumer.ownerName ?? (isOrg ? 'Unknown organization' : 'Unknown user')}
      </Typography>
      {!isOrg && <ViewUserProfile userId={consumer.ownerId} size="sm" />}
    </Stack>
  );
};

const ConsumerTable: React.FC<{ consumers: NamedPlatformConsumerUsage[]; onRetry: () => void }> = ({
  consumers,
  onRetry,
}) => (
  <Box>
    <Typography level="title-sm" sx={{ mb: 1 }}>
      By API key consumer
    </Typography>
    <Typography level="body-xs" color="neutral" sx={{ mb: 1 }}>
      Programmatic spend per API key, attributed to the key&apos;s billing owner. Only API completions carry a key, so
      web/agent/system usage never appears here.
    </Typography>
    <DataTable
      label="By API key consumer"
      testId="platform-usage-consumer-table"
      rows={consumers}
      getRowId={row => row.apiKeyId}
      pagination={false}
      maxHeight="360px"
      onRetry={onRetry}
      empty={<EmptyState title="No API-key consumers in this window" action={null} />}
      columns={[
        {
          id: 'key',
          label: 'API key',
          render: row => (
            <span title={row.apiKeyId}>
              {row.keyName ?? 'Unknown key'}
              {row.keyPrefix && (
                <Typography level="body-xs" color="neutral">
                  {row.keyPrefix}
                </Typography>
              )}
            </span>
          ),
        },
        { id: 'owner', label: 'Owner', render: row => <ConsumerOwner consumer={row} /> },
        { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.toLocaleString() },
        { id: 'input', label: 'Input tokens', numeric: true, render: row => row.inputTokens.toLocaleString() },
        { id: 'output', label: 'Output tokens', numeric: true, render: row => row.outputTokens.toLocaleString() },
        { id: 'cogs', label: 'COGS', numeric: true, render: row => formatUsd(row.cogsUsd) },
        { id: 'credits', label: 'Credits', numeric: true, render: row => formatCredits(row.creditsCharged) },
      ]}
    />
  </Box>
);

const EndpointTable: React.FC<{ endpoints: IPlatformEndpointUsage['byEndpoint']; onRetry: () => void }> = ({
  endpoints,
  onRetry,
}) => (
  <DataTable
    label="Endpoint traffic"
    testId="platform-usage-endpoint-table"
    rows={endpoints}
    getRowId={row => `${row.method} ${row.endpoint}`}
    pagination={false}
    maxHeight="360px"
    onRetry={onRetry}
    empty={<EmptyState title="No API-key requests in this window" action={null} />}
    columns={[
      {
        id: 'endpoint',
        label: 'Endpoint',
        render: row => (
          <Typography level="body-sm" fontFamily="code">
            {row.endpoint}
          </Typography>
        ),
      },
      { id: 'method', label: 'Method', render: row => row.method },
      { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.toLocaleString() },
      { id: 'error', label: 'Error rate', numeric: true, render: row => formatPercent(row.errorRate) },
      { id: 'avg', label: 'Avg latency', numeric: true, render: row => formatMs(row.avgResponseTimeMs) },
      { id: 'p95', label: 'p95 latency', numeric: true, render: row => formatMs(row.p95ResponseTimeMs) },
    ]}
  />
);

/**
 * Endpoint traffic from the API-key request log. Deliberately a separate, outlined
 * panel in a different chart color: this data carries request counts and latency
 * only, and must never read as COGS-per-endpoint next to the credit sections. It
 * has its own source filter and always spans the log's full 90 days, independent of
 * the page-wide controls that drive the credit sections.
 */
const EndpointSection: React.FC<{
  source: EndpointSourceFilter;
  onSourceChange: (source: EndpointSourceFilter) => void;
  data: IPlatformEndpointUsageResponse | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}> = ({ source, onSourceChange, data, isLoading, error, onRetry }) => {
  const chartData = useMemo(
    () => (data ? zeroFillDailySeries(data.endpoints.overTime, data.windowDays, d => d.requests) : []),
    [data]
  );

  return (
    <Sheet
      variant="outlined"
      color="warning"
      sx={{ p: 2, borderRadius: 'md', borderStyle: 'dashed' }}
      data-testid="platform-usage-endpoint-section"
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography level="title-md">Endpoint traffic</Typography>
        <Chip size="sm" variant="soft" color="warning">
          Request volume only - no credits or COGS
        </Chip>
        <Box sx={{ flex: 1 }} />
        <Select<EndpointSourceFilter>
          size="sm"
          value={source}
          onChange={(_, value) => value && onSourceChange(value)}
          sx={{ minWidth: 150 }}
          data-testid="platform-usage-endpoint-source-select"
        >
          <Option value={ALL}>All sources</Option>
          {API_KEY_COMPLETION_SOURCES.map(s => (
            <Option key={s} value={s}>
              {s}
            </Option>
          ))}
        </Select>
      </Stack>
      <Typography level="body-xs" color="neutral" sx={{ mb: 2 }}>
        From the API-key request log, which records api, cli and desktop traffic only.
        {source !== ALL ? ' Filtering excludes requests logged before source was recorded.' : ''}{' '}
        {data ? `Last ${data.windowDays} days, independent of the filters above.` : 'Independent of the filters above.'}
      </Typography>

      {error ? (
        <ErrorState
          message={error instanceof Error ? error.message : 'Failed to load endpoint traffic'}
          onRetry={onRetry}
        />
      ) : isLoading || !data ? (
        <LoadingState label="Loading endpoint traffic" testId="platform-usage-endpoint-loading" />
      ) : (
        <Stack spacing={2}>
          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Requests over time
            </Typography>
            <DailyAreaChart
              data={chartData}
              valueLabel="Requests"
              formatValue={value => value.toLocaleString()}
              color="warning"
              testid="platform-usage-endpoint-chart"
            />
          </Box>
          <EndpointTable endpoints={data.endpoints.byEndpoint} onRetry={onRetry} />
        </Stack>
      )}
    </Sheet>
  );
};

/**
 * Platform-wide API usage for admins: which APIs are consumed, by whom, from
 * where. Credit/COGS cuts (consumer, feature, model) come from usage events and
 * honour the source + owner-type filters; the endpoint panel comes from the
 * API-key request log, keeps its own source filter and window, and is kept
 * visually apart. See GET /api/admin/platform-usage and /platform-usage/endpoints.
 */
export const PlatformUsageDashboard: React.FC = () => {
  // Defaults to 'api': the third-party / programmatic consumer view this tab exists for.
  const [source, setSource] = useState<SourceFilter>('api');
  const [ownerType, setOwnerType] = useState<OwnerTypeFilter>(ALL);
  const [days, setDays] = useState<DayRange>(30);

  const { data, isLoading, isFetching, error, refetch } = usePlatformUsage({
    days,
    source: source === ALL ? undefined : source,
    ownerType: ownerType === ALL ? undefined : ownerType,
  });

  const [endpointSource, setEndpointSource] = useState<EndpointSourceFilter>(ALL);
  const {
    data: endpointData,
    isLoading: endpointsLoading,
    isFetching: endpointsFetching,
    error: endpointsError,
    refetch: refetchEndpoints,
  } = useEndpointUsage(endpointSource === ALL ? undefined : endpointSource);

  const hasUsage = (data?.totals.requests ?? 0) > 0;
  const creditsSeries = useMemo(
    () => zeroFillDailySeries(data?.overTime ?? [], days, d => d.creditsCharged),
    [data, days]
  );

  return (
    <Stack gap={2} data-testid="platform-usage-dashboard">
      <AdminPageHeader
        level="section"
        title="API usage"
        description="Usage across every owner on the platform. Source and owner filters apply to credit sections, not endpoint traffic."
        actions={
          <Button
            variant="plain"
            startDecorator={<RefreshIcon />}
            onClick={() => {
              void refetch();
              void refetchEndpoints();
            }}
            disabled={isFetching || endpointsFetching}
            data-testid="platform-usage-refresh-btn"
          >
            Refresh usage
          </Button>
        }
      />
      <FilterBar
        search={false}
        state={{ query: '', view: '', filters: { source, ownerType, days: String(days) } }}
        filters={[
          {
            id: 'source',
            label: 'Source',
            options: [
              { value: ALL, label: 'All sources' },
              ...COMPLETION_SOURCES.map(value => ({ value, label: value })),
            ],
          },
          { id: 'ownerType', label: 'Owner', options: OWNER_TYPE_OPTIONS },
          {
            id: 'days',
            label: 'Window',
            options: DAY_RANGES.map(value => ({ value: String(value), label: `${value} days` })),
          },
        ]}
        onChange={patch => {
          if (!patch.filters) return;
          setSource((patch.filters.source || ALL) as SourceFilter);
          setOwnerType((patch.filters.ownerType || ALL) as OwnerTypeFilter);
          setDays(Number(patch.filters.days || 30) as DayRange);
        }}
      />

      <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
        Usage across every owner on the platform. Credits and COGS come from usage events recorded since deploy; the
        source and owner-type filters apply to every credit section.
      </Alert>

      {error ? (
        <ErrorState
          message={error instanceof Error ? error.message : 'Failed to load platform usage'}
          onRetry={() => void refetch()}
        />
      ) : isLoading || !data ? (
        <LoadingState label="Loading platform usage" testId="platform-usage-loading" />
      ) : (
        data && (
          <Stack spacing={3}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip color="primary" variant="soft" data-testid="platform-usage-total-credits">
                {formatCredits(data.totals.creditsCharged)} credits
              </Chip>
              <Chip color="neutral" variant="soft" data-testid="platform-usage-total-cogs">
                {formatUsd(data.totals.cogsUsd)} COGS
              </Chip>
              <Chip color="neutral" variant="soft" data-testid="platform-usage-total-requests">
                {data.totals.requests.toLocaleString()} requests
              </Chip>
            </Stack>

            <Box>
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Credits over time
              </Typography>
              {hasUsage ? (
                <DailyAreaChart
                  data={creditsSeries}
                  valueLabel="Credits"
                  formatValue={formatCredits}
                  color="primary"
                  testid="platform-usage-credits-chart"
                />
              ) : (
                <Typography level="body-sm" color="neutral">
                  No usage in this window.
                </Typography>
              )}
            </Box>

            <ConsumerTable consumers={data.byConsumer} onRetry={() => void refetch()} />

            <BreakdownTable
              title="By feature"
              testid="platform-usage-feature-table"
              keyLabel="Feature"
              rows={data.byFeature.map(r => ({
                key: r.feature,
                label: r.feature,
                requests: r.requests,
                cogsUsd: r.cogsUsd,
                creditsCharged: r.creditsCharged,
              }))}
            />

            <BreakdownTable
              title="By model"
              testid="platform-usage-model-table"
              keyLabel="Model"
              rows={data.byModel.map(r => ({
                key: modelKey(r),
                label: modelLabel(r),
                requests: r.requests,
                cogsUsd: r.cogsUsd,
                creditsCharged: r.creditsCharged,
              }))}
            />
          </Stack>
        )
      )}

      <Box sx={{ mt: 3 }}>
        <EndpointSection
          source={endpointSource}
          onSourceChange={setEndpointSource}
          data={endpointData}
          isLoading={endpointsLoading}
          error={endpointsError}
          onRetry={() => void refetchEndpoints()}
        />
      </Box>
    </Stack>
  );
};
