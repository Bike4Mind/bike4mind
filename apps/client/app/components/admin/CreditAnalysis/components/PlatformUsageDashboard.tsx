import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
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
import { formatCredits, formatUsd, numberCell } from '../utils/format';
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

const ConsumerTable: React.FC<{ consumers: NamedPlatformConsumerUsage[] }> = ({ consumers }) => (
  <Box>
    <Typography level="title-sm" sx={{ mb: 1 }}>
      By API key consumer
    </Typography>
    <Typography level="body-xs" color="neutral" sx={{ mb: 1 }}>
      Programmatic spend per API key, attributed to the key&apos;s billing owner. Only API completions carry a key, so
      web/agent/system usage never appears here.
    </Typography>
    <Sheet sx={{ maxHeight: 360, overflow: 'auto' }}>
      <Table stickyHeader hoverRow size="sm" data-testid="platform-usage-consumer-table">
        <thead>
          <tr>
            <th>API key</th>
            <th>Owner</th>
            <th style={{ textAlign: 'right' }}>Requests</th>
            <th style={{ textAlign: 'right' }}>Input tokens</th>
            <th style={{ textAlign: 'right' }}>Output tokens</th>
            <th style={{ textAlign: 'right' }}>COGS</th>
            <th style={{ textAlign: 'right' }}>Credits</th>
          </tr>
        </thead>
        <tbody>
          {consumers.map(c => (
            <tr key={c.apiKeyId}>
              <td title={c.apiKeyId}>
                <Typography level="body-sm">{c.keyName ?? 'Unknown key'}</Typography>
                {c.keyPrefix && (
                  <Typography level="body-xs" color="neutral" fontFamily="code">
                    {c.keyPrefix}
                  </Typography>
                )}
              </td>
              <td>
                <ConsumerOwner consumer={c} />
              </td>
              <td style={{ textAlign: 'right', ...numberCell }}>{c.requests.toLocaleString()}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{c.inputTokens.toLocaleString()}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{c.outputTokens.toLocaleString()}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{formatUsd(c.cogsUsd)}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{formatCredits(c.creditsCharged)}</td>
            </tr>
          ))}
          {consumers.length === 0 && (
            <tr>
              <td colSpan={7}>
                <Typography level="body-sm" color="neutral">
                  No API-key consumers in this window.
                </Typography>
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </Sheet>
  </Box>
);

const EndpointTable: React.FC<{ endpoints: IPlatformEndpointUsage['byEndpoint'] }> = ({ endpoints }) => (
  <Sheet sx={{ maxHeight: 360, overflow: 'auto' }}>
    <Table stickyHeader hoverRow size="sm" data-testid="platform-usage-endpoint-table">
      <thead>
        <tr>
          <th>Endpoint</th>
          <th style={{ width: 80 }}>Method</th>
          <th style={{ textAlign: 'right' }}>Requests</th>
          <th style={{ textAlign: 'right' }}>Error rate</th>
          <th style={{ textAlign: 'right' }}>Avg latency</th>
          <th style={{ textAlign: 'right' }}>p95 latency</th>
        </tr>
      </thead>
      <tbody>
        {endpoints.map(e => (
          <tr key={`${e.method} ${e.endpoint}`}>
            <td>
              <Typography level="body-sm" fontFamily="code">
                {e.endpoint}
              </Typography>
            </td>
            <td>{e.method}</td>
            <td style={{ textAlign: 'right', ...numberCell }}>{e.requests.toLocaleString()}</td>
            <td style={{ textAlign: 'right', ...numberCell }}>{formatPercent(e.errorRate)}</td>
            <td style={{ textAlign: 'right', ...numberCell }}>{formatMs(e.avgResponseTimeMs)}</td>
            <td style={{ textAlign: 'right', ...numberCell }}>{formatMs(e.p95ResponseTimeMs)}</td>
          </tr>
        ))}
        {endpoints.length === 0 && (
          <tr>
            <td colSpan={6}>
              <Typography level="body-sm" color="neutral">
                No API-key requests in this window.
              </Typography>
            </td>
          </tr>
        )}
      </tbody>
    </Table>
  </Sheet>
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
}> = ({ source, onSourceChange, data, isLoading, error }) => {
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
        From the API-key request log, which records api and cli traffic only.
        {source !== ALL ? ' Filtering excludes requests logged before source was recorded.' : ''}{' '}
        {data ? `Last ${data.windowDays} days, independent of the filters above.` : 'Independent of the filters above.'}
      </Typography>

      {error ? (
        <Alert color="danger" data-testid="platform-usage-endpoint-error">
          {(error as Error)?.message || 'Failed to load endpoint traffic'}
        </Alert>
      ) : isLoading || !data ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }} data-testid="platform-usage-endpoint-loading">
          <CircularProgress />
        </Box>
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
          <EndpointTable endpoints={data.endpoints.byEndpoint} />
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
    <Box sx={{ p: { xs: 1, sm: 2 } }} data-testid="platform-usage-dashboard">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        sx={{ mb: 1 }}
      >
        <Select<SourceFilter>
          size="sm"
          value={source}
          onChange={(_, value) => value && setSource(value)}
          sx={{ minWidth: 150 }}
          data-testid="platform-usage-source-select"
        >
          <Option value={ALL}>All sources</Option>
          {COMPLETION_SOURCES.map(s => (
            <Option key={s} value={s}>
              {s}
            </Option>
          ))}
        </Select>
        <Select<OwnerTypeFilter>
          size="sm"
          value={ownerType}
          onChange={(_, value) => value && setOwnerType(value)}
          sx={{ minWidth: 150 }}
          data-testid="platform-usage-owner-type-select"
        >
          {OWNER_TYPE_OPTIONS.map(o => (
            <Option key={o.value} value={o.value}>
              {o.label}
            </Option>
          ))}
        </Select>
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" spacing={1} alignItems="center">
          <ToggleButtonGroup
            size="sm"
            value={String(days)}
            onChange={(_, value) => value && setDays(Number(value) as DayRange)}
            data-testid="platform-usage-range-toggle"
          >
            {DAY_RANGES.map(r => (
              <Button key={r} value={String(r)}>
                {r}d
              </Button>
            ))}
          </ToggleButtonGroup>
          <IconButton
            size="sm"
            onClick={() => {
              refetch();
              refetchEndpoints();
            }}
            disabled={isFetching || endpointsFetching}
            data-testid="platform-usage-refresh-btn"
          >
            <RefreshIcon />
          </IconButton>
        </Stack>
      </Stack>

      <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
        Usage across every owner on the platform. Credits and COGS come from usage events recorded since deploy; the
        source and owner-type filters apply to every credit section.
      </Alert>

      {error && (
        <Alert color="danger" sx={{ mb: 2 }} data-testid="platform-usage-error">
          {(error as Error)?.message || 'Failed to load platform usage'}
        </Alert>
      )}

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }} data-testid="platform-usage-loading">
          <CircularProgress />
        </Box>
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

            <ConsumerTable consumers={data.byConsumer} />

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
                key: `${r.provider}-${r.model}`,
                label: `${r.provider} / ${r.model}`,
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
        />
      </Box>
    </Box>
  );
};
