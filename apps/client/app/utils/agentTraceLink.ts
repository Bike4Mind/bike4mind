/**
 * Deep-link to a single agent execution's reasoning trace on the
 * `/agent-executions` history route. The background-subagent completion toast
 * uses this as a launcher - clicking "View trace" navigates here, and the route
 * renders that execution's `ReasoningDisclosure` expanded (hydrated by id), which
 * works even for background children that are deliberately excluded from the
 * parent's in-chat nest.
 *
 * The route literal and search shape live here as the single source of truth.
 * Callers use them with Tanstack's `navigate({ to: AGENT_TRACE_ROUTE, search })`,
 * which requires `to` to be a route-tree literal - hence the `as const`. `sessionId`
 * is optional: the trace is fetched by `executionId`; the session only namespaces
 * the replay store entry, so it's included when known and omitted otherwise.
 */
export const AGENT_TRACE_ROUTE = '/agent-executions' as const;

export interface AgentTraceSearch {
  expand: string;
  session?: string;
}

export function buildAgentTraceSearch(executionId: string, sessionId?: string): AgentTraceSearch {
  return { expand: executionId, ...(sessionId ? { session: sessionId } : {}) };
}
