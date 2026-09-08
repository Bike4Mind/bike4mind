import { z } from 'zod';

/**
 * Public wire schemas for the agent-executor (ReAct) endpoints:
 * `POST /api/v1/agent-executions` and `GET /api/v1/agent-executions/{id}`.
 *
 * These are the REST twin of the WebSocket `agent_execute` command surface
 * (apps/client/server/websocket/agentExecute.ts). Both transports funnel into the
 * same `startAgentExecution` service, but the wire shapes are deliberately separate:
 * the WS payload carries UI-only fields (routing provenance, an optimistic-bubble
 * back-reference) that must never become published API surface, and public fields are
 * snake_case per CONVENTIONS.md section 2 while the WS command is camelCase.
 *
 * Public-API rules apply here: no `.catch()`, no top-level `.transform()`.
 */

/**
 * Request body for `POST /api/v1/agent-executions`.
 *
 * `session_id` is required rather than defaulted (unlike `POST /api/chat`, which falls
 * back to the caller's last notebook): the session is what determines which agent
 * profile the executor builds, so guessing it would silently change the run's
 * behaviour. Everything else is optional and falls back to admin defaults or the
 * agent's own orchestration profile.
 */
export const AgentExecutionStartRequestSchema = z.object({
  session_id: z.string().min(1),
  message: z.string().min(1),
  /** Falls back to the deployment's default chat model when omitted. */
  model: z.string().optional(),
  /**
   * Run as a specific persisted agent. Omit to let the executor pick the profile for
   * the session: a session on a dedicated surface gets that surface's own profile,
   * otherwise a synthetic one built from admin orchestration defaults. Omitting this
   * is what reproduces the product UI's Agent Mode toggle.
   */
  agent_id: z.string().optional(),
  /**
   * Bill this run to an organization's credit pool. The caller must belong to it; a
   * non-member gets 404. Omit to bill the caller personally.
   */
  organization_id: z.string().optional(),
  /**
   * Tool-id allowlist for the run. Omit to use the resolved profile's own list.
   *
   * Doubles as pre-approval: REST runs have no interactive client to answer a
   * permission prompt, so tools named here are treated as approved. A run that calls
   * an approval-gated tool NOT named here fails with that tool named in `error`.
   */
  tools: z.array(z.string()).optional(),
  /**
   * Hard ceiling on ReAct iterations. Each one is a full LLM round-trip, so the cap is
   * bounded at 100 regardless of what the profile would allow.
   */
  max_iterations: z.number().int().positive().max(100).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  thinking: z
    .object({
      enabled: z.boolean(),
      /** Bounded at 32000: Anthropic rejects rather than clamps an oversized budget. */
      budget_tokens: z.number().int().positive().max(32000).optional(),
    })
    .optional(),
  /** Per-message file attachments (fabFile ids), materialized into the first iteration. */
  file_ids: z.array(z.string()).optional(),
  /** Workbench-level file ids for the session, forwarded as a dispatch-time snapshot. */
  session_file_ids: z.array(z.string()).optional(),
  enable_mementos: z.boolean().optional(),
  enable_lattice: z.boolean().optional(),
  /**
   * Opt out of the artifact-emission prompt and artifact persistence for this run.
   *
   * ANDed with the deployment's admin `EnableArtifacts` setting, so this can only ever
   * withhold artifacts, never force them on. Omitting it means "no preference" and
   * leaves the admin setting as the only gate; only an explicit `false` opts out.
   * Inherited by any subagent this run dispatches, so a delegating agent cannot route
   * around the opt-out.
   *
   * Worth setting on a REST run: the emission prompt costs roughly 2.8k tokens per
   * iteration, and nothing on this transport renders an artifact back to a human.
   */
  enable_artifacts: z.boolean().optional(),
});

export type AgentExecutionStartRequest = z.infer<typeof AgentExecutionStartRequestSchema>;

/**
 * 202 ACK for `POST /api/v1/agent-executions`. The run is fire-and-forget: nothing is
 * streamed back over REST, so the caller polls `poll_url` until `status` is terminal.
 */
export const AgentExecutionAckSchema = z.object({
  id: z.string(),
  status: z.literal('pending'),
  session_id: z.string(),
  model: z.string(),
  timestamp: z.string(),
  tracking_info: z.object({
    execution_id: z.string(),
    /**
     * The chat-history Quest holding the prompt, which gains the reply when the run
     * completes. Absent when that best-effort write failed; the run still proceeds.
     */
    quest_id: z.string().optional(),
    poll_url: z.string(),
  }),
});

export type AgentExecutionAck = z.infer<typeof AgentExecutionAckSchema>;

/**
 * Step kinds in a published reasoning trace.
 *
 * Deliberately a separate literal from the internal `AgentStepSchema` enum
 * (`schemas/actions.ts`): that module reaches `@bike4mind/hearth`, which the OpenAPI
 * generator cannot import (see api-contract/README.md), and the internal step shape is
 * free to grow fields we do not want to publish. `agentExecution.stepTypes.test.ts`
 * pins the two tuples in lockstep so a new internal kind fails the build here.
 */
export const PUBLIC_AGENT_STEP_TYPES = ['thought', 'action', 'observation', 'final_answer'] as const;

/** One step of a published reasoning trace - a public projection of `IAgentStep`. */
export const AgentExecutionStepSchema = z.object({
  type: z.enum(PUBLIC_AGENT_STEP_TYPES),
  content: z.string(),
  /** 0-indexed iteration. Absent on traces checkpointed before the field existed. */
  iteration: z.number().int().nonnegative().optional(),
  /** Set on `action` steps: the tool the agent invoked. */
  tool_name: z.string().optional(),
});

export type AgentExecutionStep = z.infer<typeof AgentExecutionStepSchema>;

/**
 * Statuses a published poll response can report.
 *
 * Deliberately a separate literal from `AGENT_EXECUTION_STATUSES`. That tuple is the
 * DATABASE's value space, shared with `AgentExecutionModel` and
 * `useAgentExecutionStore`, and it grows whenever the executor gains an internal state
 * (it already gained `awaiting_dag_children`). Publishing it directly would put the
 * next such state into `openapi.json` and every generated client without anyone
 * deciding it should be public. Unlike `PUBLIC_AGENT_STEP_TYPES` above, the internal
 * tuple here IS importable - the copy buys decoupling, not import reachability.
 *
 * Equal to the internal tuple today - the current set is all reasonable to publish -
 * and `agentExecution.statuses.test.ts` pins the two in lockstep, so a new internal
 * status fails the build here and forces the publish-or-not call to be made explicitly.
 */
export const PUBLIC_AGENT_EXECUTION_STATUSES = [
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

/**
 * Poll response for `GET /api/v1/agent-executions/{id}`.
 *
 * `steps` is the live trace: it grows while the run is in flight (read from the
 * checkpoint) and freezes at the final one. `answer` is null until the run reaches a
 * terminal status, and stays null on `failed` / `aborted` - where `error` carries the
 * reason instead.
 */
export const AgentExecutionStatusResponseSchema = z.object({
  id: z.string(),
  status: z.enum(PUBLIC_AGENT_EXECUTION_STATUSES),
  session_id: z.string().nullable(),
  answer: z.string().nullable(),
  /**
   * Why the run ended without an answer. Set only on `failed`; null otherwise.
   * Without this a caller polling a terminal run sees `failed` + a null answer and
   * cannot tell an approval-gated tool from a model error from a timeout.
   *
   * Approval-gate failures name the offending tool, since that is what the caller acts
   * on. Everything else is reduced to a coarse category (billing, rate limit, timeout,
   * auth) or a generic message: the stored reason is a raw internal exception, and
   * those carry infrastructure identifiers. Full detail stays in the server logs.
   */
  error: z.string().nullable(),
  steps: z.array(AgentExecutionStepSchema),
  total_iterations: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AgentExecutionStatusResponse = z.infer<typeof AgentExecutionStatusResponseSchema>;

/** Path parameter for `GET /api/v1/agent-executions/{id}`. */
export const AgentExecutionIdParamSchema = z.object({
  id: z.string().min(1),
});
