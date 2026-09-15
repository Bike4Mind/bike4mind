/**
 * Canonical agent execution status tuple. Shared between the database model
 * (`AgentExecutionModel`), the client store (`useAgentExecutionStore`), and
 * wire schemas (`ChildExecutionSnapshotSchema`, etc.) so the value space can't
 * drift across boundaries, and so the Zod schemas can type `status` as
 * `z.enum(AGENT_EXECUTION_STATUSES)` instead of `z.string()`.
 */
export const AGENT_EXECUTION_STATUSES = [
  'pending',
  'running',
  'continuing',
  'awaiting_permission',
  'awaiting_subagent',
  'awaiting_dag_children',
  'paused',
  'completed',
  'failed',
  'aborted',
] as const;

export type AgentExecutionStatus = (typeof AGENT_EXECUTION_STATUSES)[number];

/**
 * Statuses that mean an execution is still in flight. Mirrored on client and
 * server; every "is this still running?" check derives from this single list.
 */
export const ACTIVE_AGENT_EXECUTION_STATUSES: readonly AgentExecutionStatus[] = [
  'pending',
  'running',
  'continuing',
  'awaiting_permission',
  'awaiting_subagent',
  'awaiting_dag_children',
  'paused',
] as const;
