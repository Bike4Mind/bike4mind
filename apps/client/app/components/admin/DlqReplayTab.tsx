import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Drawer,
  FormControl,
  FormLabel,
  Grid,
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
import RefreshIcon from '@mui/icons-material/Refresh';
import ReplayIcon from '@mui/icons-material/Replay';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import HistoryIcon from '@mui/icons-material/History';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import QueueIcon from '@mui/icons-material/Queue';
import SearchIcon from '@mui/icons-material/Search';
import { toast } from 'sonner';
import {
  useDlqQueues,
  useDlqMessages,
  useDlqReplay,
  useDlqHistory,
  DlqMessage,
  DlqReplayLogEntry,
  DlqHistoryFilters,
} from '@client/app/hooks/data/dlqManagement';

const StatusChip: React.FC<{ status: 'success' | 'failed' | 'skipped' }> = ({ status }) => {
  const config = {
    success: { color: 'success' as const, icon: <CheckCircleIcon fontSize="small" /> },
    failed: { color: 'danger' as const, icon: <ErrorIcon fontSize="small" /> },
    skipped: { color: 'warning' as const, icon: <WarningIcon fontSize="small" /> },
  };
  const { color, icon } = config[status];
  return (
    <Chip size="sm" color={color} startDecorator={icon} variant="soft">
      {status}
    </Chip>
  );
};

const StatsCard: React.FC<{
  title: string;
  value: string | number;
  color?: 'success' | 'warning' | 'danger' | 'neutral';
  'data-testid'?: string;
}> = ({ title, value, color = 'neutral', 'data-testid': testId }) => {
  const colorMap = {
    success: 'var(--joy-palette-success-500)',
    warning: 'var(--joy-palette-warning-500)',
    danger: 'var(--joy-palette-danger-500)',
    neutral: 'var(--joy-palette-text-primary)',
  };
  return (
    <Card variant="outlined" sx={{ p: 2, textAlign: 'center' }} data-testid={testId}>
      <Typography level="body-sm" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <Typography level="h3" sx={{ color: colorMap[color] }}>
        {value}
      </Typography>
    </Card>
  );
};

const MessageDrawer: React.FC<{
  message: DlqMessage | null;
  open: boolean;
  onClose: () => void;
}> = ({ message, open, onClose }) => {
  if (!message) return null;

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
          <Typography level="title-lg">Message Details</Typography>
          <IconButton onClick={onClose} data-testid="dlq-drawer-close">
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
                Sent At
              </Typography>
              <Typography level="body-sm">{new Date(parseInt(message.sentTimestamp, 10)).toLocaleString()}</Typography>
            </Box>
          )}

          <Box>
            <Typography level="body-sm" fontWeight="bold">
              Receive Count
            </Typography>
            <Typography level="body-sm">{message.approximateReceiveCount ?? 'N/A'}</Typography>
          </Box>

          <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography level="body-sm" fontWeight="bold">
                Message Body
              </Typography>
              <IconButton size="sm" onClick={handleCopy} data-testid="dlq-copy-body">
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

const DlqReplayTab: React.FC = () => {
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

  const handleReplayAll = () => {
    if (!selectedQueue) return;
    setConfirmOpen(true);
  };

  const confirmReplay = async () => {
    if (!selectedQueue) return;
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
    if (!selectedQueue || !singleReplayConfirm) return;
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
    <Box sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography level="h4" startDecorator={<QueueIcon />}>
          DLQ Management
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button
            size="sm"
            variant={showHistory ? 'solid' : 'outlined'}
            startDecorator={<HistoryIcon />}
            onClick={() => setShowHistory(prev => !prev)}
            data-testid="dlq-toggle-history"
          >
            History
          </Button>
          <Button
            size="sm"
            variant="outlined"
            startDecorator={<RefreshIcon />}
            onClick={() => {
              refetchQueues();
              if (selectedQueue) refetchMessages();
            }}
            data-testid="dlq-refresh"
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      {/* Stats */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid xs={4}>
          <StatsCard title="Total DLQs" value={queues?.length ?? 0} data-testid="dlq-stats-total" />
        </Grid>
        <Grid xs={4}>
          <StatsCard
            title="DLQs with Messages"
            value={queuesWithMessages}
            color={queuesWithMessages > 0 ? 'warning' : 'success'}
            data-testid="dlq-stats-with-messages"
          />
        </Grid>
        <Grid xs={4}>
          <StatsCard
            title="Total Failed Messages"
            value={totalMessages}
            color={totalMessages > 0 ? 'danger' : 'success'}
            data-testid="dlq-stats-failed"
          />
        </Grid>
      </Grid>

      {queuesError && (
        <Alert color="danger" sx={{ mb: 2 }}>
          Failed to load DLQ list. Try refreshing.
        </Alert>
      )}

      {/* Queue Selector */}
      <FormControl sx={{ mb: 2, maxWidth: 400 }}>
        <FormLabel>Select DLQ</FormLabel>
        <Select
          placeholder="Choose a queue..."
          value={selectedQueue}
          onChange={(_e, value) => setSelectedQueue(value)}
          renderValue={option => {
            if (!option) return null;
            const q = queues?.find(queue => queue.label === option.value);
            return q ? q.displayName : option.label;
          }}
          data-testid="dlq-queue-selector"
        >
          {queuesLoading && (
            <Option value="" disabled>
              Loading...
            </Option>
          )}
          {queues?.map(q => (
            <Option key={q.label} value={q.label} data-testid={`dlq-queue-option-${q.label}`}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography level="body-sm">{q.displayName}</Typography>
                {q.approximateMessageCount < 0 && (
                  <Chip size="sm" color="warning" variant="soft" sx={{ ml: 1 }}>
                    Error
                  </Chip>
                )}
                {q.approximateMessageCount > 0 && (
                  <Chip size="sm" color="danger" variant="solid" sx={{ ml: 1, minWidth: 20 }}>
                    {q.approximateMessageCount}
                  </Chip>
                )}
              </Stack>
            </Option>
          ))}
        </Select>
      </FormControl>

      {/* Queue Info + Actions */}
      {selectedQueueInfo && (
        <Card variant="outlined" sx={{ mb: 2, p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Stack spacing={0.5}>
              <Typography level="title-md">{selectedQueueInfo.displayName}</Typography>
              <Typography level="body-sm">
                Application: {selectedQueueInfo.application} | Messages:{' '}
                {selectedQueueInfo.approximateMessageCount < 0 ? 'Error' : selectedQueueInfo.approximateMessageCount}
                {selectedQueueInfo.approximateNotVisibleCount > 0 &&
                  ` (${selectedQueueInfo.approximateNotVisibleCount} in flight)`}
              </Typography>
            </Stack>
            <Button
              color="warning"
              startDecorator={<ReplayIcon />}
              onClick={handleReplayAll}
              loading={replayMutation.isPending}
              disabled={!selectedQueueInfo || selectedQueueInfo.approximateMessageCount === 0}
              data-testid="dlq-replay-all"
            >
              Replay All (up to 100)
            </Button>
          </Stack>
        </Card>
      )}

      {/* Replay result alert */}
      {replayMutation.data && (
        <Alert
          color={replayMutation.data.failed > 0 ? 'warning' : 'success'}
          sx={{ mb: 2 }}
          endDecorator={
            <IconButton size="sm" onClick={() => replayMutation.reset()}>
              <CloseIcon />
            </IconButton>
          }
        >
          Last replay: {replayMutation.data.replayed} replayed, {replayMutation.data.failed} failed,{' '}
          {replayMutation.data.skipped} skipped
        </Alert>
      )}

      {/* Messages Table */}
      {selectedQueue && (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto', mb: 3 }}>
          <Table stickyHeader hoverRow data-testid="dlq-messages-table">
            <thead>
              <tr>
                <th style={{ width: 250 }}>Message ID</th>
                <th>Body Preview</th>
                <th style={{ width: 160 }}>Sent At</th>
                <th style={{ width: 100 }}>Receives</th>
                <th style={{ width: 80 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {messagesLoading && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 24 }}>
                    <CircularProgress size="sm" />
                  </td>
                </tr>
              )}
              {!messagesLoading && messagesError && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 24 }}>
                    <Typography level="body-sm" color="danger">
                      Failed to load messages. Try refreshing.
                    </Typography>
                  </td>
                </tr>
              )}
              {!messagesLoading && !messagesError && (!messages || messages.length === 0) && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 24 }}>
                    <Typography level="body-sm" color="neutral">
                      No messages in this DLQ
                    </Typography>
                  </td>
                </tr>
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
                    <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                      {msg.messageId?.slice(0, 20)}...
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-xs" noWrap sx={{ maxWidth: 300 }}>
                      {msg.body?.slice(0, 100)}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-xs">
                      {msg.sentTimestamp ? new Date(parseInt(msg.sentTimestamp, 10)).toLocaleString() : 'N/A'}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-xs">{msg.approximateReceiveCount ?? 'N/A'}</Typography>
                  </td>
                  <td>
                    <Stack direction="row" spacing={0.5}>
                      <Tooltip title="View details">
                        <IconButton
                          size="sm"
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
                      <Tooltip title="Replay this message">
                        <IconButton
                          size="sm"
                          color="warning"
                          onClick={e => {
                            e.stopPropagation();
                            setSingleReplayConfirm(msg);
                          }}
                          disabled={replayMutation.isPending}
                          data-testid={`dlq-replay-single-${msg.messageId}`}
                        >
                          <ReplayIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Sheet>
      )}

      {/* Replay History */}
      {showHistory && (
        <>
          <Typography level="title-md" sx={{ mb: 1 }} startDecorator={<HistoryIcon />}>
            Replay History {selectedQueue ? `(${selectedQueue})` : '(all queues)'}
          </Typography>

          {/* History Filters */}
          <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap">
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
              <FormLabel>Date Range</FormLabel>
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
                placeholder="Search body or error..."
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                startDecorator={<SearchIcon fontSize="small" />}
                sx={{ minWidth: 200 }}
                data-testid="dlq-history-search"
              />
            </FormControl>
            {(historyStatus || historyDateRange !== '7d' || historySearch) && (
              <Box sx={{ display: 'flex', alignItems: 'flex-end' }}>
                <Button
                  size="sm"
                  variant="plain"
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

          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table stickyHeader hoverRow data-testid="dlq-history-table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Queue</th>
                  <th style={{ width: 200 }}>Message ID</th>
                  <th style={{ width: 80 }}>Status</th>
                  <th>Error</th>
                  <th style={{ width: 160 }}>Replayed At</th>
                </tr>
              </thead>
              <tbody>
                {historyLoading && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: 24 }}>
                      <CircularProgress size="sm" />
                    </td>
                  </tr>
                )}
                {!historyLoading && historyError && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: 24 }}>
                      <Typography level="body-sm" color="danger">
                        Failed to load history. Try refreshing.
                      </Typography>
                    </td>
                  </tr>
                )}
                {!historyLoading && !historyError && (!history || history.length === 0) && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: 24 }}>
                      <Typography level="body-sm" color="neutral">
                        No replay history
                      </Typography>
                    </td>
                  </tr>
                )}
                {history?.map((entry: DlqReplayLogEntry) => (
                  <tr key={entry.id}>
                    <td>
                      <Typography level="body-xs">{entry.queueLabel}</Typography>
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                        {entry.messageId?.slice(0, 20)}...
                      </Typography>
                    </td>
                    <td>
                      <StatusChip status={entry.status} />
                    </td>
                    <td>
                      <Typography level="body-xs" noWrap sx={{ maxWidth: 200 }}>
                        {entry.errorMessage || '-'}
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
        </>
      )}

      {/* Message Detail Drawer */}
      <MessageDrawer message={selectedMessage} open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* Confirmation Modal - Replay All */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <ModalDialog>
          <Typography level="h4">Confirm Replay</Typography>
          <Typography level="body-md" sx={{ mt: 1 }}>
            This will replay up to 100 messages from the <strong>{selectedQueueInfo?.displayName}</strong> DLQ back to
            its source queue for reprocessing.
          </Typography>
          <Typography level="body-sm" color="warning" sx={{ mt: 1 }}>
            Messages with 3 or more previous replay attempts (including failures) will be skipped.
          </Typography>
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
            <Button variant="plain" onClick={() => setConfirmOpen(false)} data-testid="dlq-replay-cancel">
              Cancel
            </Button>
            <Button color="warning" onClick={confirmReplay} data-testid="dlq-replay-confirm">
              Replay Messages
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Confirmation Modal - Single Message Replay */}
      <Modal open={!!singleReplayConfirm} onClose={() => setSingleReplayConfirm(null)}>
        <ModalDialog>
          <Typography level="h4">Replay Single Message</Typography>
          <Typography level="body-md" sx={{ mt: 1 }}>
            Replay message <strong>{singleReplayConfirm?.messageId?.slice(0, 20)}...</strong> back to the source queue?
          </Typography>
          <Typography level="body-sm" color="warning" sx={{ mt: 1 }}>
            The message will be sent to the source queue for reprocessing.
          </Typography>
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
            <Button variant="plain" onClick={() => setSingleReplayConfirm(null)} data-testid="dlq-single-replay-cancel">
              Cancel
            </Button>
            <Button color="warning" onClick={confirmSingleReplay} data-testid="dlq-single-replay-confirm">
              Replay Message
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default DlqReplayTab;
