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
  Option,
  Select,
  Sheet,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import { RotateCcw, X, Copy, Eye, Search, FileText } from 'lucide-react';
import useMediaQuery from '@mui/system/useMediaQuery';
import { toast } from 'sonner';
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
  ActionDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionCard,
  StatStrip,
  StatTile,
  StatusChip,
} from '@client/app/components/admin/shared';
import { ADMIN_REGION_GAP } from '@client/app/components/admin/shared/adminStyles';
import type { DataColumn } from './shared/DataTable';
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

const DlqReplayTab: React.FC = () => {
  const compact = useMediaQuery('(max-width: 767px)');
  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);
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

  const { data: queues, isLoading: queuesLoading, isError: queuesError, refetch: refetchQueues } = useDlqQueues();
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

  const totalMessages = useMemo(() => {
    if (!queues) return 0;
    return queues.reduce((sum, q) => sum + Math.max(q.approximateMessageCount, 0), 0);
  }, [queues]);

  const queuesWithMessages = useMemo(() => {
    if (!queues) return 0;
    return queues.filter(q => q.approximateMessageCount > 0).length;
  }, [queues]);

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
    </Stack>
  );
  const failure = (msg: DlqMessage) => (
    <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }} data-testid={`dlq-reason-${msg.messageId}`}>
      {msg.failure?.errorMessage ?? 'Unknown'}
    </Typography>
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
  const messageColumns: DataColumn<DlqMessage>[] = compact
    ? [
        {
          id: 'message',
          label: 'Message / failure',
          render: msg => (
            <Stack gap={1} sx={{ py: 1, minWidth: 0 }}>
              <Typography level="body-sm" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                {msg.messageId}
              </Typography>
              <Stack gap={0.5}>
                <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }}>
                  {msg.body?.slice(0, 100)}
                </Typography>
                {failure(msg)}
                {category(msg)}
              </Stack>
              <Stack direction="row" gap={1} flexWrap="wrap">
                <Typography level="body-xs">Age:</Typography>
                <MessageExpiry {...msg} retentionSeconds={selectedQueueInfo?.messageRetentionSeconds} kind="age" />
                <Typography level="body-xs">Expires in:</Typography>
                <MessageExpiry {...msg} retentionSeconds={selectedQueueInfo?.messageRetentionSeconds} kind="expires" />
                <Typography level="body-xs">Receives: {msg.approximateReceiveCount ?? '-'}</Typography>
              </Stack>
              {messageActions(msg)}
            </Stack>
          ),
        },
      ]
    : [
        {
          id: 'id',
          label: 'Message ID',
          width: '12rem',
          render: msg => (
            <Typography level="body-xs" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
              {msg.messageId}
            </Typography>
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
          render: msg => msg.approximateReceiveCount ?? '-',
        },
      ];
  const historyColumns: DataColumn<DlqReplayLogEntry>[] = [
    { id: 'feature', label: 'Feature', render: entry => entry.sourceQueue },
    {
      id: 'message',
      label: 'Message ID',
      render: entry => (
        <Typography level="body-xs" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
          {entry.messageId}
        </Typography>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      render: entry => <StatusChip tone={REPLAY_STATUS[entry.status].tone} label={REPLAY_STATUS[entry.status].label} />,
    },
    {
      id: 'error',
      label: 'Error',
      render: entry => (
        <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }}>
          {entry.errorMessage || '-'}
        </Typography>
      ),
    },
    {
      id: 'by',
      label: 'By',
      render: entry => (
        <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }} data-testid={`dlq-history-by-${entry.id}`}>
          {entry.replayedByName}
        </Typography>
      ),
    },
    { id: 'time', label: 'Replayed at', render: entry => new Date(entry.createdAt).toLocaleString() },
  ];

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
      ) : (
        <StatStrip aria-label="Dead-letter queue totals">
          <StatTile
            label="Dead-letter queues"
            value={<span data-testid="dlq-stats-total">{(queues?.length ?? 0).toLocaleString()}</span>}
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
            <Option key={q.label} value={q.label} data-testid={`dlq-queue-option-${q.label}`}>
              <Stack direction="row" alignItems="center" gap={1}>
                <Typography level="body-sm">{q.displayName}</Typography>
                {q.approximateMessageCount < 0 && <StatusChip tone="warn" label="Count unavailable" />}
                {q.approximateMessageCount > 0 && (
                  <Typography level="body-xs" sx={{ color: 'admin.inkMuted', fontVariantNumeric: 'tabular-nums' }}>
                    {q.approximateMessageCount.toLocaleString()}
                  </Typography>
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
              <X size={16} />
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
          rowActions={compact ? undefined : messageActions}
          minWidth={compact ? '0' : '94rem'}
          pageResetKey={selectedQueue}
          testId="dlq-messages-table"
          rowTestId={msg => `dlq-message-row-${msg.messageId}`}
        />
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
                startDecorator={<Search size={16} />}
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

          <DataTable
            rows={history ?? []}
            columns={
              compact
                ? [
                    {
                      id: 'history',
                      label: 'Replay history',
                      render: entry => (
                        <Stack gap={0.75} sx={{ py: 1 }}>
                          {historyColumns.map(column => (
                            <Box key={column.id}>
                              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                                {column.label}
                              </Typography>
                              {column.render(entry)}
                            </Box>
                          ))}
                        </Stack>
                      ),
                    },
                  ]
                : historyColumns
            }
            getRowId={entry => entry.id}
            label="Replay history"
            loading={historyLoading}
            error={historyError ? 'Replay history failed to load.' : undefined}
            onRetry={() => void refetchHistory()}
            empty={<EmptyState title="No replays match these filters" action={null} />}
            minWidth={compact ? '0' : '60rem'}
            pageResetKey={JSON.stringify(historyFilters)}
            testId="dlq-history-table"
            rowTestId={entry => `dlq-history-row-${entry.id}`}
          />
        </Stack>
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
        description={
          <>
            Replay up to 100 messages from <strong>{selectedQueueInfo?.displayName}</strong> to its source queue for
            reprocessing. Messages with 3 or more previous replay attempts (including failures) are skipped.
          </>
        }
        reasonPresets={[]}
        reasonAudited={false}
        confirmLabel="Replay messages"
        blockedReason={!hasReplayDestination ? 'No replay destination is available for this queue.' : null}
        pending={replayMutation.isPending}
        onConfirm={confirmReplay}
        data-testid="dlq-replay-dialog"
        testIds={{ confirm: 'dlq-replay-confirm' }}
      />
      <ActionDialog
        open={!!singleReplayConfirm}
        onClose={() => setSingleReplayConfirm(null)}
        title="Replay message"
        description={
          <>
            Replay message <strong>{singleReplayConfirm?.messageId}</strong> to the source queue for reprocessing.
          </>
        }
        reasonPresets={[]}
        reasonAudited={false}
        confirmLabel="Replay message"
        blockedReason={!hasReplayDestination ? 'No replay destination is available for this queue.' : null}
        pending={replayMutation.isPending}
        onConfirm={confirmSingleReplay}
        data-testid="dlq-single-replay-dialog"
        testIds={{ confirm: 'dlq-single-replay-confirm' }}
      />
    </Stack>
  );
};

export default DlqReplayTab;
