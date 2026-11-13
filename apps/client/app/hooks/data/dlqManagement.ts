import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { DlqRecommendation } from '@bike4mind/common';

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
  /** -1 when unreadable, including on a stage that does not create the queue (deployed is false then). */
  approximateMessageCount: number;
  approximateNotVisibleCount: number;
  /** False when this stage does not create the queue (stage-gated scheduled jobs); absent otherwise. */
  deployed?: boolean;
  /** Consumer Lambda log groups; null when the consumer could not be resolved. */
  logGroups?: string[] | null;
  /** CloudWatch Logs Insights link over the consumer's last 24h of logs. */
  logsUrl?: string | null;
  /** Absent when the queue attributes could not be read. */
  messageRetentionSeconds?: number;
}

export interface DlqMessage {
  recommendation?: DlqRecommendation;
  failureLookupFailed?: boolean;
  messageId: string;
  failure?: { errorMessage: string; category: 'refused' | 'timeout' | 'invalid output' | 'bug' | 'unknown' };
  body: string;
  sentTimestamp?: string;
  approximateReceiveCount?: string;
  approximateFirstReceiveTimestamp?: string;
  /** CloudWatch Logs Insights link over the consumer's logs around this message's send time. */
  logsUrl?: string | null;
}

/** The record a dead letter is about, from the queue's `describe(body)` in the server DLQ registry. */
export interface DlqMessageEntity {
  type: string;
  id: string;
}

export interface DlqListedMessage extends DlqMessage {
  queueLabel: string;
  entity: DlqMessageEntity | null;
}

export interface DlqQueueListing {
  label: string;
  /** -1 when the queue attributes could not be read. */
  approximateMessageCount: number;
  /** How many of the queue's messages the listing holds; fewer than the count means it is partial. */
  listed: number;
  failed: boolean;
}

export interface DlqDiscardResult {
  discarded: number;
  failed: number;
  /** Requested IDs the server could not find in the DLQ (already gone, or held by another receive). */
  notFound?: number;
  results: Array<{
    messageId: string;
    status: 'discarded' | 'failed';
    reason?: string;
    historyPending?: boolean;
  }>;
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

const ALL_MESSAGES_KEY = ['admin', 'dlq', 'all-messages'] as const;

/**
 * Every DLQ's messages in one list, newest first. Browsing increments each message's SQS receive
 * count, so this does not refetch on focus; Refresh or a replay/discard reloads it.
 */
export const useDlqAllMessages = () => {
  return useQuery({
    queryKey: ALL_MESSAGES_KEY,
    queryFn: async () => {
      const response = await api.get<{ messages: DlqListedMessage[]; queues: DlqQueueListing[] }>(
        '/api/admin/dlq/all-messages'
      );
      return response.data;
    },
    staleTime: 90 * 1000,
    refetchOnWindowFocus: false,
  });
};

const invalidateDlqQueries = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: ['admin', 'dlq', 'queues'] });
  queryClient.invalidateQueries({ queryKey: ALL_MESSAGES_KEY });
  queryClient.invalidateQueries({ queryKey: ['admin', 'dlq', 'history'] });
};

// The replay and discard endpoints take at most this many message IDs per request.
const MAX_IDS_PER_REQUEST = 100;

export type DlqBulkOutcome = {
  messageId: string;
  queueLabel: string;
  status: 'replayed' | 'discarded' | 'skipped' | 'failed' | 'notFound';
  reason?: string;
  /** Discard only: the deletion was acknowledged but its history record is unconfirmed. */
  historyPending?: boolean;
};

type BatchResult = {
  results: Array<{ messageId: string; status: DlqBulkOutcome['status']; reason?: string; historyPending?: boolean }>;
};

/**
 * Runs one request per queue (chunked to the endpoint limit) in sequence and reports an outcome for
 * every requested ID: a failed request fails its whole chunk, and an ID the server did not answer
 * for was not found in the DLQ. Later chunks still run after one fails.
 */
export async function runDlqBatches(
  messageIdsByQueue: ReadonlyMap<string, readonly string[]>,
  send: (queueLabel: string, messageIds: string[]) => Promise<BatchResult>
): Promise<DlqBulkOutcome[]> {
  const outcomes: DlqBulkOutcome[] = [];
  for (const [queueLabel, ids] of messageIdsByQueue) {
    for (let start = 0; start < ids.length; start += MAX_IDS_PER_REQUEST) {
      const chunk = ids.slice(start, start + MAX_IDS_PER_REQUEST);
      try {
        const { results } = await send(queueLabel, chunk);
        const answered = new Map(results.map(result => [result.messageId, result]));
        for (const messageId of chunk) {
          const result = answered.get(messageId);
          outcomes.push(result ? { ...result, queueLabel } : { messageId, queueLabel, status: 'notFound' });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        outcomes.push(...chunk.map(messageId => ({ messageId, queueLabel, status: 'failed' as const, reason })));
      }
    }
  }
  return outcomes;
}

/** Replays exactly the given messages, grouped by queue, back to their source queues. */
export const useDlqReplay = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageIdsByQueue,
      reason,
    }: {
      messageIdsByQueue: ReadonlyMap<string, readonly string[]>;
      /** Required by the endpoint for any queue whose replay is not marked safe. */
      reason?: string;
    }) =>
      runDlqBatches(messageIdsByQueue, async (queueLabel, messageIds) => {
        const response = await api.post<DlqReplayResult>('/api/admin/dlq/replay', { queueLabel, messageIds, reason });
        return response.data;
      }),
    onSettled: () => invalidateDlqQueries(queryClient),
  });
};

/** Discards exactly the given messages, grouped by queue; each body is kept 30 days for recovery. */
export const useDlqDiscard = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageIdsByQueue,
      reason,
    }: {
      messageIdsByQueue: ReadonlyMap<string, readonly string[]>;
      reason: string;
    }) =>
      runDlqBatches(messageIdsByQueue, async (queueLabel, messageIds) => {
        const response = await api.post<DlqDiscardResult>('/api/admin/dlq/discard', { queueLabel, reason, messageIds });
        return response.data;
      }),
    onSettled: () => invalidateDlqQueries(queryClient),
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
