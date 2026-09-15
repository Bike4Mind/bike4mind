import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface DlqQueueInfo {
  label: string;
  displayName: string;
  application: string;
  approximateMessageCount: number;
  approximateNotVisibleCount: number;
}

export interface DlqMessage {
  messageId: string;
  body: string;
  receiptHandle?: string;
  sentTimestamp?: string;
  approximateReceiveCount?: string;
  approximateFirstReceiveTimestamp?: string;
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
  messageBody: string;
  sourceQueue: string;
  status: 'success' | 'failed' | 'skipped';
  errorMessage?: string;
  replayedBy: string;
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

export interface DlqHistoryFilters {
  queueLabel?: string;
  status?: 'success' | 'failed' | 'skipped';
  startDate?: string;
  endDate?: string;
  search?: string;
}

/**
 * Fetch DLQ replay history with optional filters.
 */
export const useDlqHistory = (filters: DlqHistoryFilters = {}, enabled = true) => {
  return useQuery({
    queryKey: ['admin', 'dlq', 'history', filters],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters.queueLabel) params.queue = filters.queueLabel;
      if (filters.status) params.status = filters.status;
      if (filters.startDate) params.startDate = filters.startDate;
      if (filters.endDate) params.endDate = filters.endDate;
      if (filters.search) params.search = filters.search;
      const response = await api.get<{ history: DlqReplayLogEntry[] }>('/api/admin/dlq/history', { params });
      return response.data.history;
    },
    staleTime: 30 * 1000,
    enabled,
  });
};
