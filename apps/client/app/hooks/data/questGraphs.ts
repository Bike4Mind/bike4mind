/**
 * QuestMaster v5 graph hooks. The wire types are inferred from the server's
 * own Zod response schemas (`@server/questmaster/v5/wire`), so a change to the
 * endpoint contract is a compile error here rather than a runtime surprise.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  QuestGraphDetailResponseSchema,
  QuestGraphListResponseSchema,
  QuestGraphWire,
  QuestNodeWire,
} from '@server/questmaster/v5/wire';
import { api } from '@client/app/contexts/ApiContext';

export type QuestGraph = QuestGraphWire;
export type QuestNode = QuestNodeWire;
export type QuestGraphDetail = z.infer<typeof QuestGraphDetailResponseSchema>;
type QuestGraphList = z.infer<typeof QuestGraphListResponseSchema>;

/**
 * How often the detail view re-reads while a node is running. Node status is
 * derived lazily from the execution on read (see `reconcileQuestNodes`), so
 * polling IS the progress mechanism until Phase 5 wires the WebSocket stream.
 */
const RUNNING_POLL_MS = 3_000;

/**
 * How long after a node completes we keep re-reading to pick up artifacts the
 * terminal write had not landed yet. See the refetchInterval comment.
 */
const ARTIFACT_SETTLE_WINDOW_MS = 30_000;

/**
 * Whether to keep polling after every node has stopped running.
 *
 * The executor calls `markComplete` BEFORE `persistRunAsQuest` writes the
 * artifacts, so the poll that first observes `completed` can legitimately
 * precede them. Stop there and the node looks artifact-less until something
 * else happens to refetch.
 *
 * Deliberately does NOT gate on the run having an answer. An earlier version
 * did, which meant a completed run with a null or empty answer stopped polling
 * immediately and could never pick its artifacts up. Whether an answer exists
 * says nothing about whether artifacts are still landing.
 *
 * Bounded by `completedAt` so a run that genuinely emits no artifacts stops
 * once the window passes instead of polling forever.
 */
export function shouldPollForSettlingArtifacts(
  nodes: Pick<QuestNodeWire, 'status' | 'artifacts' | 'completedAt'>[],
  now = Date.now()
): boolean {
  return nodes.some(
    n =>
      n.status === 'completed' &&
      n.artifacts.length === 0 &&
      Boolean(n.completedAt) &&
      now - new Date(n.completedAt as unknown as string).getTime() < ARTIFACT_SETTLE_WINDOW_MS
  );
}

export const questGraphKeys = {
  all: ['questGraphs'] as const,
  detail: (id: string) => ['questGraphs', id] as const,
};

export function useQuestGraphs(enabled: boolean) {
  return useQuery({
    queryKey: questGraphKeys.all,
    queryFn: async (): Promise<QuestGraphList> => {
      const { data } = await api.get<QuestGraphList>('/api/quest-graphs');
      return data;
    },
    enabled,
  });
}

export function useQuestGraph(graphId: string | null) {
  return useQuery({
    queryKey: questGraphKeys.detail(graphId ?? ''),
    queryFn: async (): Promise<QuestGraphDetail> => {
      const { data } = await api.get<QuestGraphDetail>(`/api/quest-graphs/${graphId}`);
      return data;
    },
    enabled: Boolean(graphId),
    refetchInterval: query => {
      const nodes = query.state.data?.nodes;
      if (!nodes) return false;
      if (nodes.some(n => n.status === 'in_progress')) return RUNNING_POLL_MS;
      return shouldPollForSettlingArtifacts(nodes) ? RUNNING_POLL_MS : false;
    },
  });
}

export function useCreateQuestGraph() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { goal: string; sessionId: string }): Promise<{ graph: QuestGraph }> => {
      const { data } = await api.post<{ graph: QuestGraph }>('/api/quest-graphs', input);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: questGraphKeys.all }),
  });
}

export function useAddQuestNode(graphId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      task: string;
      acceptanceCriteria?: string;
      dependsOn?: string[];
      kind?: 'spine' | 'task';
    }): Promise<{ node: QuestNode }> => {
      const { data } = await api.post<{ node: QuestNode }>(`/api/quest-graphs/${graphId}/nodes`, input);
      return data;
    },
    onSuccess: () => {
      if (graphId) queryClient.invalidateQueries({ queryKey: questGraphKeys.detail(graphId) });
    },
  });
}

export function useRunQuestNode(graphId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { nodeId: string; model: string }): Promise<{ executionId: string }> => {
      const { data } = await api.post<{ executionId: string }>(`/api/quest-nodes/${input.nodeId}/run`, {
        model: input.model,
      });
      return data;
    },
    onSuccess: () => {
      if (graphId) queryClient.invalidateQueries({ queryKey: questGraphKeys.detail(graphId) });
    },
  });
}
