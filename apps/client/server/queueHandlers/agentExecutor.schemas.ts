/**
 * Wire schemas for the agent executor Lambda. Kept in their own module so unit
 * tests can import them without dragging in the executor's Mongo/AWS module
 * graph and the `registerLambdaErrorHandlers()` side effect that lives at the
 * top of `agentExecutor.ts`.
 *
 * Only Zod schemas / inferred types live here - no runtime helpers, no module
 * load-time side effects.
 */

import { z } from 'zod';

/** Payload for direct Lambda invocation (new execution). */
export const StartExecutionSchema = z.object({
  executionId: z.string(),
  userId: z.string(),
  sessionId: z.string(),
  // Optional: the persisted user-prompt Quest id, forwarded on
  // `execution_started` so the client can swap its optimistic bubble for the
  // stable id. Omitted when the Quest write failed at dispatch.
  questId: z.string().optional(),
  query: z.string(),
  model: z.string(),
  connectionId: z.string(),
  organizationId: z.string().optional(),
  // Optional persisted IAgent id. When present, the executor resolves the
  // agent's orchestration profile (allowedTools, maxIterations, etc.) and
  // uses it for the top-level run. When absent, a synthetic default profile
  // is built from admin `orchestrationDefaults`.
  agentId: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  // Defense-in-depth: WebSocket layer enforces the same hard ceiling (see
  // agentExecute.ts). Lambda re-validates here in case the executor is invoked
  // through another path. The HARD ceiling stays at 100 to bound runaway runs;
  // the *soft default* deliberately does NOT live on the schema - Zod would
  // otherwise fill `maxIterations` for every agentless dispatch and defeat
  // `pickEffectiveMaxIterations`, silently making `orchestrationDefaults`
  // unreachable. Soft fallback lives on the profile (or the literal `?? 25`
  // in the non-profile continuation path).
  maxIterations: z.number().int().positive().max(100).optional(),
  // When true, the executor appends the Lattice tools to the agent's toolbelt
  // (parity with chat_completion's `enableLattice` consumption). Forwarded from
  // the WS `start` payload; also persisted on the AgentExecution doc so it
  // survives Lambda handoffs.
  enableLattice: z.boolean().optional(),
});

/** Payload for continuation (SQS or direct re-invocation after permission response). */
export const ContinuationSchema = z.object({
  executionId: z.string(),
  connectionId: z.string(),
  // Optional for backward compat with in-flight messages that pre-date the depth guard.
  // Defaults to 0 at the call site when absent. See MAX_CHECKPOINT_DEPTH in agentExecutor.ts.
  checkpointDepth: z.number().int().min(0).optional(),
});

/**
 * SQS payload for dispatching a subagent to its own Lambda. The child execution
 * doc already holds everything the dispatched Lambda needs (`subagentConfig`,
 * `query`, `model`, etc.) - this payload just routes the right Lambda to load it.
 */
export const SubagentDispatchSchema = z.object({
  kind: z.literal('subagent_dispatch'),
  childExecutionId: z.string(),
  connectionId: z.string(),
  /** Delegation depth of the child being dispatched. Optional for backward compat
   * with in-flight messages that pre-date this field. */
  depth: z.number().int().min(1).optional(),
});

/**
 * SQS payload for dispatching a DAG node (Phase 4a). Mechanically identical to
 * `subagent_dispatch` - the child doc already holds `subagentConfig` -
 * but routed separately so the executor can decide whether to fire the
 * DAG-specific completion hook (sibling unblock + parent resume) when the
 * node finishes.
 */
export const DagNodeDispatchSchema = z.object({
  kind: z.literal('dag_node_dispatch'),
  childExecutionId: z.string(),
  connectionId: z.string(),
  dagNodeId: z.string(),
});

/**
 * Discriminated union for SQS messages. Both new continuation and subagent dispatch
 * messages carry `kind`. Legacy continuation messages without `kind` fall back to
 * `ContinuationSchema` for backward compatibility with in-flight queue messages.
 */
export const TaggedQueueMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('continuation'),
    executionId: z.string(),
    connectionId: z.string(),
    // Optional for backward compat with in-flight messages. See MAX_CHECKPOINT_DEPTH.
    checkpointDepth: z.number().int().min(0).optional(),
  }),
  SubagentDispatchSchema,
  DagNodeDispatchSchema,
]);

export type StartExecutionPayload = z.infer<typeof StartExecutionSchema>;
export type ContinuationPayload = z.infer<typeof ContinuationSchema>;
export type SubagentDispatchPayload = z.infer<typeof SubagentDispatchSchema>;
