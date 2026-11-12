import { useEffect, useMemo, useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import {
  useDlqHistory,
  type DlqHistoryFilters,
  type DlqQueueInfo,
  type DlqReplayLogEntry,
} from '@client/app/hooks/data/dlqManagement';
import { DataTable, EmptyState, FilterChip, StatusChip } from './shared';
import { AdminSearchInput } from './shared/FilterBar';
import type { DataColumn } from './shared/DataTable';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

const results: Record<DlqReplayLogEntry['status'], { tone: AdminStatusTone; label: string }> = {
  success: { tone: 'good', label: 'Success' },
  failed: { tone: 'bad', label: 'Failed' },
  skipped: { tone: 'warn', label: 'Skipped' },
  discarded: { tone: 'neutral', label: 'Discarded' },
  pending: { tone: 'warn', label: 'Discard outcome unconfirmed' },
};

const columns: DataColumn<DlqReplayLogEntry>[] = [
  {
    id: 'time',
    label: 'Time',
    render: entry => (
      <Typography level="body-sm" title={new Date(entry.createdAt).toUTCString()}>
        {new Date(entry.createdAt).toLocaleString()}
      </Typography>
    ),
  },
  {
    id: 'action',
    label: 'Action',
    render: entry =>
      entry.status === 'discarded'
        ? 'Discarded'
        : entry.operation === 'discard' || entry.status === 'pending'
          ? 'Discard requested'
          : entry.status === 'success'
            ? 'Replayed'
            : results[entry.status].label,
  },
  { id: 'feature', label: 'Feature', render: entry => entry.sourceQueue },
  {
    id: 'entity',
    label: 'Entity',
    render: entry => (
      <Typography
        level="body-xs"
        title={`History ID: ${entry.id}`}
        sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}
      >
        {entry.messageId}
      </Typography>
    ),
  },
  {
    id: 'reason',
    label: 'Reason',
    render: entry => (
      <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
        {entry.reason || 'No reason recorded'}
      </Typography>
    ),
  },
  {
    id: 'by',
    label: 'By',
    render: entry => (
      <Typography level="body-sm" data-testid={`dlq-history-by-${entry.id}`}>
        {entry.replayedByName || entry.replayedBy}
      </Typography>
    ),
  },
  {
    id: 'result',
    label: 'Result',
    render: entry => (
      <Stack gap={0.5}>
        <StatusChip
          tone={results[entry.status].tone}
          label={
            entry.operation === 'discard' && entry.status === 'failed'
              ? 'Discard request failed'
              : results[entry.status].label
          }
        />
        {entry.errorMessage && (
          <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
            {entry.errorMessage}
          </Typography>
        )}
      </Stack>
    ),
  },
];

export function DlqHistoryView({ queues }: { queues: DlqQueueInfo[] }) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [queueLabel, setQueueLabel] = useState<string>();
  const [status, setStatus] = useState<DlqReplayLogEntry['status']>();
  const [range, setRange] = useState<string>();
  const [rangeAnchor] = useState(() => Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const filters = useMemo(
    (): DlqHistoryFilters => ({
      queueLabel,
      status,
      search: debouncedSearch || undefined,
      startDate: range ? new Date(rangeAnchor - Number(range) * 86400000).toISOString() : undefined,
    }),
    [queueLabel, status, range, debouncedSearch, rangeAnchor]
  );
  const history = useDlqHistory(filters);
  const rows = history.data?.pages.flatMap(page => page.history) ?? [];
  const clearFilters = () => {
    setSearch('');
    setQueueLabel(undefined);
    setStatus(undefined);
    setRange(undefined);
  };
  return (
    <Stack gap={2} component="section" aria-label="Dead-letter history">
      <Typography level="body-sm">
        Replay and discard history is retained for 30 days. Entity identifies the dead-letter message.
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        <AdminSearchInput
          value={search}
          onChange={value => setSearch(value.slice(0, 200))}
          label="Search ID, entity or reason"
          data-testid="dlq-history-search"
        />
        <FilterChip
          id="dlq-history-queue"
          label="Feature"
          value={queueLabel}
          onChange={setQueueLabel}
          options={queues.map(queue => ({ value: queue.label, label: queue.displayName }))}
        />
        <FilterChip
          id="dlq-history-status"
          label="Result"
          value={status}
          onChange={value => setStatus(value as typeof status)}
          options={Object.entries(results).map(([value, result]) => ({ value, label: result.label }))}
        />
        <FilterChip
          id="dlq-history-date"
          label="Time"
          value={range}
          onChange={setRange}
          options={[
            { value: '1', label: 'Last 24 hours' },
            { value: '7', label: 'Last 7 days' },
            { value: '30', label: 'Last 30 days' },
          ]}
        />
        <Button variant="plain" onClick={clearFilters} data-testid="dlq-history-clear-filters">
          Clear filters
        </Button>
        <Button variant="outlined" onClick={() => void history.refetch()} data-testid="dlq-history-refresh">
          Refresh history
        </Button>
      </Stack>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={entry => entry.id}
        label="Dead-letter history"
        testId="dlq-history-table"
        rowTestId={entry => `dlq-history-row-${entry.id}`}
        loading={history.isLoading}
        error={history.isError && !history.isFetchNextPageError ? 'History failed to load.' : undefined}
        onRetry={() => void history.refetch()}
        pageResetKey={JSON.stringify(filters)}
        minWidth="70rem"
        empty={
          <EmptyState
            title="No history matches these filters"
            action={
              <Button variant="outlined" onClick={clearFilters} data-testid="dlq-history-empty-clear">
                Clear filters
              </Button>
            }
          />
        }
      />
      {history.isFetchNextPageError && (
        <Typography role="alert" level="body-sm">
          More history failed to load. Try loading more again.
        </Typography>
      )}
      {history.hasNextPage && (
        <Button
          variant="outlined"
          loading={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
          data-testid="dlq-history-load-more"
        >
          Load more history
        </Button>
      )}
    </Stack>
  );
}
