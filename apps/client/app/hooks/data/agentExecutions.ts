/**
 * Hooks for fetching persisted AgentExecution data. Used by the "Show
 * reasoning" disclosure on Quest bubbles to lazy-load an iteration trace
 * after refresh / on demand, and by the execution history viewer to page
 * through past runs.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { IAgentStep, ChildExecutionSnapshotSchema } from '@bike4mind/common';
import type { z } from 'zod';
import type { SerializedAgentExecutionListItem } from '@bike4mind/database/billing';
import { api } from '@client/app/contexts/ApiContext';
import type { AgentExecutionStatus } from '@client/app/stores/useAgentExecutionStore';

/**
 * Persisted snapshot of a non-background child subagent. Returned by the trace
 * endpoint so `ReasoningDisclosure` can re-render `SubagentStepNest` for
 * completed Quests. Derived from `ChildExecutionSnapshotSchema` in
 * `@bike4mind/common` so it can't drift from the server's wire shape.
 */
export type AgentExecutionChildSnapshot = z.infer<typeof ChildExecutionSnapshotSchema>;

export interface AgentExecutionTrace {
  id: string;
  status: AgentExecutionStatus | null;
  answer: string | null;
  steps: IAgentStep[];
  totalIterations: number | null;
  children: AgentExecutionChildSnapshot[];
}

/**
 * Summary row returned by the list endpoint. Sourced from
 * {@link SerializedAgentExecutionListItem} so client and server share one
 * compile-time-linked shape: a projection tweak is a type error on both sides.
 */
export type AgentExecutionListItem = SerializedAgentExecutionListItem;

export interface AgentExecutionsListFilters {
  status?: AgentExecutionStatus[];
  model?: string[];
  minCredits?: number;
  maxCredits?: number;
  /** ISO date strings */
  from?: string;
  to?: string;
  limit?: number;
}

export interface AgentExecutionsListResponse {
  items: AgentExecutionListItem[];
  nextCursor: string | null;
}

/**
 * Lazy-fetch the iteration trace for a completed agent run. Only enabled when
 * the caller wants to display the trace (e.g. user expanded the "Show
 * reasoning" disclosure), since fetching on every Quest with `agentExecutionId`
 * would be wasteful for chats with many runs.
 */
export function useAgentExecutionTrace(executionId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['agentExecution', executionId],
    queryFn: async (): Promise<AgentExecutionTrace> => {
      const { data } = await api.get<AgentExecutionTrace>(`/api/agent-executions/${executionId}`);
      return data;
    },
    // The trace doesn't change after completion (executions are immutable
    // once terminal). Keep it cached aggressively so toggling the disclosure
    // open/closed doesn't refetch.
    staleTime: 1000 * 60 * 60, // 1 hour
    enabled: !!executionId && enabled,
  });
}

/**
 * Paginated list of the current user's past agent executions. Backs the
 * execution history viewer at `/agent-executions`. Uses `useInfiniteQuery` so
 * filter changes (queryKey change) reset the page chain cleanly without a
 * manual accumulator, and `getNextPageParam` drives the keyset cursor.
 *
 * Filter keys mirror the server's zod schema; arrays serialize via repeated
 * query params (axios default), which the server's preprocessor normalizes.
 */
export function useAgentExecutionsList(filters: AgentExecutionsListFilters) {
  return useInfiniteQuery({
    queryKey: ['agentExecutions', 'list', filters],
    queryFn: async ({ pageParam }): Promise<AgentExecutionsListResponse> => {
      const { data } = await api.get<AgentExecutionsListResponse>('/api/agent-executions', {
        params: { ...filters, before: pageParam },
      });
      return data;
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    // List can still mutate for in-progress runs (status/credits/iteration
    // count tick as the executor writes). 30s is a sensible refetch ceiling;
    // instant updates come from the live socket on the chat side, not here.
    staleTime: 30_000,
  });
}
