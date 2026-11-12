import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

// Must stay in sync with DLQ_REPLAY_SAFETY in packages/server-utils/src/utils/dlqRegistry.ts.
export type DlqReplaySafety = 'safe' | 'side-effects' | 'unsafe';

export interface DlqQueueInfo {
  label: string;
  displayName: string;
  application: string;
  /** Absent on older servers, whose registered queues all have replay destinations. */
  hasReplayDestination?: boolean;
  // Help fields are absent for overlay-contributed queues.
  description?: string;
  replay?: DlqReplaySafety;
  replayNote?: string;
  owner?: string;
  approximateMessageCount: number;
  approximateNotVisibleCount: number;
  /** Consumer Lambda log groups; null when the consumer could not be resolved. */
  logGroups?: string[] | null;
  /** CloudWatch Logs Insights link over the consumer's last 24h of logs. */
  logsUrl?: string | null;
  /** Absent when the queue attributes could not be read. */
  messageRetentionSeconds?: number;
}

export interface DlqMessage {
  failureLookupFailed?: boolean;
  messageId: string;
  failure?: { errorMessage: string; category: 'refused' | 'timeout' | 'invalid output' | 'bug' | 'unknown' };
  body: string;
  receiptHandle?: string;
  sentTimestamp?: string;
  approximateReceiveCount?: string;
  approximateFirstReceiveTimestamp?: string;
  /** CloudWatch Logs Insights link over the consumer's logs around this message's send time. */
  logsUrl?: string | null;
}

export interface DlqReplayResult {
  replayed: number;
  failed: number;
  skipped: number;
  notFound: number;
  total: number;
  results: Array<{
    messageId: string;
    status: 'replayed' | 'failed' | 'skipped';
    reason?: string;
  }>;
}

export interface DlqReplayLogEntry {
  id: string;
  queueLabel: string;
  messageId: string;
  sourceQueue: string;
  status: 'success' | 'failed' | 'skipped' | 'discarded' | 'pending';
  operation?: 'replay' | 'discard';
  errorMessage?: string;
  reason?: string;
  replayedBy: string;
  /** Email or username of the admin; falls back to the id when the user no longer exists. */
  replayedByName: string;
  createdAt: string;
}

/**
 * Fetch all DLQs with their message counts.
 * Refreshes every 30 seconds.
 */
export const useDlqQueues = () => {
  return useQuery({
    queryKey: ['admin', 'dlq', 'queues'],
    queryFn: async () => {
      const response = await api.get<{ queues: DlqQueueInfo[] }>('/api/admin/dlq/queues');
      return response.data.queues;
    },
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
  });
};

/**
 * Peek at messages in a specific DLQ.
 */
export const useDlqMessages = (queueLabel: string | null) => {
  return useQuery({
    queryKey: ['admin', 'dlq', 'messages', queueLabel],
    queryFn: async () => {
      if (!queueLabel) throw new Error('Queue label required');
      const response = await api.get<{ messages: DlqMessage[]; queueLabel: string }>('/api/admin/dlq/messages', {
        params: { queue: queueLabel, maxMessages: '10' },
      });
      return response.data.messages;
    },
    enabled: !!queueLabel,
    // Must be <= visibility timeout (120s) to ensure receipt handles are still valid
    staleTime: 90 * 1000,
    refetchOnWindowFocus: false,
  });
};

/**
 * Replay messages from a DLQ to its source queue.
 */
export const useDlqReplay = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      queueLabel: string;
      batchSize?: number;
      messageIds?: string[];
      messages?: Array<{ messageId: string; receiptHandle: string; body: string }>;
    }) => {
      const response = await api.post<DlqReplayResult>('/api/admin/dlq/replay', params);
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'dlq', 'queues'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'dlq', 'messages', variables.queueLabel] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'dlq', 'history'] });
    },
  });
};

export const useDlqDiscard = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      queueLabel: string;
      reason: string;
      messages: Array<{ messageId: string; receiptHandle: string; body: string }>;
    }) => {
      const response = await api.post<{
        discarded: number;
        failed: number;
        results: Array<{
          messageId: string;
          status: 'discarded' | 'failed';
          reason?: string;
          historyPending?: boolean;
        }>;
      }>('/api/admin/dlq/discard', params);
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'dlq', 'queues'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'dlq', 'messages', variables.queueLabel] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'dlq', 'history'] });
    },
  });
};

export interface DlqHistoryFilters {
  queueLabel?: string;
  status?: 'success' | 'failed' | 'skipped' | 'discarded' | 'pending';
  startDate?: string;
  endDate?: string;
  search?: string;
}

/**
 * Fetch DLQ replay history with optional filters.
 */
export const useDlqHistory = (filters: DlqHistoryFilters = {}, enabled = true) => {
  return useInfiniteQuery({
    queryKey: ['admin', 'dlq', 'history', filters],
    initialPageParam: null as string | null,
    getNextPageParam: (page: { history: DlqReplayLogEntry[]; nextCursor: string | null }) => page.nextCursor,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string> = {};
      if (pageParam) params.cursor = pageParam;
      if (filters.queueLabel) params.queue = filters.queueLabel;
      if (filters.status) params.status = filters.status;
      if (filters.startDate) params.startDate = filters.startDate;
      if (filters.endDate) params.endDate = filters.endDate;
      if (filters.search) params.search = filters.search;
      const response = await api.get<{ history: DlqReplayLogEntry[]; nextCursor: string | null }>(
        '/api/admin/dlq/history',
        { params }
      );
      return response.data;
    },
    staleTime: 30 * 1000,
    enabled,
  });
};
