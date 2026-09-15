import React, { useState, useMemo } from 'react';
import {
  Alert,
  Box,
  Card,
  Chip,
  CircularProgress,
  Drawer,
  FormControl,
  FormLabel,
  Grid,
  IconButton,
  Input,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Typography,
  Button,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import ScheduleIcon from '@mui/icons-material/Schedule';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import WarningIcon from '@mui/icons-material/Warning';
import BusinessIcon from '@mui/icons-material/Business';
import PersonIcon from '@mui/icons-material/Person';
import { FieldTooltip } from '@client/app/components/help';
import { WebhookAuditStatus, WebhookSourceType } from '@bike4mind/common';
import {
  useWebhookAuditLogs,
  useWebhookAuditLog,
  useWebhookAuditStats,
  getDateRangePreset,
  WebhookAuditFiltersParams,
} from '@client/app/hooks/data/webhookAuditLogs';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';

/**
 * Status badge component
 */
const StatusBadge: React.FC<{ status: WebhookAuditStatus }> = ({ status }) => {
  const config = {
    [WebhookAuditStatus.Received]: { color: 'primary' as const, icon: <ScheduleIcon fontSize="small" /> },
    [WebhookAuditStatus.Processing]: { color: 'warning' as const, icon: <HourglassEmptyIcon fontSize="small" /> },
    [WebhookAuditStatus.Completed]: { color: 'success' as const, icon: <CheckCircleIcon fontSize="small" /> },
    [WebhookAuditStatus.Failed]: { color: 'danger' as const, icon: <ErrorIcon fontSize="small" /> },
  };

  const { color, icon } = config[status] || config[WebhookAuditStatus.Received];

  return (
    <Chip size="sm" color={color} startDecorator={icon} variant="soft">
      {status}
    </Chip>
  );
};

/**
 * Source badge component - shows if webhook is org or user level
 */
const SourceBadge: React.FC<{ organizationId?: string; mcpServerId?: string }> = ({ organizationId, mcpServerId }) => {
  if (organizationId) {
    return (
      <Chip size="sm" color="primary" startDecorator={<BusinessIcon fontSize="small" />} variant="soft">
        Org
      </Chip>
    );
  }
  if (mcpServerId) {
    return (
      <Chip size="sm" color="neutral" startDecorator={<PersonIcon fontSize="small" />} variant="soft">
        User
      </Chip>
    );
  }
  return (
    <Chip size="sm" color="neutral" variant="soft">
      -
    </Chip>
  );
};

/**
 * Stats card component
 */
const StatsCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  color?: 'success' | 'warning' | 'danger' | 'neutral';
  tooltip?: string;
}> = ({ title, value, subtitle, color = 'neutral', tooltip }) => {
  const colorMap = {
    success: 'success.500',
    warning: 'warning.500',
    danger: 'danger.500',
    neutral: 'text.primary',
  };

  return (
    <Card variant="outlined" sx={{ p: { xs: 1, sm: 2 }, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography level="body-sm" textColor="text.tertiary">
          {title}
        </Typography>
        {tooltip && <FieldTooltip content={tooltip} ariaLabel={`Help: ${title}`} />}
      </Stack>
      <Typography level="h3" sx={{ color: colorMap[color] }}>
        {value}
      </Typography>
      {/* Reserve space for subtitle to keep cards same height */}
      <Typography level="body-xs" textColor="text.tertiary" sx={{ minHeight: '1.25em' }}>
        {subtitle || '\u00A0'}
      </Typography>
    </Card>
  );
};

/**
 * Detail drawer component
 */
const DetailDrawer: React.FC<{
  deliveryId: string | null;
  onClose: () => void;
}> = ({ deliveryId, onClose }) => {
  const { data: log, isLoading } = useWebhookAuditLog(deliveryId);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <Drawer anchor="right" open={!!deliveryId} onClose={onClose} size="lg">
      <Sheet sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
          <Typography level="h4">Webhook Details</Typography>
          <IconButton onClick={onClose} size="sm">
            <CloseIcon />
          </IconButton>
        </Stack>

        {isLoading ? (
          <Box display="flex" justifyContent="center" py={4}>
            <CircularProgress />
          </Box>
        ) : log ? (
          <Stack spacing={3}>
            {/* Status & Timing */}
            <Card variant="outlined">
              <Typography level="title-sm" mb={1}>
                Status
              </Typography>
              <Stack direction="row" spacing={2} alignItems="center">
                <StatusBadge status={log.status} />
                {log.signatureVerified && (
                  <Chip size="sm" color="success" variant="soft">
                    Signature Verified
                  </Chip>
                )}
              </Stack>
              {log.processingDurationMs && (
                <Typography level="body-sm" mt={1}>
                  Processing time: {log.processingDurationMs}ms
                </Typography>
              )}
            </Card>

            {/* Identity */}
            <Card variant="outlined">
              <Typography level="title-sm" mb={1}>
                Identity
              </Typography>
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography level="body-sm" textColor="text.tertiary">
                    Source
                  </Typography>
                  <SourceBadge organizationId={log.organizationId} mcpServerId={log.mcpServerId} />
                </Stack>
                {log.organizationId && (
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography level="body-sm" textColor="text.tertiary">
                      Organization ID
                    </Typography>
                    <Typography level="body-sm" fontFamily="monospace">
                      {log.organizationId}
                    </Typography>
                  </Stack>
                )}
                {log.mcpServerId && (
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography level="body-sm" textColor="text.tertiary">
                      MCP Server ID
                    </Typography>
                    <Typography level="body-sm" fontFamily="monospace">
                      {log.mcpServerId}
                    </Typography>
                  </Stack>
                )}
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography level="body-sm" textColor="text.tertiary">
                    Delivery ID
                  </Typography>
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Typography level="body-sm" fontFamily="monospace">
                      {log.deliveryId}
                    </Typography>
                    <IconButton size="sm" onClick={() => handleCopy(log.deliveryId)}>
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography level="body-sm" textColor="text.tertiary">
                    Correlation ID
                  </Typography>
                  <Typography level="body-sm" fontFamily="monospace">
                    {log.correlationId}
                  </Typography>
                </Stack>
              </Stack>
            </Card>

            {/* Event Details */}
            <Card variant="outlined">
              <Typography level="title-sm" mb={1}>
                Event
              </Typography>
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography level="body-sm" textColor="text.tertiary">
                    Type
                  </Typography>
                  <Chip size="sm" variant="outlined">
                    {log.event}
                  </Chip>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography level="body-sm" textColor="text.tertiary">
                    Repository
                  </Typography>
                  <Typography level="body-sm">{log.repository}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography level="body-sm" textColor="text.tertiary">
                    Sender
                  </Typography>
                  <Typography level="body-sm">{log.sender}</Typography>
                </Stack>
              </Stack>
            </Card>

            {/* Metadata */}
            {log.metadata && Object.keys(log.metadata).length > 0 && (
              <Card variant="outlined">
                <Typography level="title-sm" mb={1}>
                  Metadata
                </Typography>
                <Stack spacing={1}>
                  {log.metadata.prNumber && (
                    <Stack direction="row" justifyContent="space-between">
                      <Typography level="body-sm" textColor="text.tertiary">
                        PR Number
                      </Typography>
                      <Typography level="body-sm">#{log.metadata.prNumber}</Typography>
                    </Stack>
                  )}
                  {log.metadata.issueNumber && (
                    <Stack direction="row" justifyContent="space-between">
                      <Typography level="body-sm" textColor="text.tertiary">
                        Issue Number
                      </Typography>
                      <Typography level="body-sm">#{log.metadata.issueNumber}</Typography>
                    </Stack>
                  )}
                  {log.metadata.action && (
                    <Stack direction="row" justifyContent="space-between">
                      <Typography level="body-sm" textColor="text.tertiary">
                        Action
                      </Typography>
                      <Typography level="body-sm">{log.metadata.action}</Typography>
                    </Stack>
                  )}
                  {log.metadata.branch && (
                    <Stack direction="row" justifyContent="space-between">
                      <Typography level="body-sm" textColor="text.tertiary">
                        Branch
                      </Typography>
                      <Typography level="body-sm">{log.metadata.branch}</Typography>
                    </Stack>
                  )}
                </Stack>
              </Card>
            )}

            {/* Actions */}
            {log.actions && log.actions.length > 0 && (
              <Card variant="outlined">
                <Typography level="title-sm" mb={1}>
                  Actions
                </Typography>
                <Stack spacing={1}>
                  {log.actions.map((action, idx) => (
                    <Stack key={idx} direction="row" justifyContent="space-between" alignItems="center">
                      <Typography level="body-sm">{action.type}</Typography>
                      <Stack direction="row" spacing={1} alignItems="center">
                        {action.durationMs && (
                          <Typography level="body-xs" textColor="text.tertiary">
                            {action.durationMs}ms
                          </Typography>
                        )}
                        <Chip size="sm" color={action.status === 'success' ? 'success' : 'danger'} variant="soft">
                          {action.status}
                        </Chip>
                      </Stack>
                    </Stack>
                  ))}
                </Stack>
              </Card>
            )}

            {/* Error Details */}
            {log.error && (
              <Card variant="outlined" color="danger">
                <Typography level="title-sm" mb={1} color="danger">
                  Error
                </Typography>
                <Typography level="body-sm" fontFamily="monospace" sx={{ whiteSpace: 'pre-wrap' }}>
                  {log.error.message}
                </Typography>
                {log.error.code && (
                  <Typography level="body-xs" textColor="text.tertiary" mt={1}>
                    Code: {log.error.code}
                  </Typography>
                )}
              </Card>
            )}

            {/* Timestamps */}
            <Card variant="outlined">
              <Typography level="title-sm" mb={1}>
                Timeline
              </Typography>
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography level="body-sm" textColor="text.tertiary">
                    Received
                  </Typography>
                  <Typography level="body-sm">{new Date(log.receivedAt).toLocaleString()}</Typography>
                </Stack>
                {log.processedAt && (
                  <Stack direction="row" justifyContent="space-between">
                    <Typography level="body-sm" textColor="text.tertiary">
                      Processed
                    </Typography>
                    <Typography level="body-sm">{new Date(log.processedAt).toLocaleString()}</Typography>
                  </Stack>
                )}
              </Stack>
            </Card>
          </Stack>
        ) : (
          <Typography>No data found</Typography>
        )}
      </Sheet>
    </Drawer>
  );
};

/**
 * Main Webhook Audit Logs Tab component
 */
const WebhookAuditLogsTab: React.FC = () => {
  const isMobile = useIsMobile();
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [datePreset, setDatePreset] = useState<'24h' | '7d' | '30d' | '90d'>('7d');
  const [repoSearch, setRepoSearch] = useState('');
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<WebhookAuditStatus | null>(null);
  const [sourceTypeFilter, setSourceTypeFilter] = useState<WebhookSourceType | null>(null);

  // Build filters
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

  // Fetch data
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
  } = useWebhookAuditLogs(filters);

  // Memoize date range to prevent infinite refetch loop
  // (getDateRangePreset creates new object with fresh Date() on each call)
  const statsDateRange = useMemo(() => getDateRangePreset(datePreset), [datePreset]);
  // Memoize stats filters to match the table filters (excluding pagination params)
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
    error: statsError,
    isError: isStatsError,
  } = useWebhookAuditStats(statsDateRange, statsFilters);

  // Flatten pages
  const logs = useMemo(() => {
    return data?.pages.flatMap(page => page.logs) || [];
  }, [data]);

  // Get success rate color (returns 'neutral' when rate is null/N/A)
  const getSuccessRateColor = (rate: number | null): 'success' | 'warning' | 'danger' | 'neutral' => {
    if (rate === null) return 'neutral';
    if (rate >= 95) return 'success';
    if (rate >= 90) return 'warning';
    return 'danger';
  };

  // Helper to get error message
  const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error && 'message' in error)
      return String((error as { message: unknown }).message);
    return 'An unexpected error occurred';
  };

  return (
    <Box data-testid="webhook-audit-logs-tab" sx={{ p: { xs: 1.5, sm: 3 } }}>
      {/* Page Header */}
      <Box mb={{ xs: 1.5, sm: 3 }}>
        <Typography level="h2">GitHub Webhook Logs</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Audit trail for GitHub webhook deliveries (per-user and organization webhooks)
        </Typography>
      </Box>

      {/* Error Alerts */}
      {isStatsError && (
        <Alert color="danger" startDecorator={<WarningIcon />} sx={{ mb: 2 }} data-testid="webhook-logs-stats-error">
          Failed to load statistics: {getErrorMessage(statsError)}
        </Alert>
      )}
      {isLogsError && (
        <Alert color="danger" startDecorator={<WarningIcon />} sx={{ mb: 2 }} data-testid="webhook-logs-error">
          Failed to load webhook logs: {getErrorMessage(logsError)}
        </Alert>
      )}

      {/* Stats Cards */}
      <Grid container spacing={{ xs: 1, sm: 2 }} mb={{ xs: 1.5, sm: 3 }}>
        <Grid xs={6} md={3}>
          <StatsCard
            title="Total Deliveries"
            value={statsLoading ? '...' : (stats?.totalDeliveries || 0).toLocaleString()}
            subtitle={`Last ${datePreset}`}
          />
        </Grid>
        <Grid xs={6} md={3}>
          <StatsCard
            title="Success Rate"
            value={
              statsLoading
                ? '...'
                : stats?.successRate !== null && stats?.successRate !== undefined
                  ? `${stats.successRate.toFixed(1)}%`
                  : 'N/A'
            }
            color={stats ? getSuccessRateColor(stats.successRate) : 'neutral'}
            tooltip={stats?.successRate === null ? 'Success rate not available when filtering by status' : undefined}
          />
        </Grid>
        <Grid xs={6} md={3}>
          <StatsCard
            title="Avg Duration"
            value={statsLoading ? '...' : `${Math.round(stats?.avgProcessingDurationMs || 0)}ms`}
            subtitle={`P95: ${Math.round(stats?.p95ProcessingDurationMs || 0)}ms`}
          />
        </Grid>
        <Grid xs={6} md={3}>
          <StatsCard
            title="Failures"
            value={statsLoading ? '...' : (stats?.failureCount || 0).toLocaleString()}
            color={stats && stats.failureCount > 0 ? 'danger' : 'neutral'}
          />
        </Grid>
      </Grid>

      {/* Filters */}
      <Card variant="outlined" sx={{ mb: { xs: 1, sm: 2 }, p: { xs: 1, sm: 2 } }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1, sm: 2 }}
          alignItems={{ sm: 'flex-end' }}
          flexWrap="wrap"
        >
          {/* Row 1 on mobile: Date Range + Source side-by-side */}
          <Stack direction="row" spacing={1} sx={{ width: { xs: '100%', sm: 'auto' } }} alignItems="flex-end">
            <FormControl size="sm" sx={{ flex: { xs: 1, sm: 'none' }, minWidth: { sm: 120 } }}>
              <FormLabel>Date Range</FormLabel>
              <Select
                value={datePreset}
                onChange={(_, value) => value && setDatePreset(value as typeof datePreset)}
                data-testid="webhook-logs-date-range-select"
              >
                <Option value="24h">Last 24 hours</Option>
                <Option value="7d">Last 7 days</Option>
                <Option value="30d">Last 30 days</Option>
                <Option value="90d">Last 90 days</Option>
              </Select>
            </FormControl>

            <FormControl size="sm" sx={{ flex: { xs: 1, sm: 'none' }, minWidth: { sm: 120 } }}>
              <FormLabel>Source</FormLabel>
              <Select
                value={sourceTypeFilter}
                onChange={(_, value) => setSourceTypeFilter(value)}
                placeholder="All sources"
                data-testid="webhook-logs-source-select"
              >
                <Option value={null}>All sources</Option>
                <Option value="org">Org</Option>
                <Option value="user">User</Option>
              </Select>
            </FormControl>
          </Stack>

          {/* Row 2 on mobile: Repository full width */}
          <FormControl size="sm" sx={{ flex: { sm: 1 }, width: '100%' }}>
            <FormLabel>Repository</FormLabel>
            <Input
              placeholder="Search repository..."
              value={repoSearch}
              onChange={e => setRepoSearch(e.target.value)}
              startDecorator={<SearchIcon />}
              data-testid="webhook-logs-repository-input"
            />
          </FormControl>

          {/* Row 3 on mobile: Event Type + Status side-by-side + Refresh */}
          <Stack direction="row" spacing={1} sx={{ width: { xs: '100%', sm: 'auto' } }} alignItems="flex-end">
            <FormControl size="sm" sx={{ flex: { xs: 1, sm: 'none' }, minWidth: { sm: 180 } }}>
              <FormLabel>Event Type</FormLabel>
              <Select
                value={eventFilter}
                onChange={(_, value) => setEventFilter(value)}
                placeholder="All events"
                data-testid="webhook-logs-event-type-select"
              >
                <Option value={null}>All events</Option>
                <Option value="ping">ping</Option>
                <Option value="push">push</Option>
                <Option value="pull_request">pull_request</Option>
                <Option value="pull_request_review">pull_request_review</Option>
                <Option value="pull_request_review_comment">pull_request_review_comment</Option>
                <Option value="issues">issues</Option>
                <Option value="issue_comment">issue_comment</Option>
                <Option value="workflow_run">workflow_run</Option>
                <Option value="check_run">check_run</Option>
                <Option value="check_suite">check_suite</Option>
              </Select>
            </FormControl>

            <FormControl size="sm" sx={{ flex: { xs: 1, sm: 'none' }, minWidth: { sm: 150 } }}>
              <FormLabel>Status</FormLabel>
              <Select
                value={statusFilter}
                onChange={(_, value) => setStatusFilter(value)}
                placeholder="All statuses"
                data-testid="webhook-logs-status-select"
              >
                <Option value={null}>All statuses</Option>
                <Option value={WebhookAuditStatus.Completed}>Completed</Option>
                <Option value={WebhookAuditStatus.Failed}>Failed</Option>
                <Option value={WebhookAuditStatus.Processing}>Processing</Option>
                <Option value={WebhookAuditStatus.Received}>Received</Option>
              </Select>
            </FormControl>

            <IconButton
              size="sm"
              variant="outlined"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="webhook-logs-refresh-btn"
              sx={{ flexShrink: 0 }}
            >
              {isFetching ? <CircularProgress size="sm" /> : <RefreshIcon />}
            </IconButton>
          </Stack>
        </Stack>
      </Card>

      {/* Active Filter Chips */}
      {(repoSearch || eventFilter || statusFilter || sourceTypeFilter) && (
        <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography level="body-sm" textColor="text.tertiary">
            Showing filtered results:
          </Typography>
          {repoSearch && (
            <Chip
              size="sm"
              variant="soft"
              color="primary"
              endDecorator={<CloseIcon fontSize="small" />}
              onClick={() => setRepoSearch('')}
            >
              Repo: {repoSearch}
            </Chip>
          )}
          {eventFilter && (
            <Chip
              size="sm"
              variant="soft"
              color="primary"
              endDecorator={<CloseIcon fontSize="small" />}
              onClick={() => setEventFilter(null)}
            >
              Event: {eventFilter}
            </Chip>
          )}
          {statusFilter && (
            <Chip
              size="sm"
              variant="soft"
              color="primary"
              endDecorator={<CloseIcon fontSize="small" />}
              onClick={() => setStatusFilter(null)}
            >
              Status: {statusFilter}
            </Chip>
          )}
          {sourceTypeFilter && (
            <Chip
              size="sm"
              variant="soft"
              color="primary"
              endDecorator={<CloseIcon fontSize="small" />}
              onClick={() => setSourceTypeFilter(null)}
            >
              Source: {sourceTypeFilter === 'org' ? 'Org' : 'User'}
            </Chip>
          )}
          {[repoSearch, eventFilter, statusFilter, sourceTypeFilter].filter(Boolean).length > 1 && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => {
                setRepoSearch('');
                setEventFilter(null);
                setStatusFilter(null);
                setSourceTypeFilter(null);
              }}
            >
              Clear all
            </Button>
          )}
        </Box>
      )}

      {/* Table / Card List */}
      {isLoading ? (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress />
        </Box>
      ) : logs.length === 0 ? (
        <Typography level="body-sm" textAlign="center" py={4}>
          No webhook deliveries found
        </Typography>
      ) : isMobile ? (
        <Stack spacing={1} data-testid="webhook-logs-table">
          {logs.map(log => (
            <Card
              key={log.id}
              variant="outlined"
              sx={{ p: 1.5, cursor: 'pointer' }}
              onClick={() => setSelectedDeliveryId(log.deliveryId)}
            >
              <Stack spacing={0.75}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography level="body-sm">{relativeTimeFormat(new Date(log.receivedAt))}</Typography>
                  <StatusBadge status={log.status} />
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <SourceBadge organizationId={log.organizationId} mcpServerId={log.mcpServerId} />
                  <Chip size="sm" variant="outlined">
                    {log.event}
                  </Chip>
                  {log.sender && (
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      {log.sender}
                    </Typography>
                  )}
                </Stack>
                {log.repository && (
                  <Typography level="body-xs" sx={{ wordBreak: 'break-word' }}>
                    {log.repository}
                  </Typography>
                )}
                {log.processingDurationMs && (
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    {log.processingDurationMs}ms
                  </Typography>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
      ) : (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table stickyHeader hoverRow data-testid="webhook-logs-table">
            <thead>
              <tr>
                <th style={{ width: 180 }}>Time</th>
                <th style={{ width: 80 }}>Source</th>
                <th style={{ width: 120 }}>Event</th>
                <th>Repository</th>
                <th style={{ width: 120 }}>Status</th>
                <th style={{ width: 100 }}>Duration</th>
                <th style={{ width: 100 }}>Sender</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} onClick={() => setSelectedDeliveryId(log.deliveryId)} style={{ cursor: 'pointer' }}>
                  <td>
                    <Typography level="body-sm">{relativeTimeFormat(new Date(log.receivedAt))}</Typography>
                  </td>
                  <td>
                    <SourceBadge organizationId={log.organizationId} mcpServerId={log.mcpServerId} />
                  </td>
                  <td>
                    <Chip size="sm" variant="outlined">
                      {log.event}
                    </Chip>
                  </td>
                  <td>
                    <Typography level="body-sm" noWrap sx={{ maxWidth: 250 }}>
                      {log.repository}
                    </Typography>
                  </td>
                  <td>
                    <StatusBadge status={log.status} />
                  </td>
                  <td>
                    <Typography level="body-sm">
                      {log.processingDurationMs ? `${log.processingDurationMs}ms` : '-'}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-sm" noWrap sx={{ maxWidth: 100 }}>
                      {log.sender}
                    </Typography>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Sheet>
      )}

      {/* Load More */}
      {hasNextPage && (
        <Box display="flex" justifyContent="center" mt={2}>
          <Button
            variant="outlined"
            onClick={() => fetchNextPage()}
            loading={isFetchingNextPage}
            data-testid="webhook-logs-load-more-btn"
          >
            Load More
          </Button>
        </Box>
      )}

      {/* Detail Drawer */}
      <DetailDrawer deliveryId={selectedDeliveryId} onClose={() => setSelectedDeliveryId(null)} />
    </Box>
  );
};

export default WebhookAuditLogsTab;
