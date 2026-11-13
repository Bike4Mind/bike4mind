import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Input, Stack, Tooltip, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { toast } from 'sonner';
import {
  useCleanupAgentExecutions,
  useStuckAgentExecutions,
  type StuckExecutionItem,
} from '@client/app/hooks/data/stuckAgentExecutions';
import { AdminPermissionAction } from './shared/MissingPermission';
import { ACTIVE_AGENT_EXECUTION_STATUSES, type AgentExecutionStatus } from '@client/app/stores/useAgentExecutionStore';
import {
  ActionDialog,
  AdminPageHeader,
  AdminSearchInput,
  BulkActionBar,
  DataTable,
  EmptyState,
  FilterChip,
  StatusChip,
  UpdatingBar,
  type AdminSelection,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP, adminFocusScope } from './shared/adminStyles';

// Both `awaiting_subagent` and `awaiting_dag_children` are excluded: healthy
// parents in either state idle while children work, so they're not sweep-eligible.
const STATUS_OPTIONS: AgentExecutionStatus[] = ACTIVE_AGENT_EXECUTION_STATUSES.filter(
  s => s !== 'awaiting_subagent' && s !== 'awaiting_dag_children'
);

const formatAge = (updatedAt: string): string => {
  const ms = Date.now() - new Date(updatedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
};

const truncate = (s: string, max = 80): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

const formatConfidenceTooltip = (t: NonNullable<StuckExecutionItem['confidenceTelemetry']>): string =>
  `${t.evaluatedCount} evaluated · ${t.emittedCount} gated · avg ${t.avgConfidence.toFixed(2)} · min ${t.minConfidence.toFixed(2)}`;

const USER_ID_DEBOUNCE_MS = 300;

/** Rows this page requests (the route allows up to 500); reaching it means more may match. */
const ROW_LIMIT = 200;
const NO_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };

const AgentExecutionsTab: React.FC = () => {
  const [minutes, setMinutes] = useState(20);
  const [status, setStatus] = useState<AgentExecutionStatus | ''>('');
  const [userId, setUserId] = useState('');
  // Debounced mirror of `userId` so each keystroke doesn't fire a request.
  // A 24-char ObjectId would otherwise trigger 24 fetches.
  const [debouncedUserId, setDebouncedUserId] = useState('');
  const [selection, setSelection] = useState<AdminSelection>(NO_SELECTION);
  const [releaseOpen, setReleaseOpen] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedUserId(userId.trim()), USER_ID_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [userId]);

  const queryParams = useMemo(
    () => ({
      minutes,
      ...(status ? { status } : {}),
      ...(debouncedUserId ? { userId: debouncedUserId } : {}),
      limit: ROW_LIMIT,
    }),
    [minutes, status, debouncedUserId]
  );

  // A selection made under other filters would release rows the admin can no longer see.
  const filterKey = JSON.stringify(queryParams);
  const [selectionFilterKey, setSelectionFilterKey] = useState(filterKey);
  if (selectionFilterKey !== filterKey) {
    setSelectionFilterKey(filterKey);
    setSelection(NO_SELECTION);
  }

  const { data, isPending, isError, error, refetch, isFetching, isPlaceholderData } =
    useStuckAgentExecutions(queryParams);
  const cleanup = useCleanupAgentExecutions();

  // A previous filter's placeholder rows must never be selectable for a destructive action.
  const items: StuckExecutionItem[] = isPlaceholderData ? [] : (data?.items ?? []);
  // Only rows still listed: the 30 s poll drops an execution that updated again, and releasing it
  // would end a run that is alive.
  const selectedIds =
    selection.mode === 'allMatching'
      ? items.map(it => it.id)
      : items.filter(it => selection.ids.includes(it.id)).map(it => it.id);
  const liveSelection: AdminSelection =
    selection.mode === 'allMatching' ? selection : { mode: 'explicit', ids: selectedIds };
  const errorMessage = `Failed to load stuck executions${error instanceof Error ? `: ${error.message}` : ''}`;

  const handleCleanup = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      const result = await cleanup.mutateAsync(ids);
      const skipped = result.requested - result.marked;
      if (skipped > 0) {
        toast.warning(
          `Marked ${result.marked}/${result.requested} abandoned — ${skipped} reached a terminal state during the request (${result.notifiedConnections} live connections notified)`
        );
      } else {
        toast.success(`Marked ${result.marked} abandoned (${result.notifiedConnections} live connections notified)`);
      }
      setSelection(NO_SELECTION);
      setReleaseOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Cleanup failed: ${message}`);
    }
  };

  // The dry run in the confirm dialog: how many of each status the release would end.
  const selectedStatusCounts = new Map<string, number>();
  for (const item of items) {
    if (selectedIds.includes(item.id))
      selectedStatusCounts.set(item.status, (selectedStatusCounts.get(item.status) ?? 0) + 1);
  }
  const selectedStatuses = [...selectedStatusCounts.entries()].map(([name, count]) => `${count} ${name}`).join(', ');

  const columns: DataColumn<StuckExecutionItem>[] = [
    {
      id: 'status',
      label: 'Status',
      width: '10rem',
      render: item => <StatusChip tone="warn" label={item.status} data-testid={`stuck-execution-status-${item.id}`} />,
    },
    { id: 'age', label: 'Age', width: '6rem', render: item => formatAge(item.updatedAt) },
    {
      id: 'user',
      label: 'User',
      width: '8rem',
      render: item => (
        <Tooltip title={item.userId} placement="top">
          <Typography level="body-xs" noWrap sx={{ fontFamily: 'monospace' }}>
            {`${item.userId.slice(0, 8)}\u2026`}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'query',
      label: 'Query',
      render: item => (
        <Tooltip title={item.query} placement="top">
          <Typography level="body-sm" noWrap>
            {truncate(item.query, 100)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'model',
      label: 'Model',
      width: '10rem',
      render: item => (
        <Typography level="body-xs" noWrap title={item.model}>
          {item.model}
        </Typography>
      ),
    },
    {
      id: 'credits',
      label: 'Credits',
      width: '6rem',
      numeric: true,
      render: item => item.totalCreditsUsed.toFixed(2),
    },
    {
      id: 'confidence',
      label: 'Confidence (avg / min)',
      width: '12rem',
      render: item => (
        <Box data-testid={`stuck-execution-confidence-${item.id}`}>
          {item.confidenceTelemetry ? (
            <Tooltip title={formatConfidenceTooltip(item.confidenceTelemetry)} placement="top">
              <Stack direction="row" gap={0.5} alignItems="center">
                <Typography level="body-xs" noWrap>
                  {item.confidenceTelemetry.avgConfidence.toFixed(2)} /{' '}
                  {item.confidenceTelemetry.minConfidence.toFixed(2)}
                </Typography>
                {item.confidenceTelemetry.emittedCount > 0 && (
                  <StatusChip tone="warn" label={`${item.confidenceTelemetry.emittedCount} gated`} />
                )}
              </Stack>
            </Tooltip>
          ) : (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              -
            </Typography>
          )}
        </Box>
      ),
    },
  ];

  const refreshButton = (testId: string, label: string) => (
    <Button
      size="sm"
      variant="outlined"
      startDecorator={<RefreshIcon />}
      onClick={() => void refetch()}
      disabled={isFetching}
      data-testid={testId}
    >
      {label}
    </Button>
  );

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="stuck-agent-executions-tab">
      <AdminPageHeader
        title="Stuck executions"
        description={
          <>
            Executions still active past the threshold, usually for users who never came back. Parents in{' '}
            <Typography component="code" sx={{ fontFamily: 'monospace' }}>
              awaiting_subagent
            </Typography>{' '}
            are excluded: they can idle for hours while their children work.
          </>
        }
        actions={refreshButton('stuck-agent-executions-refresh-btn', 'Refresh')}
      />

      {isError && data && (
        <Alert color="warning" variant="soft" data-testid="stuck-agent-executions-refresh-error">
          {`${errorMessage}. Showing the last loaded list.`}
        </Alert>
      )}

      <Stack
        direction="row"
        flexWrap="wrap"
        alignItems="center"
        gap={1}
        sx={adminFocusScope}
        data-testid="stuck-agent-executions-filters"
      >
        <AdminSearchInput
          value={userId}
          onChange={setUserId}
          label="Filter by user ID"
          data-testid="stuck-agent-executions-user-id"
        />
        <FilterChip
          id="status"
          label="Status"
          value={status || undefined}
          options={STATUS_OPTIONS.map(s => ({ value: s, label: s }))}
          onChange={value => setStatus((value as AgentExecutionStatus | undefined) ?? '')}
        />
        <Input
          size="sm"
          type="number"
          value={minutes}
          onChange={e => setMinutes(Math.max(1, Number(e.target.value) || 1))}
          startDecorator="Older than"
          endDecorator="min"
          slotProps={{
            input: {
              min: 1,
              max: 60 * 24 * 30,
              'aria-label': 'Older than (minutes)',
              'data-testid': 'stuck-agent-executions-minutes',
            },
          }}
          sx={{ width: '11rem', minHeight: 34 }}
        />
      </Stack>

      <Stack gap={1}>
        <UpdatingBar active={isFetching && !isPending} testId="stuck-agent-executions-updating" />
        <DataTable
          label="Stuck executions"
          testId="stuck-agent-executions-table"
          rows={items}
          columns={columns}
          getRowId={item => item.id}
          rowTestId={item => `stuck-execution-row-${item.id}`}
          selection={liveSelection}
          onSelectionChange={setSelection}
          pageResetKey={filterKey}
          loading={isPending || isPlaceholderData}
          error={isError && !data ? errorMessage : undefined}
          onRetry={() => void refetch()}
          // Fixed columns total 54.75rem with the checkbox; the query takes the rest and truncates.
          minWidth="68rem"
          empty={
            <Box data-testid="stuck-agent-executions-empty">
              <EmptyState
                title="No stuck executions"
                description="Nothing matches these filters right now."
                action={refreshButton('stuck-agent-executions-empty-refresh-btn', 'Refresh')}
              />
            </Box>
          }
        />
        {items.length === ROW_LIMIT && (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="stuck-agent-executions-limit-note">
            Showing the first {ROW_LIMIT} rows. Narrow the filters to see more.
          </Typography>
        )}
      </Stack>

      <BulkActionBar
        selection={liveSelection}
        totalMatching={items.length}
        onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
        onClear={() => setSelection(NO_SELECTION)}
      >
        <AdminPermissionAction requirement="settings:manage">
          {disabled => (
            <Button
              size="sm"
              variant="outlined"
              color="danger"
              disabled={disabled || cleanup.isPending}
              onClick={() => setReleaseOpen(true)}
              data-testid="stuck-agent-executions-cleanup-btn"
            >
              Mark abandoned
            </Button>
          )}
        </AdminPermissionAction>
      </BulkActionBar>

      <ActionDialog
        open={releaseOpen}
        onClose={() => setReleaseOpen(false)}
        title="Mark executions abandoned"
        description="Each selected execution moves to a terminal state now, its user's slot is freed and any live connection is told. An execution that finishes on its own first is skipped. This cannot be undone."
        // The cleanup route records an audit entry but takes no reason field yet.
        reasonPresets={[]}
        reasonAudited={false}
        confirmLabel={`Mark ${selectedIds.length.toLocaleString()} abandoned`}
        // The poll can drop every selected row while the dialog is open; say so instead of a silent no-op.
        blockedReason={
          isError
            ? 'The list could not be refreshed. Refresh it before releasing executions.'
            : selectedIds.length === 0
              ? 'The selected executions are no longer listed.'
              : null
        }
        tone="danger"
        pending={cleanup.isPending}
        onConfirm={() => handleCleanup()}
        data-testid="stuck-agent-executions-release-dialog"
      >
        <Typography level="body-sm" data-testid="stuck-agent-executions-release-summary">
          {`${selectedIds.length.toLocaleString()} selected${selectedStatuses ? `: ${selectedStatuses}` : ''}`}
        </Typography>
      </ActionDialog>
    </Stack>
  );
};

export default AgentExecutionsTab;
