import React, { useMemo, useState } from 'react';
import { Button, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import ReplayIcon from '@mui/icons-material/Replay';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ArticleIcon from '@mui/icons-material/Article';
import { toast } from 'sonner';
import { DLQ_MAX_REPLAY_ATTEMPTS, requiresDlqReplayReason } from '@bike4mind/common';
import {
  useDlqDiscard,
  useDlqReplay,
  type DlqBulkOutcome,
  type DlqListedMessage,
  type DlqQueueInfo,
} from '@client/app/hooks/data/dlqManagement';
import {
  BulkActionBar,
  DataTable,
  EmptyState,
  FilterBar,
  StatusChip,
  type AdminSelection,
  type DataColumn,
} from '@client/app/components/admin/shared';
import { useAdminListUrlState } from '@client/app/components/admin/shared/useAdminListUrlState';
import { ActionDialog } from './shared/ActionDialog';
import { AdminPermissionAction } from './shared/MissingPermission';
import { ADMIN_REASON_PRESETS } from './shared/adminReason';
import { REPLAY_CHIP, UNKNOWN_REPLAY_CHIP } from './DlqMessageDrawer';
import { DlqRecommendation } from './DlqRecommendation';
import { DLQ_SEARCH_KEYS } from './dlqSearch';
import { formatDuration, formatExpiresIn, getDlqExpiry } from './dlqExpiry';

const ENTITY_ID_PREVIEW = 12;

/** The area a queue belongs to; overlay-contributed queues have no owner and stand alone. */
export const queueFeature = (queue: DlqQueueInfo | undefined, queueLabel: string): string =>
  queue?.owner ?? queue?.displayName ?? queueLabel;

type Row = DlqListedMessage & { feature: string; queue: DlqQueueInfo | undefined };

const explicitIds = (selection: AdminSelection, rows: readonly Row[]) =>
  selection.mode === 'explicit' ? selection.ids : rows.map(row => row.messageId);

function groupByQueue(rows: readonly Row[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) groups.set(row.queueLabel, [...(groups.get(row.queueLabel) ?? []), row.messageId]);
  return groups;
}

const hasReplayDestination = (row: Row) => row.queue?.hasReplayDestination !== false;

function summarize(verb: string, outcomes: readonly DlqBulkOutcome[]) {
  const count = (status: DlqBulkOutcome['status']) => outcomes.filter(outcome => outcome.status === status).length;
  // The replay endpoint reports a send whose DLQ delete failed as replayed with a reason: the message is
  // still in the DLQ, and replaying it again would repeat its side effects.
  const withWarning = outcomes.filter(outcome => outcome.status === 'replayed' && outcome.reason).length;
  const done = count('replayed') + count('discarded');
  const problems = [
    withWarning && `${withWarning} replayed but still in the DLQ (do not replay them again)`,
    count('failed') && `${count('failed')} failed`,
    count('skipped') && `${count('skipped')} skipped (max replay attempts)`,
    count('notFound') && `${count('notFound')} not found in the queue`,
  ].filter(Boolean);
  const firstReason = outcomes.find(outcome => outcome.status !== 'notFound' && outcome.reason)?.reason;
  const message = [
    `${done} of ${outcomes.length} ${verb}${problems.length ? `; ${problems.join(', ')}` : ''}.`,
    problems.length && firstReason ? firstReason : null,
  ]
    .filter(Boolean)
    .join(' ');
  if (done === 0) toast.error(message);
  else if (problems.length) toast.warning(message);
  else toast.success(message);
}

const AgeCell: React.FC<{ row: Row }> = ({ row }) => {
  const expiry = getDlqExpiry(row.sentTimestamp, row.queue?.messageRetentionSeconds);
  return (
    <Typography level="body-xs" data-testid={`dlq-age-${row.messageId}`}>
      {expiry ? formatDuration(expiry.ageMs) : 'N/A'}
    </Typography>
  );
};

const ExpiresCell: React.FC<{ row: Row }> = ({ row }) => {
  const expiry = getDlqExpiry(row.sentTimestamp, row.queue?.messageRetentionSeconds);
  return (
    <Typography
      level="body-xs"
      color={expiry?.warn ? 'warning' : undefined}
      fontWeight={expiry?.warn ? 'lg' : undefined}
      data-testid={`dlq-expires-${row.messageId}`}
      data-warn={expiry?.warn ? 'true' : 'false'}
    >
      {expiry ? formatExpiresIn(expiry) : 'N/A'}
    </Typography>
  );
};

const COLUMNS: readonly DataColumn<Row>[] = [
  {
    id: 'feature',
    label: 'Feature',
    width: '14rem',
    render: row => (
      <Stack sx={{ minWidth: 0 }}>
        <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
          {row.feature}
        </Typography>
        <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
          {row.queue?.displayName ?? row.queueLabel}
        </Typography>
      </Stack>
    ),
  },
  {
    id: 'entity',
    label: 'Entity',
    width: '12rem',
    help: 'The record the message is about, read from its body.',
    render: row =>
      row.entity ? (
        <Stack sx={{ minWidth: 0 }} data-testid={`dlq-entity-${row.messageId}`}>
          <Typography level="body-xs">{row.entity.type}</Typography>
          <Tooltip title={row.entity.id}>
            <Typography level="body-xs" noWrap sx={{ fontFamily: 'monospace', color: 'admin.inkMuted' }}>
              {row.entity.id.length > ENTITY_ID_PREVIEW
                ? `${row.entity.id.slice(0, ENTITY_ID_PREVIEW)}...`
                : row.entity.id}
            </Typography>
          </Tooltip>
        </Stack>
      ) : (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          -
        </Typography>
      ),
  },
  {
    id: 'failure',
    label: 'Failure',
    render: row => (
      <Stack gap={0.5} sx={{ minWidth: 0 }} data-testid={`dlq-reason-${row.messageId}`}>
        <Typography level="body-xs" noWrap>
          {row.failure?.errorMessage ?? 'Unknown'}
        </Typography>
        <span data-testid={`dlq-category-${row.messageId}`}>
          <StatusChip tone="neutral" label={row.failure?.category ?? 'Unknown'} />
        </span>
      </Stack>
    ),
  },
  {
    id: 'recommendation',
    label: 'Next step',
    width: '14rem',
    help: 'Advisory only, from the recorded failure and replay attempts; review before acting.',
    render: row => <DlqRecommendation message={row} />,
  },
  { id: 'age', label: 'Age', width: '6rem', render: row => <AgeCell row={row} /> },
  { id: 'expires', label: 'Expires in', width: '7rem', render: row => <ExpiresCell row={row} /> },
  {
    id: 'receives',
    label: 'Receives',
    width: '6rem',
    numeric: true,
    help: 'Approximate SQS receives, including views in this browser; not a count of handler failures',
    render: row => row.approximateReceiveCount ?? '-',
  },
];

export const DlqMessagesTable: React.FC<{
  messages: readonly DlqListedMessage[];
  queues: readonly DlqQueueInfo[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onOpen: (message: DlqListedMessage) => void;
}> = ({ messages, queues, loading, error, onRetry, onOpen }) => {
  const [listState, setListState] = useAdminListUrlState(DLQ_SEARCH_KEYS);
  const [selection, setSelection] = useState<AdminSelection>({ mode: 'explicit', ids: [] });
  const [replayOpen, setReplayOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const replay = useDlqReplay();
  const discard = useDlqDiscard();

  const rows = useMemo((): Row[] => {
    const queueByLabel = new Map(queues.map(queue => [queue.label, queue]));
    return messages.map(message => {
      const queue = queueByLabel.get(message.queueLabel);
      return { ...message, queue, feature: queueFeature(queue, message.queueLabel) };
    });
  }, [messages, queues]);

  const { feature: featureFilter, queue: queueFilter } = listState.filters;
  const inFeature = useMemo(
    () => (featureFilter ? rows.filter(row => row.feature === featureFilter) : rows),
    [rows, featureFilter]
  );
  const visibleRows = useMemo(
    () => (queueFilter ? inFeature.filter(row => row.queueLabel === queueFilter) : inFeature),
    [inFeature, queueFilter]
  );

  const filters = useMemo(() => {
    const features = [...new Set(rows.map(row => row.feature))].sort();
    const queueLabels = [...new Set(inFeature.map(row => row.queueLabel))];
    const queueName = (label: string) => queues.find(queue => queue.label === label)?.displayName ?? label;
    return [
      { id: 'feature', label: 'Feature', options: features.map(value => ({ value, label: value })) },
      {
        id: 'queue',
        label: 'Queue',
        options: queueLabels
          .map(value => ({ value, label: queueName(value) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      },
    ];
  }, [rows, inFeature, queues]);

  // Selection only ever holds rows that are on screen, so a filter change never acts on hidden rows.
  const selectedRows = useMemo(() => {
    const ids = new Set(explicitIds(selection, visibleRows));
    return visibleRows.filter(row => ids.has(row.messageId));
  }, [selection, visibleRows]);
  const replayableRows = selectedRows.filter(hasReplayDestination);
  const clearSelection = () => setSelection({ mode: 'explicit', ids: [] });
  const selectAllVisible = () => setSelection({ mode: 'explicit', ids: visibleRows.map(row => row.messageId) });
  const scoped = Boolean(featureFilter || queueFilter);

  const confirmReplay = async (reason: string) => {
    setReplayOpen(false);
    const messageIdsByQueue = groupByQueue(replayableRows);
    // Cleared up front so a selection made while a long replay runs is not wiped when it finishes.
    clearSelection();
    summarize('replayed', await replay.mutateAsync({ messageIdsByQueue, reason: reason || undefined }));
  };

  const confirmDiscard = async (reason: string) => {
    const outcomes = await discard.mutateAsync({ messageIdsByQueue: groupByQueue(selectedRows), reason });
    summarize('discarded', outcomes);
    if (outcomes.some(outcome => outcome.historyPending)) {
      toast.warning(
        'History outcome is unconfirmed for some messages; their bodies are kept for 30 days for manual recovery.'
      );
    }
    // Only a failure is worth retrying; a message that is no longer in the queue never will be.
    if (outcomes.every(outcome => outcome.status === 'failed')) return;
    setDiscardOpen(false);
    clearSelection();
  };

  const replayGroups = [...groupByQueue(replayableRows)].map(([label, ids]) => ({
    queue: queues.find(queue => queue.label === label),
    label,
    count: ids.length,
  }));
  const replayNeedsReason = replayGroups.some(group => requiresDlqReplayReason(group.queue?.replay));

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
        <FilterBar
          state={listState}
          filters={filters}
          search={false}
          onChange={patch => {
            // A new feature can hide the selected queue, so a feature change resets the queue filter.
            const next =
              patch.filters && patch.filters.feature !== featureFilter
                ? { ...patch, filters: { ...patch.filters, queue: '' } }
                : patch;
            setListState(next);
            clearSelection();
          }}
        />
        {scoped && visibleRows.length > 0 && (
          <Button size="sm" variant="plain" onClick={selectAllVisible} data-testid="dlq-select-all-in-scope">
            Select all {visibleRows.length.toLocaleString()} in {queueFilter ? 'this queue' : featureFilter}
          </Button>
        )}
      </Stack>

      <DataTable
        rows={visibleRows}
        columns={COLUMNS}
        getRowId={row => row.messageId}
        label="Dead-letter messages"
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={
          <EmptyState
            title={scoped ? 'No dead letters match these filters' : 'No dead letters'}
            description={scoped ? undefined : 'Every dead-letter queue is empty.'}
            action={null}
          />
        }
        selection={selection}
        onSelectionChange={setSelection}
        onRowActivate={onOpen}
        rowTestId={row => `dlq-message-row-${row.messageId}`}
        pageResetKey={`${featureFilter}|${queueFilter}`}
        testId="dlq-messages-table"
        minWidth="60rem"
        rowActions={row =>
          row.logsUrl ? (
            <Tooltip title="View consumer logs around the send time">
              <IconButton
                size="sm"
                component="a"
                href={row.logsUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View consumer logs"
                data-testid={`dlq-logs-${row.messageId}`}
              >
                <ArticleIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null
        }
      />

      <BulkActionBar
        selection={{ mode: 'explicit', ids: selectedRows.map(row => row.messageId) }}
        totalMatching={scoped ? visibleRows.length : selectedRows.length}
        onSelectAllMatching={selectAllVisible}
        selectAllLabel={scoped ? `Select all ${visibleRows.length.toLocaleString()} in this view` : undefined}
        onClear={clearSelection}
      >
        <AdminPermissionAction
          requirement="settings:manage"
          blockedReason={replayableRows.length === 0 ? 'None of the selected queues has a replay destination' : null}
        >
          {disabled => (
            <Button
              size="sm"
              startDecorator={<ReplayIcon />}
              disabled={disabled || replay.isPending}
              loading={replay.isPending}
              onClick={() => setReplayOpen(true)}
              data-testid="dlq-bulk-replay"
            >
              Replay {replayableRows.length.toLocaleString()}
            </Button>
          )}
        </AdminPermissionAction>
        <AdminPermissionAction requirement="settings:manage">
          {disabled => (
            <Button
              size="sm"
              variant="outlined"
              color="danger"
              startDecorator={<DeleteOutlineIcon />}
              disabled={disabled || discard.isPending}
              onClick={() => setDiscardOpen(true)}
              data-testid="dlq-bulk-discard"
            >
              Discard {selectedRows.length.toLocaleString()}
            </Button>
          )}
        </AdminPermissionAction>
      </BulkActionBar>

      <ActionDialog
        open={replayOpen}
        onClose={() => setReplayOpen(false)}
        title={`Replay ${replayableRows.length.toLocaleString()} messages?`}
        description={`Each message is sent back to its source queue for reprocessing and removed from the dead-letter queue. Messages with ${DLQ_MAX_REPLAY_ATTEMPTS} or more recorded replay attempts are skipped. Replay cannot be undone.`}
        reasonPresets={['Reviewed failure and replay side effects']}
        reasonRequired={replayNeedsReason}
        confirmLabel="Replay messages"
        pending={replay.isPending}
        onConfirm={confirmReplay}
        data-testid="dlq-replay-dialog"
        testIds={{ confirm: 'dlq-replay-confirm' }}
      >
        <Stack gap={1} data-testid="dlq-replay-groups">
          {replayGroups.map(group => {
            const chip = group.queue?.replay ? (REPLAY_CHIP[group.queue.replay] ?? UNKNOWN_REPLAY_CHIP) : null;
            return (
              <Stack key={group.label} gap={0.25}>
                <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                  <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                    {group.queue?.displayName ?? group.label}: {group.count.toLocaleString()}
                  </Typography>
                  {chip && <StatusChip tone={chip.tone} label={chip.label} />}
                </Stack>
                {group.queue?.replayNote && <Typography level="body-xs">{group.queue.replayNote}</Typography>}
              </Stack>
            );
          })}
        </Stack>
        {replayNeedsReason && (
          <Typography level="body-sm" data-testid="dlq-replay-reason-note">
            A reason is required because replay can have side effects or its safety is unknown for some of these
            queues.
          </Typography>
        )}
        {selectedRows.length > replayableRows.length && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="dlq-replay-excluded">
            {(selectedRows.length - replayableRows.length).toLocaleString()} selected messages have no replay
            destination and are left in place.
          </Typography>
        )}
      </ActionDialog>

      <ActionDialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        title={`Discard ${selectedRows.length.toLocaleString()} dead letters?`}
        description="This removes the selected messages from their dead-letter queues. It cannot be undone from this page. Each message body is kept for 30 days for manual recovery."
        reasonPresets={ADMIN_REASON_PRESETS.dlqDiscard}
        confirmLabel={`Discard ${selectedRows.length.toLocaleString()} messages`}
        tone="danger"
        pending={discard.isPending}
        onConfirm={confirmDiscard}
        data-testid="dlq-discard-dialog"
      />
    </Stack>
  );
};
