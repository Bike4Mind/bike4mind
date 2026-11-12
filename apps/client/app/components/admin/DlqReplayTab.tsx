import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Alert,
  Box,
  Button,
  Drawer,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Tooltip,
  Typography,
} from '@mui/joy';
import ReplayIcon from '@mui/icons-material/Replay';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import SearchIcon from '@mui/icons-material/Search';
import ArticleIcon from '@mui/icons-material/Article';
import { toast } from 'sonner';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { DLQ_QUEUE_PARAM } from '@bike4mind/common';
import {
  useDlqQueues,
  useDlqMessages,
  useDlqReplay,
  useDlqHistory,
  DlqMessage,
  DlqReplayLogEntry,
  DlqHistoryFilters,
  DlqQueueInfo,
  DlqReplaySafety,
} from '@client/app/hooks/data/dlqManagement';
import {
  AdminPageHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionCard,
  StatStrip,
  StatTile,
  StatusChip,
} from '@client/app/components/admin/shared';
import { ADMIN_REGION_GAP, adminSurface } from '@client/app/components/admin/shared/adminStyles';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { AdminPermissionAction } from './shared/MissingPermission';
import { formatDuration, formatExpiresIn, getDlqExpiry } from './dlqExpiry';

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

const REPLAY_STATUS: Record<DlqReplayLogEntry['status'], { tone: AdminStatusTone; label: string }> = {
  success: { tone: 'good', label: 'Success' },
  failed: { tone: 'bad', label: 'Failed' },
  skipped: { tone: 'warn', label: 'Skipped' },
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

const tableSurface = { ...adminSurface, borderRadius: 'lg', overflow: 'auto' } as const;

/** A full-width table row holding a loading, error or empty block in place of data rows. */
const StateRow: React.FC<{ colSpan?: number; children: React.ReactNode }> = ({ colSpan = 5, children }) => (
  <tr>
    <td colSpan={colSpan}>{children}</td>
  </tr>
);

const AgeExpiryCells: React.FC<{
  sentTimestamp?: string;
  retentionSeconds?: number;
  messageId: string;
}> = ({ sentTimestamp, retentionSeconds, messageId }) => {
  const expiry = getDlqExpiry(sentTimestamp, retentionSeconds);
  return (
    <>
      <td>
        <Typography level="body-xs" data-testid={`dlq-age-${messageId}`}>
          {expiry ? formatDuration(expiry.ageMs) : 'N/A'}
        </Typography>
      </td>
      <td>
        <Typography
          level="body-xs"
          color={expiry?.warn ? 'warning' : undefined}
          fontWeight={expiry?.warn ? 'lg' : undefined}
          data-testid={`dlq-expires-${messageId}`}
          data-warn={expiry?.warn ? 'true' : 'false'}
        >
          {expiry ? formatExpiresIn(expiry) : 'N/A'}
        </Typography>
      </td>
    </>
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
            <CloseIcon />
          </IconButton>
        </Stack>

        <Stack spacing={2}>
          <Box>
            <Typography level="body-sm" fontWeight="bold">
              Message ID
            </Typography>
            <Typography level="body-sm" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {message.messageId}
            </Typography>
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
              startDecorator={<ArticleIcon />}
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
                <ContentCopyIcon fontSize="small" />
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
  const [showHistory, setShowHistory] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<'success' | 'failed' | 'skipped' | ''>('');
  const [historyDateRange, setHistoryDateRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d');
  const [historySearch, setHistorySearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(historySearch), 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [historySearch]);

  const historyFilters = useMemo((): DlqHistoryFilters => {
    if (!showHistory) return {};
    const filters: DlqHistoryFilters = {};
    if (selectedQueue) filters.queueLabel = selectedQueue;
    if (historyStatus) filters.status = historyStatus;
    if (historyDateRange !== 'all') {
      const now = new Date();
      const msMap = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 };
      filters.startDate = new Date(now.getTime() - msMap[historyDateRange]).toISOString();
      filters.endDate = now.toISOString();
    }
    if (debouncedSearch) filters.search = debouncedSearch;
    return filters;
  }, [showHistory, selectedQueue, historyStatus, historyDateRange, debouncedSearch]);

  const {
    data: messages,
    isLoading: messagesLoading,
    isError: messagesError,
    refetch: refetchMessages,
  } = useDlqMessages(selectedQueue);
  const replayMutation = useDlqReplay();
  const {
    data: history,
    isLoading: historyLoading,
    isError: historyError,
    refetch: refetchHistory,
  } = useDlqHistory(historyFilters, showHistory);

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

  const confirmReplay = async () => {
    if (!selectedQueue || !hasReplayDestination) return;
    setConfirmOpen(false);
    try {
      const result = await replayMutation.mutateAsync({
        queueLabel: selectedQueue,
        batchSize: 100,
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

  const confirmSingleReplay = async () => {
    if (!selectedQueue || !singleReplayConfirm || !hasReplayDestination) return;
    const { messageId, receiptHandle, body } = singleReplayConfirm;
    setSingleReplayConfirm(null);
    try {
      const result = await replayMutation.mutateAsync(
        receiptHandle
          ? { queueLabel: selectedQueue, messages: [{ messageId, receiptHandle, body }] }
          : { queueLabel: selectedQueue, messageIds: [messageId] }
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
              aria-pressed={showHistory}
              onClick={() => setShowHistory(prev => !prev)}
              data-testid="dlq-toggle-history"
            >
              {showHistory ? 'Hide replay history' : 'Show replay history'}
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => {
                refetchQueues();
                if (selectedQueue) refetchMessages();
              }}
              data-testid="dlq-refresh"
            >
              Refresh
            </Button>
          </>
        }
      />

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
            <Option key={q.label} value={q.label} disabled={!isOnStage(q)} data-testid={`dlq-queue-option-${q.label}`}>
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
            <Stack direction="row" spacing={1}>
              {selectedQueueInfo.logsUrl && (
                <Button
                  size="sm"
                  variant="outlined"
                  component="a"
                  href={selectedQueueInfo.logsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  startDecorator={<ArticleIcon />}
                  data-testid="dlq-queue-logs"
                >
                  View logs
                </Button>
              )}
              <AdminPermissionAction requirement="settings:manage">
                {permissionDisabled => (
                  <Button
                    size="sm"
                    startDecorator={<ReplayIcon />}
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
              <CloseIcon />
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
        <Sheet variant="outlined" sx={tableSurface}>
          {/* fixed table layout ignores th min-width; the floor keeps Body preview >= 160px */}
          <Table stickyHeader hoverRow sx={{ minWidth: 1200 }} data-testid="dlq-messages-table">
            <thead>
              <tr>
                <th style={{ width: 200 }}>Message ID</th>
                <th>Body preview</th>
                <th style={{ width: 200 }}>Failure reason</th>
                <th style={{ width: 120 }}>Category</th>
                <th style={{ width: 160 }}>Sent at</th>
                <th style={{ width: 80 }}>Age</th>
                <th style={{ width: 100 }}>Expires in</th>
                <th style={{ width: 100, textAlign: 'right' }}>Receives</th>
                <th style={{ width: 80 }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {messagesLoading && (
                <StateRow colSpan={9}>
                  <LoadingState label="Loading messages" />
                </StateRow>
              )}
              {!messagesLoading && messagesError && (
                <StateRow colSpan={9}>
                  <ErrorState message="Messages failed to load." onRetry={() => void refetchMessages()} />
                </StateRow>
              )}
              {!messagesLoading && !messagesError && (!messages || messages.length === 0) && (
                <StateRow colSpan={9}>
                  <EmptyState title="No messages in this queue" action={null} />
                </StateRow>
              )}
              {messages?.map(msg => (
                <tr
                  key={msg.messageId}
                  onClick={() => {
                    setSelectedMessage(msg);
                    setDrawerOpen(true);
                  }}
                  style={{ cursor: 'pointer' }}
                  data-testid={`dlq-message-row-${msg.messageId}`}
                >
                  <td>
                    <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'admin.inkMuted' }}>
                      {msg.messageId?.slice(0, 20)}...
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-xs" noWrap sx={{ maxWidth: 300 }}>
                      {msg.body?.slice(0, 100)}
                    </Typography>
                  </td>
                  <td data-testid={`dlq-reason-${msg.messageId}`}>
                    <Typography level="body-xs" noWrap sx={{ maxWidth: 300 }}>
                      {msg.failure?.errorMessage ?? 'Unknown'}
                    </Typography>
                  </td>
                  <td data-testid={`dlq-category-${msg.messageId}`}>
                    <StatusChip tone="neutral" label={msg.failure?.category ?? 'Unknown'} />
                  </td>
                  <td>
                    <Typography level="body-xs">
                      {msg.sentTimestamp ? new Date(parseInt(msg.sentTimestamp, 10)).toLocaleString() : '-'}
                    </Typography>
                  </td>
                  <AgeExpiryCells
                    sentTimestamp={msg.sentTimestamp}
                    retentionSeconds={selectedQueueInfo?.messageRetentionSeconds}
                    messageId={msg.messageId}
                  />
                  <td style={{ textAlign: 'right' }}>
                    <Typography level="body-xs" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {msg.approximateReceiveCount ?? '-'}
                    </Typography>
                  </td>
                  <td>
                    <Stack direction="row" gap={0.5}>
                      <Tooltip title="View details">
                        <IconButton
                          size="sm"
                          aria-label="View details"
                          onClick={e => {
                            e.stopPropagation();
                            setSelectedMessage(msg);
                            setDrawerOpen(true);
                          }}
                          data-testid={`dlq-view-${msg.messageId}`}
                        >
                          <VisibilityIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      {msg.logsUrl && (
                        <Tooltip title="View consumer logs around the send time">
                          <IconButton
                            size="sm"
                            component="a"
                            href={msg.logsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            data-testid={`dlq-logs-${msg.messageId}`}
                          >
                            <ArticleIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      <AdminPermissionAction requirement="settings:manage">
                        {permissionDisabled => (
                          <Tooltip title="Replay this message">
                            <IconButton
                              size="sm"
                              aria-label="Replay this message"
                              onClick={e => {
                                e.stopPropagation();
                                if (hasReplayDestination) setSingleReplayConfirm(msg);
                              }}
                              disabled={permissionDisabled || !hasReplayDestination || replayMutation.isPending}
                              data-testid={`dlq-replay-single-${msg.messageId}`}
                            >
                              <ReplayIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </AdminPermissionAction>
                    </Stack>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Sheet>
      )}

      {showHistory && (
        <Stack gap={2} component="section" aria-labelledby="dlq-history-heading">
          <Typography id="dlq-history-heading" level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
            Replay history {selectedQueue ? `(${selectedQueueInfo?.displayName ?? selectedQueue})` : '(all queues)'}
          </Typography>

          <Stack direction="row" gap={2} flexWrap="wrap">
            <FormControl size="sm">
              <FormLabel>Status</FormLabel>
              <Select
                placeholder="All statuses"
                value={historyStatus || null}
                onChange={(_e, value) => setHistoryStatus((value as typeof historyStatus) || '')}
                sx={{ minWidth: 140 }}
                data-testid="dlq-history-status-filter"
              >
                <Option value="">All</Option>
                <Option value="success">Success</Option>
                <Option value="failed">Failed</Option>
                <Option value="skipped">Skipped</Option>
              </Select>
            </FormControl>
            <FormControl size="sm">
              <FormLabel>Date range</FormLabel>
              <Select
                value={historyDateRange}
                onChange={(_e, value) => setHistoryDateRange(value as typeof historyDateRange)}
                sx={{ minWidth: 140 }}
                data-testid="dlq-history-date-filter"
              >
                <Option value="24h">Last 24 hours</Option>
                <Option value="7d">Last 7 days</Option>
                <Option value="30d">Last 30 days</Option>
                <Option value="all">All time</Option>
              </Select>
            </FormControl>
            <FormControl size="sm">
              <FormLabel>Search</FormLabel>
              <Input
                placeholder="Search message ID or error"
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                startDecorator={<SearchIcon fontSize="small" />}
                sx={{ minWidth: 240 }}
                data-testid="dlq-history-search"
              />
            </FormControl>
            {(historyStatus || historyDateRange !== '7d' || historySearch) && (
              <Box sx={{ display: 'flex', alignItems: 'flex-end' }}>
                <Button
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={() => {
                    setHistoryStatus('');
                    setHistoryDateRange('7d');
                    setHistorySearch('');
                  }}
                  data-testid="dlq-history-clear-filters"
                >
                  Clear filters
                </Button>
              </Box>
            )}
          </Stack>

          <Sheet variant="outlined" sx={tableSurface}>
            <Table stickyHeader hoverRow sx={{ minWidth: 640 }} data-testid="dlq-history-table">
              <thead>
                <tr>
                  <th style={{ width: 160 }}>Feature</th>
                  <th style={{ width: 200 }}>Message ID</th>
                  <th style={{ width: 100 }}>Status</th>
                  <th>Error</th>
                  <th style={{ width: 120 }}>By</th>
                  <th style={{ width: 160 }}>Replayed at</th>
                </tr>
              </thead>
              <tbody>
                {historyLoading && (
                  <StateRow colSpan={6}>
                    <LoadingState label="Loading replay history" />
                  </StateRow>
                )}
                {!historyLoading && historyError && (
                  <StateRow colSpan={6}>
                    <ErrorState message="Replay history failed to load." onRetry={() => void refetchHistory()} />
                  </StateRow>
                )}
                {!historyLoading && !historyError && (!history || history.length === 0) && (
                  <StateRow colSpan={6}>
                    <EmptyState title="No replays match these filters" action={null} />
                  </StateRow>
                )}
                {history?.map((entry: DlqReplayLogEntry) => (
                  <tr key={entry.id} data-testid={`dlq-history-row-${entry.id}`}>
                    <td>
                      <Typography level="body-xs">{entry.sourceQueue}</Typography>
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'admin.inkMuted' }}>
                        {entry.messageId?.slice(0, 20)}...
                      </Typography>
                    </td>
                    <td>
                      <StatusChip tone={REPLAY_STATUS[entry.status].tone} label={REPLAY_STATUS[entry.status].label} />
                    </td>
                    <td>
                      <Typography level="body-xs" noWrap sx={{ maxWidth: 200 }}>
                        {entry.errorMessage || '-'}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs" data-testid={`dlq-history-by-${entry.id}`}>
                        {entry.replayedByName}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs">{new Date(entry.createdAt).toLocaleString()}</Typography>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Sheet>
        </Stack>
      )}

      <MessageDrawer
        message={selectedMessage}
        retentionSeconds={selectedQueueInfo?.messageRetentionSeconds}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <ModalDialog>
          <Typography level="h4">Replay messages</Typography>
          <Typography level="body-md" sx={{ mt: 1 }}>
            This replays up to 100 messages from the <strong>{selectedQueueInfo?.displayName}</strong> queue back to its
            source queue for reprocessing.
          </Typography>
          <Typography level="body-sm" sx={{ mt: 1, color: 'admin.inkMuted' }}>
            Messages with 3 or more previous replay attempts (including failures) are skipped.
          </Typography>
          <Stack direction="row" justifyContent="flex-end" gap={1} sx={{ mt: 2 }}>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setConfirmOpen(false)}
              data-testid="dlq-replay-cancel"
            >
              Cancel
            </Button>
            <Button disabled={!hasReplayDestination} onClick={confirmReplay} data-testid="dlq-replay-confirm">
              Replay messages
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      <Modal open={!!singleReplayConfirm} onClose={() => setSingleReplayConfirm(null)}>
        <ModalDialog>
          <Typography level="h4">Replay message</Typography>
          <Typography level="body-md" sx={{ mt: 1 }}>
            Replay message <strong>{singleReplayConfirm?.messageId?.slice(0, 20)}...</strong> back to the source queue?
          </Typography>
          <Typography level="body-sm" sx={{ mt: 1, color: 'admin.inkMuted' }}>
            The message is sent to the source queue for reprocessing.
          </Typography>
          <Stack direction="row" justifyContent="flex-end" gap={1} sx={{ mt: 2 }}>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setSingleReplayConfirm(null)}
              data-testid="dlq-single-replay-cancel"
            >
              Cancel
            </Button>
            <Button
              disabled={!hasReplayDestination}
              onClick={confirmSingleReplay}
              data-testid="dlq-single-replay-confirm"
            >
              Replay message
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </Stack>
  );
};

export default DlqReplayTab;
