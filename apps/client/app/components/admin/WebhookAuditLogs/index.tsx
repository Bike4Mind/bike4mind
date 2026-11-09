import React, { useEffect, useMemo, type ReactNode } from 'react';
import { isAxiosError } from 'axios';
import { Alert, Box, Button, IconButton, Skeleton, Stack, Tooltip, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { FieldTooltip } from '@client/app/components/help';
import { WebhookAuditStatus, type IWebhookAuditLogDocument } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  useWebhookAuditLogs,
  useWebhookAuditLog,
  useWebhookAuditStats,
  getDateRangePreset,
  WebhookAuditFiltersParams,
} from '@client/app/hooks/data/webhookAuditLogs';
import {
  WEBHOOK_DATE_PRESET_LABELS,
  WEBHOOK_DATE_PRESETS,
  WEBHOOK_EVENT_OPTIONS,
  WEBHOOK_SOURCE_LABELS,
  WEBHOOK_SOURCE_TYPES,
  WEBHOOK_STATUS_LABELS,
  WEBHOOK_STATUSES,
  type WebhookDatePreset,
} from './webhookAuditLogsTabSearch';
import { useWebhookAuditLogsSearch } from './useWebhookAuditLogsSearch';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import {
  AdminDialog,
  AdminPageHeader,
  AdminSearchInput,
  DataTable,
  EmptyState,
  ErrorState,
  Fact,
  FilterChip,
  LoadingState,
  SegmentedControl,
  StatStrip,
  StatTile,
  StatusChip,
  UpdatingBar,
  type DataColumn,
  type SegmentedOption,
} from '../shared';
import { ADMIN_REGION_GAP, adminFocusScope } from '../shared/adminStyles';

type WebhookLog = IWebhookAuditLogDocument;

// Received and Processing are both still pending; a delivery that stays in either needs a look.
const STATUS_TONES: Readonly<Record<WebhookAuditStatus, AdminStatusTone>> = {
  [WebhookAuditStatus.Received]: 'warn',
  [WebhookAuditStatus.Processing]: 'warn',
  [WebhookAuditStatus.Completed]: 'good',
  [WebhookAuditStatus.Failed]: 'bad',
};

const DeliveryStatusChip: React.FC<{ status: WebhookAuditStatus }> = ({ status }) => (
  <StatusChip
    tone={STATUS_TONES[status] ?? 'neutral'}
    label={WEBHOOK_STATUS_LABELS[status] ?? status}
    dot
    data-testid="webhook-logs-status-chip"
  />
);

const RANGE_SEGMENTS: readonly SegmentedOption<WebhookDatePreset>[] = WEBHOOK_DATE_PRESETS.map(preset => ({
  value: preset,
  label: preset,
}));
const SOURCE_OPTIONS = WEBHOOK_SOURCE_TYPES.map(sourceType => ({
  value: sourceType,
  label: WEBHOOK_SOURCE_LABELS[sourceType],
}));
const EVENT_OPTIONS = WEBHOOK_EVENT_OPTIONS.map(event => ({ value: event, label: event }));
const STATUS_OPTIONS = WEBHOOK_STATUSES.map(status => ({ value: status, label: WEBHOOK_STATUS_LABELS[status] }));

/** Org-level webhooks carry an organization, per-user ones an MCP server. */
const sourceLabel = (log: Pick<WebhookLog, 'organizationId' | 'mcpServerId'>): string | undefined => {
  if (log.organizationId) return WEBHOOK_SOURCE_LABELS.org;
  if (log.mcpServerId) return WEBHOOK_SOURCE_LABELS.user;
  return undefined;
};

const NoValue = () => (
  <Box component="span" sx={{ color: 'admin.inkMuted' }}>
    -
  </Box>
);

const Truncated: React.FC<{ text: string }> = ({ text }) => (
  <Box
    component="span"
    title={text}
    sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
  >
    {text}
  </Box>
);

const Mono: React.FC<{ children: ReactNode }> = ({ children }) => (
  <Typography component="span" level="body-xs" sx={{ fontFamily: 'code', color: 'admin.inkMuted' }}>
    {children}
  </Typography>
);

const LOG_COLUMNS: readonly DataColumn<WebhookLog>[] = [
  { id: 'time', label: 'Time', width: '9rem', render: log => relativeTimeFormat(new Date(log.receivedAt)) },
  { id: 'source', label: 'Source', width: '6rem', render: log => sourceLabel(log) ?? <NoValue /> },
  { id: 'event', label: 'Event', width: '12rem', render: log => <Truncated text={log.event} /> },
  { id: 'repository', label: 'Repository', render: log => <Truncated text={log.repository} /> },
  { id: 'status', label: 'Status', width: '8.5rem', render: log => <DeliveryStatusChip status={log.status} /> },
  {
    id: 'duration',
    label: 'Duration (ms)',
    width: '8rem',
    numeric: true,
    render: log => (log.processingDurationMs ? log.processingDurationMs.toLocaleString() : <NoValue />),
  },
  {
    id: 'sender',
    label: 'Sender',
    width: '9rem',
    render: log => (log.sender ? <Truncated text={log.sender} /> : <NoValue />),
  },
];

/** One titled group of facts in the delivery dialog; groups are split by a hairline, not a card. */
const DetailSection: React.FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <Box
    component="section"
    sx={{ pt: 2, borderTop: '1px solid', borderColor: 'admin.border', '&:first-of-type': { pt: 0, borderTop: 0 } }}
  >
    <Typography level="title-md" component="h3" sx={{ color: 'admin.ink', mb: 1 }}>
      {title}
    </Typography>
    <Box
      component="dl"
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(7.5rem, 40%) 1fr',
        columnGap: 1.5,
        rowGap: 1.25,
        '& dt': { color: 'admin.inkMuted' },
        '& dd': { m: 0, minWidth: 0, overflowWrap: 'anywhere', color: 'admin.ink' },
      }}
    >
      {children}
    </Box>
  </Box>
);

const DeliveryDetails: React.FC<{ log: WebhookLog }> = ({ log }) => {
  const metadata = log.metadata && Object.keys(log.metadata).length > 0 ? log.metadata : undefined;
  return (
    <Stack gap={2} data-testid="webhook-details">
      <DetailSection title="Status">
        <Fact label="Status">
          <DeliveryStatusChip status={log.status} />
        </Fact>
        <Fact label="Signature">
          {log.signatureVerified ? (
            <StatusChip tone="good" label="Verified" data-testid="webhook-details-signature-chip" />
          ) : (
            'Not verified'
          )}
        </Fact>
        <Fact label="Processing time (ms)">{log.processingDurationMs?.toLocaleString()}</Fact>
      </DetailSection>

      <DetailSection title="Identity">
        <Fact label="Source">{sourceLabel(log)}</Fact>
        {log.organizationId && (
          <Fact label="Organization ID">
            <Mono>{log.organizationId}</Mono>
          </Fact>
        )}
        {log.mcpServerId && (
          <Fact label="MCP server ID">
            <Mono>{log.mcpServerId}</Mono>
          </Fact>
        )}
        <Fact label="Delivery ID">
          <Stack direction="row" alignItems="center" gap={0.5}>
            <Mono>{log.deliveryId}</Mono>
            <Tooltip title="Copy delivery ID">
              <IconButton
                size="sm"
                variant="plain"
                aria-label="Copy delivery ID"
                onClick={() => navigator.clipboard.writeText(log.deliveryId)}
                data-testid="webhook-details-copy-delivery-id-btn"
              >
                <ContentCopyIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Fact>
        <Fact label="Correlation ID">{log.correlationId && <Mono>{log.correlationId}</Mono>}</Fact>
      </DetailSection>

      <DetailSection title="Event">
        <Fact label="Type">{log.event}</Fact>
        <Fact label="Repository">{log.repository}</Fact>
        <Fact label="Sender">{log.sender}</Fact>
      </DetailSection>

      {metadata && (
        <DetailSection title="Metadata">
          {metadata.prNumber && <Fact label="PR number">#{metadata.prNumber}</Fact>}
          {metadata.issueNumber && <Fact label="Issue number">#{metadata.issueNumber}</Fact>}
          {metadata.action && <Fact label="Action">{metadata.action}</Fact>}
          {metadata.branch && <Fact label="Branch">{metadata.branch}</Fact>}
        </DetailSection>
      )}

      {log.actions && log.actions.length > 0 && (
        <DetailSection title="Actions">
          {log.actions.map((action, index) => (
            <Fact key={index} label={action.type}>
              <Stack direction="row" alignItems="center" gap={1}>
                <StatusChip tone={action.status === 'success' ? 'good' : 'bad'} label={action.status} />
                {action.durationMs && <Mono>{action.durationMs}ms</Mono>}
              </Stack>
            </Fact>
          ))}
        </DetailSection>
      )}

      {log.error && (
        <Alert color="danger" data-testid="webhook-details-error">
          <Stack gap={0.5} sx={{ minWidth: 0 }}>
            <Typography level="title-sm" component="h3">
              Error
            </Typography>
            <Typography level="body-sm" sx={{ fontFamily: 'code', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {log.error.message}
            </Typography>
            {log.error.code && <Typography level="body-xs">Code: {log.error.code}</Typography>}
          </Stack>
        </Alert>
      )}

      <DetailSection title="Timeline">
        <Fact label="Received">{new Date(log.receivedAt).toLocaleString()}</Fact>
        {log.processedAt && <Fact label="Processed">{new Date(log.processedAt).toLocaleString()}</Fact>}
      </DetailSection>
    </Stack>
  );
};

const DeliveryDetailsDialog: React.FC<{
  deliveryId: string | null;
  onClose: () => void;
}> = ({ deliveryId, onClose }) => {
  const { data: log, isLoading, error, refetch } = useWebhookAuditLog(deliveryId);
  const isUnknownDelivery = isAxiosError(error) && error.response?.status === 404;

  // A link to a delivery that has expired (TTL) or never existed closes rather than showing an empty dialog.
  useEffect(() => {
    if (isUnknownDelivery) onClose();
  }, [isUnknownDelivery, onClose]);

  let body: ReactNode;
  if (isLoading) body = <LoadingState label="Loading delivery" />;
  else if (log) body = <DeliveryDetails log={log} />;
  else if (error) body = <ErrorState message="This delivery failed to load." onRetry={() => void refetch()} />;
  else
    body = (
      <EmptyState
        title="Delivery not found"
        action={
          <Button variant="outlined" color="neutral" onClick={onClose} data-testid="webhook-details-empty-close-btn">
            Close
          </Button>
        }
      />
    );

  return (
    <AdminDialog
      open={!!deliveryId}
      onClose={onClose}
      title="Webhook delivery"
      width={640}
      data-testid="webhook-details-dialog"
    >
      {body}
    </AdminDialog>
  );
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message: unknown }).message);
  return 'An unexpected error occurred';
};

const WebhookAuditLogsTab: React.FC = () => {
  const { view, updateView, repoInput, setRepoInput, deliveryId, openDelivery, closeDelivery } =
    useWebhookAuditLogsSearch();
  const {
    datePreset,
    repository: repoSearch,
    event: eventFilter,
    status: statusFilter,
    sourceType: sourceTypeFilter,
  } = view;

  const filters: WebhookAuditFiltersParams = useMemo(() => {
    const dateRange = getDateRangePreset(datePreset);
    return {
      ...dateRange,
      repository: repoSearch || undefined,
      event: eventFilter || undefined,
      status: statusFilter || undefined,
      sourceType: sourceTypeFilter || undefined,
      limit: 50,
    };
  }, [datePreset, repoSearch, eventFilter, statusFilter, sourceTypeFilter]);

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
    error: logsError,
    isError: isLogsError,
    isPlaceholderData,
  } = useWebhookAuditLogs(filters);

  // getDateRangePreset stamps a fresh Date() on each call, so an unmemoized range refetches forever.
  const statsDateRange = useMemo(() => getDateRangePreset(datePreset), [datePreset]);
  // The table's filters without its pagination params.
  const statsFilters = useMemo(
    () => ({
      repository: repoSearch || undefined,
      event: eventFilter || undefined,
      status: statusFilter || undefined,
      sourceType: sourceTypeFilter || undefined,
    }),
    [repoSearch, eventFilter, statusFilter, sourceTypeFilter]
  );
  const {
    data: stats,
    isLoading: statsLoading,
    isPlaceholderData: isStatsPlaceholder,
    error: statsError,
    isError: isStatsError,
    refetch: refetchStats,
  } = useWebhookAuditStats(statsDateRange, statsFilters);

  const logs = useMemo(() => data?.pages.flatMap(page => page.logs) || [], [data]);
  const openRowId = deliveryId ? logs.find(log => log.deliveryId === deliveryId)?.id : undefined;

  const hasFilters = Boolean(repoSearch || eventFilter || statusFilter || sourceTypeFilter);
  const clearFilters = () => updateView({ repository: '', event: null, status: null, sourceType: null });
  const refresh = () => void refetch();
  const rangeLabel = WEBHOOK_DATE_PRESET_LABELS[datePreset];

  const statValue = (value: string) =>
    statsLoading || isStatsPlaceholder ? (
      <Skeleton variant="text" sx={{ width: '3rem' }} data-testid="webhook-logs-stat-skeleton" />
    ) : (
      value
    );
  const successRate = stats?.successRate;

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="webhook-audit-logs-tab">
      <AdminPageHeader
        title="Webhook audit logs"
        description="GitHub webhook deliveries to per-user and organization webhooks, and how each was processed."
        actions={
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<RefreshIcon />}
            loading={isFetching && !isFetchingNextPage}
            onClick={refresh}
            data-testid="webhook-logs-refresh-btn"
          >
            Refresh
          </Button>
        }
      />

      {isStatsError ? (
        <ErrorState
          message={`Statistics failed to load: ${getErrorMessage(statsError)}`}
          onRetry={() => void refetchStats()}
        />
      ) : (
        <StatStrip aria-label="Webhook delivery totals">
          <StatTile
            label="Total deliveries"
            value={statValue((stats?.totalDeliveries || 0).toLocaleString())}
            comparison={rangeLabel}
          />
          <StatTile
            label="Success rate"
            value={statValue(successRate !== null && successRate !== undefined ? `${successRate.toFixed(1)}%` : 'N/A')}
            help={
              successRate === null ? (
                <FieldTooltip
                  content="Success rate not available when filtering by status"
                  ariaLabel="Help: Success rate"
                />
              ) : undefined
            }
          />
          <StatTile
            label="Avg duration"
            value={statValue(`${Math.round(stats?.avgProcessingDurationMs || 0)}ms`)}
            comparison={`P95: ${Math.round(stats?.p95ProcessingDurationMs || 0)}ms`}
          />
          <StatTile label="Failures" value={statValue((stats?.failureCount || 0).toLocaleString())} />
        </StatStrip>
      )}

      <Stack
        direction="row"
        flexWrap="wrap"
        alignItems="center"
        gap={1}
        sx={adminFocusScope}
        data-testid="webhook-logs-filter-row"
      >
        <AdminSearchInput
          value={repoInput}
          onChange={setRepoInput}
          label="Search repository"
          data-testid="webhook-logs-repository-input"
        />
        <SegmentedControl
          options={RANGE_SEGMENTS}
          value={datePreset}
          onChange={preset => updateView({ datePreset: preset })}
          aria-label="Date range"
          data-testid="webhook-logs-range"
        />
        <FilterChip
          id="webhook-source"
          label="Source"
          value={sourceTypeFilter ?? undefined}
          options={SOURCE_OPTIONS}
          onChange={value => updateView({ sourceType: WEBHOOK_SOURCE_TYPES.find(type => type === value) ?? null })}
        />
        <FilterChip
          id="webhook-event"
          label="Event"
          value={eventFilter ?? undefined}
          options={EVENT_OPTIONS}
          onChange={value => updateView({ event: WEBHOOK_EVENT_OPTIONS.find(event => event === value) ?? null })}
        />
        <FilterChip
          id="webhook-status"
          label="Status"
          value={statusFilter ?? undefined}
          options={STATUS_OPTIONS}
          onChange={value => updateView({ status: WEBHOOK_STATUSES.find(status => status === value) ?? null })}
        />
        {hasFilters && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={clearFilters}
            data-testid="webhook-logs-clear-filters-btn"
          >
            Clear filters
          </Button>
        )}
      </Stack>

      <Stack gap={1} sx={{ minWidth: 0 }}>
        <UpdatingBar active={isFetching && !isLoading && !isFetchingNextPage} testId="webhook-logs-updating" />
        <DataTable
          rows={logs}
          columns={LOG_COLUMNS}
          getRowId={log => log.id}
          label="Webhook deliveries"
          loading={isLoading}
          error={isLogsError ? `Webhook logs failed to load: ${getErrorMessage(logsError)}` : undefined}
          onRetry={refresh}
          empty={
            hasFilters ? (
              <EmptyState
                title="No deliveries match these filters"
                action={
                  <Button
                    variant="outlined"
                    color="neutral"
                    onClick={clearFilters}
                    data-testid="webhook-logs-empty-clear-btn"
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No webhook deliveries"
                description={`None arrived in the ${rangeLabel.toLowerCase()}.`}
                action={
                  <Button
                    variant="outlined"
                    color="neutral"
                    onClick={refresh}
                    data-testid="webhook-logs-empty-refresh-btn"
                  >
                    Refresh
                  </Button>
                }
              />
            )
          }
          onRowActivate={log => openDelivery(log.deliveryId)}
          activeRowId={openRowId}
          rowTestId={log => `webhook-logs-row-${log.deliveryId}`}
          testId="webhook-logs-table"
          // The server pages by cursor with no total, so the list grows through Load more below.
          pagination={false}
          // The page scrolls instead of the frame, so Load more follows the last row.
          maxHeight="none"
          // The fixed columns take 52.5rem, which leaves the repository 15.5rem.
          minWidth="68rem"
        />
        {/* Hidden while the previous filter's rows stand in: they are not the list Load more would page. */}
        {hasNextPage && !isPlaceholderData && (
          <Stack direction="row" justifyContent="center" sx={{ pt: 1 }}>
            <Button
              variant="outlined"
              color="neutral"
              onClick={() => fetchNextPage()}
              loading={isFetchingNextPage}
              data-testid="webhook-logs-load-more-btn"
            >
              Load more
            </Button>
          </Stack>
        )}
      </Stack>

      <DeliveryDetailsDialog deliveryId={deliveryId ?? null} onClose={closeDelivery} />
    </Stack>
  );
};

export default WebhookAuditLogsTab;
