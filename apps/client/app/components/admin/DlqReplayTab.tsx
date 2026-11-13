import React, { useState, useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  Drawer,
  FormControl,
  FormLabel,
  IconButton,
  Option,
  Select,
  Sheet,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import { RotateCcw, X, Copy, Eye, FileText, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { DLQ_QUEUE_PARAM } from '@bike4mind/common';
import {
  useDlqQueues,
  useDlqMessages,
  useDlqReplay,
  useDlqDiscard,
  DlqDiscardParams,
  DlqMessage,
  DlqQueueInfo,
  DlqReplaySafety,
} from '@client/app/hooks/data/dlqManagement';
import {
  AdminPageHeader,
  BulkActionBar,
  CopyValue,
  ActionDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionCard,
  StatStrip,
  StatTile,
  StatusChip,
  ViewTabs,
} from '@client/app/components/admin/shared';
import { ADMIN_REGION_GAP, adminSurface } from '@client/app/components/admin/shared/adminStyles';
import type { DataColumn } from './shared/DataTable';
import type { AdminSelection } from './shared/BulkActionBar';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { AdminPermissionAction } from './shared/MissingPermission';
import { ADMIN_REASON_PRESETS } from './shared/adminReason';
import { formatDuration, formatExpiresIn, getDlqExpiry } from './dlqExpiry';
import { DlqHistoryView } from './DlqHistoryView';
import { requiresDlqReplayReason } from '@bike4mind/common';
import { DlqRecommendation } from './DlqRecommendation';
import { DlqReplaySummary } from './DlqReplaySummary';

const REPLAY_CHIP: Record<DlqReplaySafety, { tone: AdminStatusTone; label: string }> = {
  safe: { tone: 'good', label: 'Safe to replay' },
  'side-effects': { tone: 'warn', label: 'Replay has side effects' },
  unsafe: { tone: 'bad', label: 'Unsafe to replay' },
};

// A class the server knows but this bundle does not (e.g. deployed ahead of the client) reads as unsafe.
const UNKNOWN_REPLAY_CHIP = { tone: 'bad', label: 'Replay safety unknown' } as const;

const QueueHint: React.FC<{ queue: DlqQueueInfo }> = ({ queue }) => {
  const chip = queue.replay ? (REPLAY_CHIP[queue.replay] ?? UNKNOWN_REPLAY_CHIP) : undefined;
  return (
    <Stack spacing={0.5} sx={{ px: 2, pb: 1.75 }} data-testid="dlq-queue-hint">
      <Typography level="body-sm">{queue.description}</Typography>
      {chip && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <StatusChip tone={chip.tone} label={chip.label} data-testid="dlq-queue-hint-replay" />
          {queue.replayNote && <Typography level="body-sm">{queue.replayNote}</Typography>}
        </Stack>
      )}
      {queue.owner && <Typography level="body-xs">Owner: {queue.owner}</Typography>}
    </Stack>
  );
};

/** Stands in for the totals when every queue reports zero messages, visible or in flight. */
const AllClear: React.FC<{ checkedAt: number; onCheckAgain: () => void }> = ({ checkedAt, onCheckAgain }) => (
  <Sheet variant="outlined" sx={{ ...adminSurface, borderRadius: 'lg' }} data-testid="dlq-all-clear">
    <EmptyState
      title="No dead letters"
      description={`Every queue listed here is empty, so there is nothing to replay. Last checked ${new Date(checkedAt).toLocaleTimeString()}.`}
      action={
        <Button size="sm" variant="outlined" color="neutral" onClick={onCheckAgain} data-testid="dlq-all-clear-refresh">
          Check again
        </Button>
      }
    />
  </Sheet>
);

const MessageExpiry: React.FC<{
  sentTimestamp?: string;
  retentionSeconds?: number;
  messageId: string;
  kind: 'age' | 'expires';
}> = ({ sentTimestamp, retentionSeconds, messageId, kind }) => {
  const expiry = getDlqExpiry(sentTimestamp, retentionSeconds);
  return (
    <Stack gap={0.5} alignItems="flex-start">
      <Typography
        level="body-xs"
        data-testid={`dlq-${kind}-${messageId}`}
        data-warn={kind === 'expires' && expiry?.warn ? 'true' : 'false'}
        sx={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {expiry ? (kind === 'age' ? formatDuration(expiry.ageMs) : formatExpiresIn(expiry)) : 'N/A'}
      </Typography>
      {kind === 'expires' && expiry?.warn && <StatusChip tone="warn" label="Expiring soon" />}
    </Stack>
  );
};

const MessageDrawer: React.FC<{
  message: DlqMessage | null;
  retentionSeconds?: number;
  open: boolean;
  onClose: () => void;
}> = ({ message, retentionSeconds, open, onClose }) => {
  if (!message) return null;

  const expiry = getDlqExpiry(message.sentTimestamp, retentionSeconds);

  const formatBody = (body: string) => {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.body);
      toast('Message body copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  return (
    <Drawer anchor="right" open={open} onClose={onClose} size="lg">
      <Sheet sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography level="title-lg">Message details</Typography>
          <IconButton onClick={onClose} aria-label="Close" data-testid="dlq-drawer-close">
            <X size={16} />
          </IconButton>
        </Stack>

        <Stack spacing={2}>
          <Box>
            <Typography level="body-sm" fontWeight="bold">
              Message ID
            </Typography>
            <CopyValue value={message.messageId} label="message ID" mono truncate data-testid="dlq-drawer-copy-id" />
          </Box>

          {message.sentTimestamp && (
            <Box>
              <Typography level="body-sm" fontWeight="bold">
                Sent at
              </Typography>
              <Typography level="body-sm">{new Date(parseInt(message.sentTimestamp, 10)).toLocaleString()}</Typography>
            </Box>
          )}

          {message.logsUrl && (
            <Button
              component="a"
              href={message.logsUrl}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="outlined"
              startDecorator={<FileText size={16} />}
              sx={{ alignSelf: 'flex-start' }}
              data-testid="dlq-drawer-logs"
            >
              View consumer logs
            </Button>
          )}
          {expiry && (
            <Box>
              <Typography level="body-sm" fontWeight="bold">
                Age / Expires in
              </Typography>
              <Typography level="body-sm" color={expiry.warn ? 'warning' : undefined} data-testid="dlq-drawer-expiry">
                {expiry.remainingMs === null
                  ? `${formatDuration(expiry.ageMs)} old`
                  : `${formatDuration(expiry.ageMs)} old, expires in ${formatExpiresIn(expiry)}`}
              </Typography>
            </Box>
          )}

          <Box>
            <Typography level="body-sm" fontWeight="bold">
              Receive count
            </Typography>
            <Typography level="body-sm">{message.approximateReceiveCount ?? 'N/A'}</Typography>
          </Box>

          <Box>
            <Typography level="body-sm" fontWeight="bold">
              Failure reason
            </Typography>
            <Typography level="body-sm" sx={{ wordBreak: 'break-word' }} data-testid="dlq-failure-reason">
              {message.failure?.errorMessage ?? 'Unknown'}
            </Typography>
            <StatusChip
              tone="neutral"
              label={message.failure?.category ?? 'Unknown'}
              data-testid="dlq-failure-category"
            />
          </Box>

          <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography level="body-sm" fontWeight="bold">
                Message body
              </Typography>
              <IconButton size="sm" onClick={handleCopy} aria-label="Copy message body" data-testid="dlq-copy-body">
                <Copy size={16} />
              </IconButton>
            </Stack>
            <Sheet
              variant="soft"
              sx={{
                p: 1.5,
                borderRadius: 'sm',
                maxHeight: 400,
                overflow: 'auto',
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {formatBody(message.body)}
            </Sheet>
          </Box>
        </Stack>
      </Sheet>
    </Drawer>
  );
};

const isOnStage = (queue: DlqQueueInfo) => queue.deployed !== false;

const EMPTY_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };
// Must match the discard route's per-request cap (`pages/api/admin/dlq/discard.ts`).
const DISCARD_CHUNK_SIZE = 100;

type DiscardOutcome = {
  messageId: string;
  status: 'discarded' | 'failed';
  reason?: string;
  historyPending?: boolean;
};

/**
 * Discards in sequential chunks the route accepts. A chunk whose request fails counts each of its
 * messages as failed, so one bad chunk does not hide what the others did.
 */
async function discardInChunks(
  queueLabel: string,
  reason: string,
  targets: readonly DlqMessage[],
  discard: (params: DlqDiscardParams) => Promise<{ results: DiscardOutcome[] }>
): Promise<DiscardOutcome[]> {
  const outcomes: DiscardOutcome[] = [];
  for (let start = 0; start < targets.length; start += DISCARD_CHUNK_SIZE) {
    const chunk = targets.slice(start, start + DISCARD_CHUNK_SIZE);
    // The list peeks with visibility 0 and carries no receipt handle, so the route receives by ID.
    const direct = chunk.flatMap(({ messageId, receiptHandle, body }) =>
      receiptHandle && body ? [{ messageId, receiptHandle, body }] : []
    );
    try {
      const { results } = await discard(
        direct.length === chunk.length
          ? { queueLabel, reason, messages: direct }
          : { queueLabel, reason, messageIds: chunk.map(message => message.messageId) }
      );
      outcomes.push(...results);
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Unknown error';
      outcomes.push(...chunk.map(({ messageId }) => ({ messageId, status: 'failed' as const, reason: failure })));
    }
  }
  return outcomes;
}

const pluralMessages = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'message' : 'messages'}`;

const DlqReplayTab: React.FC = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const queueParam = typeof search[DLQ_QUEUE_PARAM] === 'string' ? search[DLQ_QUEUE_PARAM] : null;
  const {
    data: queues,
    isLoading: queuesLoading,
    isError: queuesError,
    dataUpdatedAt: queuesCheckedAt,
    refetch: refetchQueues,
  } = useDlqQueues();

  // The selection lives in the URL so an alarm can deep-link to one queue. A label the registry
  // does not list, or a queue this stage does not create, selects nothing rather than querying it.
  const linkedQueue = queueParam ? queues?.find(q => q.label === queueParam) : undefined;
  const selectedQueue = linkedQueue && isOnStage(linkedQueue) ? linkedQueue.label : null;
  const unknownQueue = queueParam && queues && !selectedQueue ? queueParam : null;
  const setSelectedQueue = (label: string | null) =>
    void navigate({
      to: '/admin',
      search: previous => ({ ...previous, [DLQ_QUEUE_PARAM]: label ?? undefined }),
      replace: true,
    });
  const [selectedMessage, setSelectedMessage] = useState<DlqMessage | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [singleReplayConfirm, setSingleReplayConfirm] = useState<DlqMessage | null>(null);
  const [discardTargets, setDiscardTargets] = useState<DlqMessage[] | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [selection, setSelection] = useState<AdminSelection>(EMPTY_SELECTION);
  // A selection belongs to the queue it was made on.
  const [selectionQueue, setSelectionQueue] = useState(selectedQueue);
  if (selectionQueue !== selectedQueue) {
    setSelectionQueue(selectedQueue);
    setSelection(EMPTY_SELECTION);
  }
  const [showHistory, setShowHistory] = useState(false);

  const {
    data: messages,
    isLoading: messagesLoading,
    isError: messagesError,
    refetch: refetchMessages,
  } = useDlqMessages(showHistory ? null : selectedQueue);
  const replayMutation = useDlqReplay();
  const discardMutation = useDlqDiscard();

  const loadedMessages = useMemo(() => messages ?? [], [messages]);
  const selectedMessages =
    selection.mode === 'allMatching'
      ? loadedMessages
      : loadedMessages.filter(message => selection.ids.includes(message.messageId));
  // Counts only rows still listed, so a refetch that drops a selected message does not inflate the bar.
  const listedSelection: AdminSelection =
    selection.mode === 'allMatching' ? selection : { mode: 'explicit', ids: selectedMessages.map(m => m.messageId) };

  // Totals and the all-clear cover only queues this stage creates; a queue that exists but could
  // not be read (-1) still counts, so it keeps the all-clear from showing.
  const stageQueues = useMemo(() => queues?.filter(isOnStage) ?? [], [queues]);

  const totalMessages = useMemo(
    () => stageQueues.reduce((sum, q) => sum + Math.max(q.approximateMessageCount, 0), 0),
    [stageQueues]
  );

  const queuesWithMessages = useMemo(
    () => stageQueues.filter(q => q.approximateMessageCount > 0).length,
    [stageQueues]
  );

  // A failed background refetch keeps the last good data, so an error must not read as all clear.
  const allClear = useMemo(
    () =>
      !queuesError &&
      stageQueues.length > 0 &&
      stageQueues.every(q => q.approximateMessageCount === 0 && q.approximateNotVisibleCount <= 0),
    [stageQueues, queuesError]
  );

  const selectedQueueInfo = useMemo(() => {
    if (!queues || !selectedQueue) return null;
    return queues.find(q => q.label === selectedQueue) ?? null;
  }, [queues, selectedQueue]);

  const hasReplayDestination = selectedQueueInfo !== null && selectedQueueInfo.hasReplayDestination !== false;

  const handleReplayAll = () => {
    if (!selectedQueue || !hasReplayDestination) return;
    setConfirmOpen(true);
  };

  const confirmReplay = async (reason: string) => {
    if (!selectedQueue || !hasReplayDestination) return;
    setConfirmOpen(false);
    try {
      const result = await replayMutation.mutateAsync({
        queueLabel: selectedQueue,
        batchSize: 100,
        reason: reason || undefined,
      });
      if (result.failed > 0 && result.replayed === 0) {
        toast.error(`Replay failed: all ${result.failed} messages failed.`);
      } else if (result.failed > 0) {
        toast.warning(
          `Replay partially complete: ${result.replayed} replayed, ${result.failed} failed, ${result.skipped} skipped`
        );
      } else if (result.skipped > 0) {
        toast.warning(
          `Replay complete: ${result.replayed} replayed, ${result.skipped} skipped (max attempts exceeded)`
        );
      } else {
        toast.success(`Replay complete: ${result.replayed} messages replayed successfully.`);
      }
    } catch (error) {
      toast.error(`Replay failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const confirmSingleReplay = async (reason: string) => {
    if (!selectedQueue || !singleReplayConfirm || !hasReplayDestination) return;
    const { messageId, receiptHandle, body } = singleReplayConfirm;
    setSingleReplayConfirm(null);
    try {
      const result = await replayMutation.mutateAsync(
        receiptHandle
          ? { queueLabel: selectedQueue, reason: reason || undefined, messages: [{ messageId, receiptHandle, body }] }
          : { queueLabel: selectedQueue, reason: reason || undefined, messageIds: [messageId] }
      );
      const messageResult = result.results?.find(r => r.messageId === messageId);
      if (result.notFound > 0) {
        toast.warning('Message not found in DLQ. It may have been processed or is temporarily unavailable.');
      } else if (result.failed > 0) {
        toast.error(`Replay failed: ${messageResult?.reason || 'Unknown error'}`);
      } else if (result.skipped > 0) {
        toast.warning('Message skipped: max replay attempts exceeded.');
      } else if (messageResult?.reason) {
        toast.warning(`Message replayed with warning: ${messageResult.reason}`);
      } else {
        toast.success('Message replayed successfully.');
      }
    } catch (error) {
      toast.error(`Replay failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const openMessage = (message: DlqMessage) => {
    setSelectedMessage(message);
    setDrawerOpen(true);
  };
  const messageActions = (msg: DlqMessage) => (
    <Stack direction="row" gap={0.5}>
      <Tooltip title="View details">
        <IconButton
          size="sm"
          aria-label="View details"
          onClick={() => openMessage(msg)}
          data-testid={`dlq-view-${msg.messageId}`}
        >
          <Eye size={16} />
        </IconButton>
      </Tooltip>
      {msg.logsUrl && (
        <Tooltip title="View consumer logs around the send time">
          <IconButton
            size="sm"
            aria-label="View consumer logs"
            component="a"
            href={msg.logsUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`dlq-logs-${msg.messageId}`}
          >
            <FileText size={16} />
          </IconButton>
        </Tooltip>
      )}
      <AdminPermissionAction requirement="settings:manage">
        {permissionDisabled => (
          <Tooltip title="Replay this message">
            <IconButton
              size="sm"
              aria-label="Replay this message"
              onClick={() => {
                if (hasReplayDestination) setSingleReplayConfirm(msg);
              }}
              disabled={permissionDisabled || !hasReplayDestination || replayMutation.isPending}
              data-testid={`dlq-replay-single-${msg.messageId}`}
            >
              <RotateCcw size={16} />
            </IconButton>
          </Tooltip>
        )}
      </AdminPermissionAction>
      <AdminPermissionAction requirement="settings:manage">
        {permissionDisabled => (
          <Tooltip title="Discard this message">
            <IconButton
              size="sm"
              color="danger"
              aria-label="Discard this message"
              onClick={() => setDiscardTargets([msg])}
              disabled={permissionDisabled || discarding}
              data-testid={`dlq-discard-single-${msg.messageId}`}
            >
              <Trash2 size={16} />
            </IconButton>
          </Tooltip>
        )}
      </AdminPermissionAction>
    </Stack>
  );
  const failure = (msg: DlqMessage) => (
    <Stack gap={0.5}>
      <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }} data-testid={`dlq-reason-${msg.messageId}`}>
        {msg.failure?.errorMessage ?? 'Unknown'}
      </Typography>
      <DlqRecommendation message={msg} />
    </Stack>
  );
  const category = (msg: DlqMessage) => (
    <StatusChip
      tone="neutral"
      label={msg.failure?.category ?? 'Unknown'}
      data-testid={`dlq-category-${msg.messageId}`}
    />
  );
  const expiryColumn = (kind: 'age' | 'expires'): DataColumn<DlqMessage> => ({
    id: kind,
    label: kind === 'age' ? 'Age' : 'Expires in',
    width: '7rem',
    render: msg => <MessageExpiry {...msg} retentionSeconds={selectedQueueInfo?.messageRetentionSeconds} kind={kind} />,
  });
  const messageColumns: DataColumn<DlqMessage>[] = [
    {
      id: 'id',
      label: 'Message ID',
      width: '12rem',
      render: msg => (
        <CopyValue
          value={msg.messageId}
          label="message ID"
          mono
          truncate
          data-testid={`dlq-copy-id-${msg.messageId}`}
        />
      ),
    },
    {
      id: 'body',
      label: 'Body preview',
      width: '14rem',
      render: msg => (
        <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }}>
          {msg.body?.slice(0, 100)}
        </Typography>
      ),
    },
    { id: 'failure', label: 'Failure reason', width: '12rem', render: failure },
    { id: 'category', label: 'Category', width: '8rem', render: category },
    {
      id: 'sent',
      label: 'Sent at',
      width: '10rem',
      render: msg => (msg.sentTimestamp ? new Date(parseInt(msg.sentTimestamp, 10)).toLocaleString() : '-'),
    },
    expiryColumn('age'),
    expiryColumn('expires'),
    {
      id: 'receives',
      label: 'Receives',
      width: '6rem',
      numeric: true,
      render: msg => (
        <Tooltip title="Approximate SQS receives, including views in this browser; not a count of handler failures">
          <span>{msg.approximateReceiveCount ?? '-'}</span>
        </Tooltip>
      ),
    },
  ];
  const confirmDiscard = async (reason: string) => {
    if (!selectedQueue || !discardTargets?.length) return;
    const single = discardTargets.length === 1;
    setDiscarding(true);
    const outcomes = await discardInChunks(selectedQueue, reason, discardTargets, discardMutation.mutateAsync);
    setDiscarding(false);
    // The mutation invalidates on success only; refresh here so a failed chunk still updates the list and counts.
    void refetchQueues();
    void refetchMessages();

    const failed = outcomes.filter(outcome => outcome.status === 'failed');
    const discarded = outcomes.length - failed.length;
    const historyPending = outcomes.filter(outcome => outcome.historyPending);
    const firstFailure = failed[0]?.reason ?? 'Unknown error';
    if (discarded === 0) {
      const pendingNote = failed.some(outcome => outcome.historyPending) ? '. History outcome is unconfirmed.' : '';
      toast.error(
        single
          ? `Discard failed: ${firstFailure}${pendingNote}`
          : `Discard failed: all ${pluralMessages(failed.length)} failed. ${firstFailure}${pendingNote}`
      );
      return;
    }
    setDiscardTargets(null);
    setSelection(
      failed.length > 0 ? { mode: 'explicit', ids: failed.map(outcome => outcome.messageId) } : EMPTY_SELECTION
    );
    if (failed.length > 0) {
      toast.warning(
        `Discard partially complete: ${discarded.toLocaleString()} discarded, ${failed.length.toLocaleString()} failed. First error: ${firstFailure}`
      );
    } else if (historyPending.length > 0) {
      toast.warning(
        single
          ? 'Deletion acknowledged. History outcome is unconfirmed; the body is kept for 30 days for manual recovery.'
          : `${pluralMessages(discarded)} discarded. History outcome is unconfirmed for ${historyPending.length.toLocaleString()}; bodies are kept for 30 days for manual recovery.`
      );
    } else {
      toast.success(
        single
          ? 'Message discarded. Its body is kept for 30 days for manual recovery.'
          : `${pluralMessages(discarded)} discarded. Their bodies are kept for 30 days for manual recovery.`
      );
    }
  };
  const discardCount = discardTargets?.length ?? 0;

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Dead letters"
        description="Inspect failed messages in each dead-letter queue and replay them to their source queue."
        actions={
          <>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => {
                refetchQueues();
                if (selectedQueue && !showHistory) refetchMessages();
              }}
              data-testid="dlq-refresh"
            >
              Refresh
            </Button>
          </>
        }
      />

      <ViewTabs
        views={[
          { id: 'messages', label: 'Messages' },
          { id: 'history', label: 'History', testId: 'dlq-toggle-history' },
        ]}
        activeId={showHistory ? 'history' : 'messages'}
        onSelect={view => setShowHistory(view === 'history')}
        aria-label="Dead-letter views"
        data-testid="dlq-views"
      />
      {showHistory ? (
        <DlqHistoryView queues={queues ?? []} />
      ) : (
        <>
          {queuesLoading ? (
            <LoadingState label="Loading dead-letter queues" />
          ) : queuesError ? (
            <ErrorState message="The dead-letter queues failed to load." onRetry={() => void refetchQueues()} />
          ) : allClear ? (
            <AllClear checkedAt={queuesCheckedAt} onCheckAgain={() => void refetchQueues()} />
          ) : (
            <StatStrip aria-label="Dead-letter queue totals">
              <StatTile
                label="Dead-letter queues"
                value={<span data-testid="dlq-stats-total">{stageQueues.length.toLocaleString()}</span>}
              />
              <StatTile
                label="Queues with messages"
                value={<span data-testid="dlq-stats-with-messages">{queuesWithMessages.toLocaleString()}</span>}
              />
              <StatTile
                label="Failed messages"
                value={<span data-testid="dlq-stats-failed">{totalMessages.toLocaleString()}</span>}
              />
            </StatStrip>
          )}

          {unknownQueue && (
            <Alert color="neutral" variant="soft" data-testid="dlq-unknown-queue">
              {linkedQueue
                ? `The ${linkedQueue.displayName} queue is not created on this stage, so there is nothing to view here.`
                : `The ${unknownQueue} queue is not listed on this page yet, so it cannot be viewed or replayed here. Check it in the AWS console.`}
            </Alert>
          )}

          <FormControl sx={{ maxWidth: 400 }}>
            <FormLabel>Queue</FormLabel>
            <Select
              placeholder={queuesLoading ? 'Loading queues' : 'Choose a queue'}
              disabled={queuesLoading}
              value={selectedQueue}
              onChange={(_e, value) => setSelectedQueue(value)}
              renderValue={option => {
                if (!option) return null;
                const q = queues?.find(queue => queue.label === option.value);
                return q ? q.displayName : option.label;
              }}
              data-testid="dlq-queue-selector"
            >
              {queues?.map(q => (
                <Option
                  key={q.label}
                  value={q.label}
                  disabled={!isOnStage(q)}
                  data-testid={`dlq-queue-option-${q.label}`}
                >
                  <Stack direction="row" alignItems="center" gap={1}>
                    <Typography level="body-sm">{q.displayName}</Typography>
                    {!isOnStage(q) ? (
                      <StatusChip tone="neutral" label="Not on this stage" />
                    ) : (
                      q.approximateMessageCount < 0 && <StatusChip tone="warn" label="Count unavailable" />
                    )}
                    {q.approximateMessageCount > 0 && (
                      <StatusChip tone="bad" label={q.approximateMessageCount.toLocaleString()} />
                    )}
                  </Stack>
                </Option>
              ))}
            </Select>
          </FormControl>

          {selectedQueueInfo && (
            <SectionCard
              title={selectedQueueInfo.displayName}
              body="custom"
              action={
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {selectedQueueInfo.logsUrl && (
                    <Button
                      size="sm"
                      variant="outlined"
                      component="a"
                      href={selectedQueueInfo.logsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      startDecorator={<FileText size={16} />}
                      data-testid="dlq-queue-logs"
                    >
                      View logs
                    </Button>
                  )}
                  <AdminPermissionAction requirement="settings:manage">
                    {permissionDisabled => (
                      <Button
                        size="sm"
                        startDecorator={<RotateCcw size={16} />}
                        onClick={handleReplayAll}
                        loading={replayMutation.isPending}
                        disabled={
                          permissionDisabled || !hasReplayDestination || selectedQueueInfo.approximateMessageCount === 0
                        }
                        data-testid="dlq-replay-all"
                      >
                        Replay all (up to 100)
                      </Button>
                    )}
                  </AdminPermissionAction>
                  <AdminPermissionAction requirement="settings:manage">
                    {permissionDisabled => (
                      <Button
                        size="sm"
                        variant="outlined"
                        color="danger"
                        startDecorator={<Trash2 size={16} />}
                        onClick={() => setDiscardTargets([...loadedMessages])}
                        loading={discarding}
                        disabled={permissionDisabled || messagesLoading || loadedMessages.length === 0}
                        data-testid="dlq-discard-all-loaded"
                      >
                        Discard all loaded ({loadedMessages.length.toLocaleString()})
                      </Button>
                    )}
                  </AdminPermissionAction>
                </Stack>
              }
            >
              <Typography level="body-sm" sx={{ px: 2, py: 1.75, color: 'admin.inkSecondary' }}>
                Application: {selectedQueueInfo.application}. Messages:{' '}
                {selectedQueueInfo.approximateMessageCount < 0
                  ? 'unavailable'
                  : selectedQueueInfo.approximateMessageCount.toLocaleString()}
                {selectedQueueInfo.approximateNotVisibleCount > 0 &&
                  ` (${selectedQueueInfo.approximateNotVisibleCount.toLocaleString()} in flight)`}
              </Typography>
              {selectedQueueInfo.description !== undefined && <QueueHint queue={selectedQueueInfo} />}
              {!hasReplayDestination && (
                <Alert color="neutral" sx={{ mx: 2, mb: 1.75 }} data-testid="dlq-replay-unavailable">
                  No replay destination is available for this queue. You can still inspect its messages.
                </Alert>
              )}
            </SectionCard>
          )}

          {replayMutation.data && (
            <Alert
              color={replayMutation.data.failed > 0 ? 'warning' : 'success'}
              endDecorator={
                <IconButton size="sm" onClick={() => replayMutation.reset()} aria-label="Dismiss replay result">
                  <X size={18} />
                </IconButton>
              }
            >
              Last replay: {replayMutation.data.replayed} replayed, {replayMutation.data.failed} failed,{' '}
              {replayMutation.data.skipped} skipped
            </Alert>
          )}

          {selectedQueue && !messagesError && messages?.some(message => message.failureLookupFailed) && (
            <Alert color="warning" sx={{ mb: 2 }} data-testid="dlq-failure-lookup-warning">
              Failure details are temporarily unavailable. Queue messages are still shown.
            </Alert>
          )}

          {selectedQueue && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              Advisory only; review before acting.
            </Typography>
          )}
          {selectedQueue && (
            <DataTable
              rows={messages ?? []}
              columns={messageColumns}
              getRowId={msg => msg.messageId}
              label="Dead-letter messages"
              loading={messagesLoading}
              error={messagesError ? 'Messages failed to load.' : undefined}
              onRetry={() => void refetchMessages()}
              empty={<EmptyState title="No messages in this queue" action={null} />}
              onRowActivate={openMessage}
              rowActions={messageActions}
              minWidth="97rem"
              pageResetKey={selectedQueue}
              testId="dlq-messages-table"
              rowTestId={msg => `dlq-message-row-${msg.messageId}`}
              selection={selection}
              onSelectionChange={setSelection}
            />
          )}
          {selectedQueue && (
            <BulkActionBar
              selection={listedSelection}
              totalMatching={loadedMessages.length}
              selectAllLabel={`Select all ${loadedMessages.length.toLocaleString()} loaded`}
              onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
              onClear={() => setSelection(EMPTY_SELECTION)}
            >
              <AdminPermissionAction requirement="settings:manage">
                {permissionDisabled => (
                  <Button
                    size="sm"
                    color="danger"
                    startDecorator={<Trash2 size={16} />}
                    onClick={() => setDiscardTargets([...selectedMessages])}
                    disabled={permissionDisabled || discarding || selectedMessages.length === 0}
                    data-testid="dlq-discard-selected"
                  >
                    Discard selected
                  </Button>
                )}
              </AdminPermissionAction>
            </BulkActionBar>
          )}
        </>
      )}

      <MessageDrawer
        message={selectedMessage}
        retentionSeconds={selectedQueueInfo?.messageRetentionSeconds}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      <ActionDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Replay messages"
        reasonPresets={['Reviewed failure and replay side effects']}
        reasonRequired={requiresDlqReplayReason(selectedQueueInfo?.replay)}
        confirmLabel="Replay messages"
        pending={replayMutation.isPending}
        onConfirm={confirmReplay}
        blockedReason={!hasReplayDestination ? 'No replay destination is available.' : null}
        data-testid="dlq-replay-dialog"
        testIds={{ confirm: 'dlq-replay-confirm' }}
      >
        <DlqReplaySummary queue={selectedQueueInfo} count={100} batch />
      </ActionDialog>
      <ActionDialog
        open={!!singleReplayConfirm}
        onClose={() => setSingleReplayConfirm(null)}
        title="Replay message"
        reasonPresets={['Reviewed failure and replay side effects']}
        reasonRequired={requiresDlqReplayReason(selectedQueueInfo?.replay)}
        confirmLabel="Replay message"
        pending={replayMutation.isPending}
        onConfirm={confirmSingleReplay}
        blockedReason={!hasReplayDestination ? 'No replay destination is available.' : null}
        data-testid="dlq-single-replay-dialog"
        testIds={{ confirm: 'dlq-single-replay-confirm' }}
      >
        <DlqReplaySummary queue={selectedQueueInfo} count={1} messageId={singleReplayConfirm?.messageId} />
      </ActionDialog>
      <ActionDialog
        open={discardCount > 0}
        onClose={() => setDiscardTargets(null)}
        title={discardCount === 1 ? 'Discard dead letter?' : `Discard ${discardCount.toLocaleString()} dead letters?`}
        description={
          discardCount === 1
            ? 'This removes the message from the DLQ. It cannot be undone from this page. The message body is kept for 30 days for manual recovery.'
            : 'This removes the messages from the DLQ. It cannot be undone from this page. Message bodies are kept for 30 days for manual recovery.'
        }
        reasonPresets={ADMIN_REASON_PRESETS.dlqDiscard}
        confirmLabel={discardCount === 1 ? 'Discard message' : `Discard ${pluralMessages(discardCount)}`}
        tone="danger"
        pending={discarding}
        onConfirm={confirmDiscard}
        data-testid="dlq-discard-dialog"
      >
        <Typography level="body-sm" data-testid="dlq-discard-count">
          {pluralMessages(discardCount)} from {selectedQueueInfo?.displayName ?? 'this queue'}
          {discardCount > DISCARD_CHUNK_SIZE &&
            `, sent in ${Math.ceil(discardCount / DISCARD_CHUNK_SIZE).toLocaleString()} requests of up to ${DISCARD_CHUNK_SIZE}`}
        </Typography>
      </ActionDialog>
    </Stack>
  );
};

export default DlqReplayTab;
