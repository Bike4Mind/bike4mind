/**
 * WebSocket Route: agent_execute
 *
 * Dedicated route for agent execution lifecycle management.
 * This handler dispatches commands to the Agent Executor Lambda
 * and manages execution state - it does NOT run the agent itself.
 *
 * Client -> Server actions:
 * - start: invoke Agent Executor Lambda with query
 * - abort: set abort flag on AgentExecutionDoc
 * - permission_response: update permission state, re-invoke executor
 * - gate_response: respond to a confidence-gate pause
 * - reconnect: find active execution, re-stream current state
 */

import { withWebSocketContext } from '@server/websocket/utils';
import {
  agentExecutionRepository,
  organizationRepository,
  sessionRepository,
  Quest,
  type AgentExecutionStatus,
} from '@bike4mind/database';
import type { AgentCheckpoint, AgentStep } from '@bike4mind/agents';
import { buildChildExecutionSnapshots } from '@server/utils/childExecutionSnapshot';
import { persistRunAsQuest } from '@server/utils/persistRunAsQuest';
import { extractFinalAnswer } from '@server/utils/extractFinalAnswer';
import { publishMementoCompletion } from '@server/utils/publishMementoCompletion';
import { decideInlineBudgets } from '@server/websocket/reconnectBudget';
import { verifyJwtToken, checkRateLimit, verifyApiKey, checkApiKeyRateLimitOrThrow } from '@server/cli/auth';
import { Resource } from 'sst';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { z } from 'zod';
import { GenerateImageToolCallSchema } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/**
 * Send an untyped JSON payload to a WebSocket connection.
 * Agent execution events use their own action schema (not MessageDataToClient)
 * since they're consumed by dedicated client-side agent execution handlers.
 */
async function sendAgentEvent(connectionId: string, endpoint: string, payload: Record<string, unknown>): Promise<void> {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  await client.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(payload)),
    })
  );
}

/**
 * Per-user, in-Lambda sweep memoization. The stale-active sweep is an
 * `updateMany` against MongoDB on every `handleStart`; a user firing many
 * starts in quick succession (form refreshes, rapid prompts) would otherwise
 * pay that DB write each time. Skip when we've already swept this user in
 * the last `SWEEP_MEMO_TTL_MS`. Map lives in module scope so it survives
 * across warm-Lambda invocations of the same handler instance.
 */
const SWEEP_MEMO_TTL_MS = 60 * 1000;
const lastSweptAtByUser = new Map<string, number>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BaseMessageSchema = z.object({
  accessToken: z.string(),
  action: z.literal('agent_execute'),
  command: z.enum(['start', 'abort', 'permission_response', 'gate_response', 'reconnect']),
});

const StartCommandSchema = BaseMessageSchema.extend({
  command: z.literal('start'),
  sessionId: z.string(),
  questId: z.string(),
  query: z.string(),
  model: z.string(),
  organizationId: z.string().optional(),
  // Optional persisted IAgent id. When present, the executor resolves
  // the agent's orchestration profile (allowedTools, maxIterations, etc.) and
  // uses it for the top-level run. When absent, a synthetic default profile is
  // built from admin settings - the path the upcoming Agent-mode toggle
  // dispatches through.
  agentId: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  // Bounded ceiling: each iteration is a full LLM round-trip. Without a cap,
  // a client could request enough iterations to span all 5 Lambda handoffs
  // (~65 min total) and inflate cost.
  maxIterations: z.number().int().positive().max(100).optional(),
  // Knowledge / file context forwarded from the client. Session-level
  // knowledge is re-read server-side from the session document; these two
  // arrays capture the workbench + per-message snapshots taken at dispatch.
  messageFileIds: z.array(z.string()).optional(),
  sessionFabFileIds: z.array(z.string()).optional(),
  // LLM runtime knobs. All optional - the executor falls back to
  // ReActAgent defaults when omitted. `imageConfig` was previously persisted
  // as Mongoose Mixed; it was never consumed by the executor and the
  // client's baseline image-params payload tripped a `structuredClone`
  // failure inside ReActAgent.toCheckpoint() - see matching comment in
  // `useSendMessage.ts`.
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  thinking: z
    .object({
      enabled: z.boolean(),
      // Bounded ceiling aligned with the UI slider in `ToolsSection.tsx`
      // (`max: 32000`). The executor backfills 16000 when omitted, but users
      // can dial up to 32000 via the slider and Anthropic rejects (rather
      // than clamps) oversized budgets - keeping these in sync prevents
      // a silent `agent_error` toast for values the UI accepts.
      budget_tokens: z.number().int().positive().max(32000).optional(),
    })
    .optional(),
  // Feature parity with chat_completion. When true, the executor
  // fires `LLMEvents.CompletionCompleted` on terminal completion so the
  // memento-evaluation handler runs against the user's prompt - matching
  // the chat-completion flow's behavior. Required before flipping the
  // Agent-mode default ON.
  enableMementos: z.boolean().optional(),
  // Lattice parity with chat_completion. When true, the executor
  // appends the Lattice tools to the agent's toolbelt so the ReAct loop gets
  // the same context-window optimization quest_processor offers. Persisted on
  // the AgentExecution doc so it survives Lambda handoffs / continuations.
  enableLattice: z.boolean().optional(),
  // User's selected image-generation config (#agent-mode-image-gen). Forwarded
  // so the image_generation / edit_image tools have a model to run with - the
  // executor path otherwise passes no image config and the tool short-circuits
  // with "Image model selection required" (no picker UI exists in a headless
  // run). `.partial()` because the client may omit fields (notably `model`,
  // which is required on the base schema) - the tool defaults what's missing.
  // Consumed only by `buildSubagentToolConfig`; never enters the checkpoint, so
  // it doesn't reintroduce the prior `structuredClone` failure.
  imageConfig: GenerateImageToolCallSchema.partial().optional(),
  // Provenance of the routing decision. Persisted on the
  // dispatch-time Quest so the client renders the `AutoRouteBadge` over
  // classifier-routed responses on reload. Pure metadata - the executor
  // doesn't branch on it.
  routingSource: z.enum(['mention', 'agent_literal', 'toggle', 'classifier', 'user-default', 'complexity']).optional(),
});

const AbortCommandSchema = BaseMessageSchema.extend({
  command: z.literal('abort'),
  executionId: z.string(),
});

const PermissionResponseSchema = BaseMessageSchema.extend({
  command: z.literal('permission_response'),
  executionId: z.string(),
  toolName: z.string(),
  approved: z.boolean(),
  rememberForSession: z.boolean().optional().default(false),
});

const GateResponseSchema = BaseMessageSchema.extend({
  command: z.literal('gate_response'),
  executionId: z.string(),
  decision: z.enum(['continue', 'stop']),
});

const ReconnectCommandSchema = BaseMessageSchema.extend({
  command: z.literal('reconnect'),
  executionId: z.string().optional(),
  sessionId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Cached resources
// ---------------------------------------------------------------------------

const lambdaClient = new LambdaClient({});

/**
 * Maximum concurrent agent executions per user.
 * Subagent executions (created by `delegate_to_agent`) are excluded from this count
 * because they're a downstream effect of an already-counted parent.
 *
 * TODO: Make this configurable per organization or plan tier.
 */
const MAX_CONCURRENT_EXECUTIONS_PER_USER = 3;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, _context, logger) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  let body: z.infer<typeof BaseMessageSchema>;
  try {
    body = BaseMessageSchema.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[agent_execute] Failed to parse request body:', parseError);
    await sendAgentEvent(connectionId, endpoint, {
      action: 'agent_error',
      message: 'Invalid request body',
    });
    return { statusCode: 200 };
  }

  // Authenticate
  let userId: string;
  try {
    const apiKeyInfo = await verifyApiKey({ authorization: `Bearer ${body.accessToken}` });
    userId = apiKeyInfo.userId;
    await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
      userId: apiKeyInfo.userId,
      endpoint: 'ws/agent_execute',
      method: 'WS',
    });
  } catch {
    try {
      const user = await verifyJwtToken(body.accessToken);
      userId = user.id;
      await checkRateLimit(userId);
    } catch {
      await sendAgentEvent(connectionId, endpoint, {
        action: 'agent_error',
        message: 'Authentication failed',
      });
      return { statusCode: 200 };
    }
  }

  logger.updateMetadata({ userId, command: body.command });

  // Route command
  const rawBody = JSON.parse(event.body ?? '');

  switch (body.command) {
    case 'start': {
      const startCmd = StartCommandSchema.parse(rawBody);
      await handleStart(startCmd, userId, connectionId, endpoint, logger);
      break;
    }
    case 'abort': {
      const abortCmd = AbortCommandSchema.parse(rawBody);
      await handleAbort(abortCmd, userId, connectionId, endpoint, logger);
      break;
    }
    case 'permission_response': {
      const permCmd = PermissionResponseSchema.parse(rawBody);
      await handlePermissionResponse(permCmd, userId, connectionId, logger);
      break;
    }
    case 'gate_response': {
      const gateCmd = GateResponseSchema.parse(rawBody);
      await handleGateResponse(gateCmd, userId, connectionId, endpoint, logger);
      break;
    }
    case 'reconnect': {
      const reconnectCmd = ReconnectCommandSchema.parse(rawBody);
      await handleReconnect(reconnectCmd, userId, connectionId, endpoint, logger);
      break;
    }
  }

  return { statusCode: 200 };
});

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleStart(
  cmd: z.infer<typeof StartCommandSchema>,
  userId: string,
  connectionId: string,
  endpoint: string,
  logger: Logger
): Promise<void> {
  // Validate session ownership before creating execution
  const session = await sessionRepository.findById(cmd.sessionId);
  if (!session || session.userId !== userId) {
    logger.warn('[Start] Session ownership validation failed', { sessionId: cmd.sessionId, userId });
    await sendAgentEvent(connectionId, endpoint, {
      action: 'agent_error',
      message: 'Session not found or unauthorized',
    });
    return;
  }

  // Validate organization membership. Without this, a client could
  // pass another tenant's organizationId and bill executions to that org's
  // credit pool.
  if (cmd.organizationId) {
    const org = await organizationRepository.findById(cmd.organizationId);
    const isOwner = org?.userId === userId;
    const isManager = org?.managerId === userId;
    const isMember = org?.users?.some(u => u.userId === userId) ?? false;
    if (!org || (!isOwner && !isManager && !isMember)) {
      logger.warn('[Start] Organization membership validation failed', {
        organizationId: cmd.organizationId,
        userId,
      });
      await sendAgentEvent(connectionId, endpoint, {
        action: 'agent_error',
        message: 'Organization not found or unauthorized',
      });
      return;
    }
  }

  // Sweep stale active executions before counting - `pending` / `running` /
  // `continuing` / `awaiting_permission` / `paused` that the executor
  // Lambda never finished (SQS handoff dropped, Lambda crashed, SST live-
  // lambda tunnel disconnected, user closed the tab on a permission card).
  // Accumulating those locks the user out of new runs (we saw this hit demo
  // prep). Mongoose `updatedAt` slipping past the threshold is the cleanest
  // "this is dead" signal - a healthy run writes the doc on every step.
  // `awaiting_subagent` is intentionally excluded - see `cleanupStaleActive`
  // docstring for the multi-hour-orchestration rationale.
  //
  // Memoized per-user in this Lambda instance to avoid an `updateMany` on
  // every single start; for a user firing N starts in a row, only the first
  // pays the DB hit. Threshold cooperates with the 20-min sweep window -
  // a 60s memo can't hide a stale execution from the next sweep more than
  // 60s past its eligibility.
  const STALE_ACTIVE_MS = 20 * 60 * 1000;
  const now = Date.now();
  const lastSweptAt = lastSweptAtByUser.get(userId) ?? 0;
  if (now - lastSweptAt > SWEEP_MEMO_TTL_MS) {
    const swept = await agentExecutionRepository.cleanupStaleActive(userId, STALE_ACTIVE_MS);
    lastSweptAtByUser.set(userId, now);
    if (swept > 0) {
      logger.info('[Start] Swept stale active executions before count', { userId, swept });
    }
  }

  // Concurrent execution cap (Phase 2): cap top-level executions per user.
  // We count then create - a tiny race window can let a 4th slip in under heavy
  // parallel start. The cap is a guard rail, not a billing-grade lock; the next
  // start will see the right count and reject.
  const activeCount = await agentExecutionRepository.countActiveByUserId(userId);
  if (activeCount >= MAX_CONCURRENT_EXECUTIONS_PER_USER) {
    logger.info('[Start] Concurrent execution cap reached', { userId, activeCount });
    const message = `${MAX_CONCURRENT_EXECUTIONS_PER_USER} agents already running. Wait for one to finish before starting another.`;
    await sendAgentEvent(connectionId, endpoint, {
      action: 'agent_error',
      reason: 'concurrent_limit',
      message,
    });
    // Also write the rejection into chat history so the session isn't left
    // looking empty after a refresh - the user already saw their prompt
    // bubble + concurrent_limit toast in the live UI, but without a Quest
    // the next page load shows an empty notebook with no explanation.
    // Prefix with a marker so the bubble is visually distinguishable from a
    // real assistant reply on refresh - without it, a user scrolling back
    // through history reads "3 agents already running..." as if the model
    // said it.
    // Best-effort: a Quest write failure must not turn this rejection
    // into a Lambda error. Failures log but swallow.
    const replyText = `⚠️ **System:** ${message}`;
    try {
      await Quest.create({
        sessionId: cmd.sessionId,
        type: 'message',
        prompt: cmd.query,
        replies: [replyText],
        timestamp: new Date(),
        status: 'done',
      });
    } catch (err) {
      logger.warn('[Start] Failed to write concurrent-limit Quest — chat history will not reflect this rejection', {
        userId,
        sessionId: cmd.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Create AgentExecution document
  const execution = await agentExecutionRepository.create({
    userId,
    organizationId: cmd.organizationId,
    sessionId: cmd.sessionId,
    questId: cmd.questId,
    query: cmd.query,
    model: cmd.model,
    status: 'pending' as AgentExecutionStatus,
    connectionId,
    approvedTools: [],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
    // Snapshot the forwarded context on the doc so continuation Lambdas
    // reconstruct the same first-iteration materialization.
    messageFileIds: cmd.messageFileIds,
    sessionFabFileIds: cmd.sessionFabFileIds,
    temperature: cmd.temperature,
    maxTokens: cmd.maxTokens,
    thinking: cmd.thinking,
    enableMementos: cmd.enableMementos,
    enableLattice: cmd.enableLattice,
    // Snapshot the user's image config so image tools resolve a model on the
    // first AND continuation iterations (#agent-mode-image-gen).
    imageConfig: cmd.imageConfig,
  });

  const executionId = execution.id;

  // Persist the user's prompt as a Quest immediately so the bubble survives a
  // mid-run reload. Without this, the client's optimistic prompt
  // bubble lives only in React Query cache and disappears on reload, leaving
  // the replayed iteration trace with no visible originating message. The
  // completion handler (`persistRunAsQuest`) later patches `replies` onto
  // this same doc by `agentExecutionId`.
  //
  // Best-effort: a Quest write failure must not block dispatch - the user
  // already saw their prompt in the optimistic bubble, and the AgentExecution
  // doc carries the query for the completion handler. Failures log and fall
  // back to the legacy `cmd.questId` (sessionId-as-questId) for the Lambda
  // payload, matching pre-fix behavior.
  let persistedQuestId: string | undefined;
  try {
    const quest = await Quest.create({
      sessionId: cmd.sessionId,
      type: 'message',
      prompt: cmd.query,
      replies: [],
      timestamp: new Date(),
      // `pending` (not `done`) so Slack completion pollers
      // (CommandHandler / WorkflowStepHandler) don't false-trigger on an
      // empty `replies` array between dispatch and `persistRunAsQuest`.
      // `persistRunAsQuest` flips this to `done` once `replies` is filled.
      status: 'pending',
      agentExecutionId: executionId,
      routingSource: cmd.routingSource,
    });
    persistedQuestId = quest.id;
  } catch (err) {
    logger.warn('[Start] Failed to persist user prompt Quest — bubble will not survive a mid-run reload', {
      executionId,
      sessionId: cmd.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('[Start] Created execution, invoking Lambda', { executionId, persistedQuestId });

  // Invoke Agent Executor Lambda (async - don't wait for completion).
  // If the invoke throws (throttle, IAM, network), tear down the dispatch-
  // time Quest so we don't leak a `pending`-status bubble with no reply and
  // no iteration trace - that would be a worse UX than the pre-fix empty
  // chat (which at least prompted a retry). The AgentExecution doc still
  // lingers as `pending` forever in that case; the stale-active sweep at
  // the top of `handleStart` reaps it on the next start by the same user.
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: Resource.AgentExecutor.name,
        InvocationType: 'Event', // Async invocation
        Payload: Buffer.from(
          JSON.stringify({
            executionId,
            userId,
            sessionId: cmd.sessionId,
            // The real Quest id - only included when `Quest.create` above
            // succeeded. The Lambda forwards it on `execution_started` so the
            // client can swap its optimistic bubble for the real id. We
            // intentionally do NOT fall back to `cmd.questId` here because that
            // value is the sessionId (a back-ref hack from the client) and would
            // mis-key the optimistic swap on the client.
            questId: persistedQuestId,
            query: cmd.query,
            model: cmd.model,
            connectionId,
            organizationId: cmd.organizationId,
            agentId: cmd.agentId,
            enabledTools: cmd.enabledTools,
            maxIterations: cmd.maxIterations,
            // Forwarded in the start payload *and* persisted on the doc (above),
            // unlike `enableMementos` which is doc-only. The executor resolves
            // `startPayload?.enableLattice ?? execution.enableLattice ?? false`,
            // so the doc alone would cover continuations - this start-payload
            // channel is defense-in-depth so the first iteration never depends
            // on the doc write having landed first.
            enableLattice: cmd.enableLattice,
          })
        ),
      })
    );
  } catch (invokeErr) {
    logger.error('[Start] Lambda invoke failed — cleaning up dispatch-time Quest', {
      executionId,
      persistedQuestId,
      error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
    });
    if (persistedQuestId) {
      await Quest.deleteOne({ _id: persistedQuestId }).catch(deleteErr => {
        logger.warn('[Start] Failed to clean up dispatch-time Quest after Lambda invoke failure', {
          executionId,
          persistedQuestId,
          error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        });
      });
    }
    await sendAgentEvent(connectionId, endpoint, {
      action: 'agent_error',
      executionId,
      message: 'Failed to start agent execution. Please try again.',
    });
    return;
  }

  logger.info('[Start] Lambda invoked', { executionId });
}

async function handleAbort(
  cmd: z.infer<typeof AbortCommandSchema>,
  userId: string,
  connectionId: string,
  endpoint: string,
  logger: Logger
): Promise<void> {
  const execution = await agentExecutionRepository.findById(cmd.executionId);
  if (!execution || execution.userId !== userId) {
    await sendAgentEvent(connectionId, endpoint, {
      action: 'agent_error',
      message: 'Execution not found',
    });
    return;
  }

  await agentExecutionRepository.setAbortFlag(cmd.executionId);

  // No Lambda is currently running for these statuses, so the abort flag won't be
  // polled. Mark aborted directly. `awaiting_subagent` joins the list because the
  // parent is between Lambda invocations (waiting on a dispatched child).
  // `awaiting_dag_children` joins for the same reason - parent is between invocations.
  if (
    execution.status === 'awaiting_permission' ||
    execution.status === 'paused' ||
    execution.status === 'awaiting_subagent' ||
    execution.status === 'awaiting_dag_children'
  ) {
    await agentExecutionRepository.markAborted(cmd.executionId);
  }

  // Cascade abort to the synchronous child the parent is waiting on, if any.
  // The dispatched child Lambda polls its own abort flag at each iteration boundary.
  if (execution.waitingOnChild?.childExecutionId) {
    await agentExecutionRepository.setAbortFlag(execution.waitingOnChild.childExecutionId).catch(err => {
      logger.warn('[Abort] Failed to set abort on waiting subagent child', {
        childExecutionId: execution.waitingOnChild!.childExecutionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Phase 4a - cascade abort to all DAG children of this parent. Running
  // children's Lambdas poll the abort flag; pending children that haven't
  // dispatched yet stay safely in `pending` (their dispatched Lambda will
  // see `abortedAt` set and exit before claiming).
  if (execution.dagSpec) {
    const dagChildren = await agentExecutionRepository
      .findDagChildrenLean(cmd.executionId)
      .catch(() => [] as Array<{ _id: unknown; status: string }>);
    for (const child of dagChildren) {
      const childId = String(child._id);
      await agentExecutionRepository.setAbortFlag(childId).catch(err => {
        logger.warn('[Abort] Failed to set abort on DAG child', {
          childExecutionId: childId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Same logic as subagent / background - terminal-mark statuses that no
      // Lambda is actively running so they're recorded as aborted, not stuck.
      if (child.status === 'pending' || child.status === 'awaiting_permission' || child.status === 'paused') {
        await agentExecutionRepository.markAborted(childId).catch(() => {});
      }
    }
  }

  // Cascade abort to all background children spawned by this parent. Without
  // cascading, background children would keep burning credits unattended after the
  // parent is aborted (Phase 3 will add per-child abort UI; until then, cascade
  // protects against orphan cost). Both `running` Lambdas (poll the flag) and
  // `awaiting_permission/paused/awaiting_subagent` (mark aborted directly) are
  // covered by mirroring the parent's status check.
  const backgroundChildren = await agentExecutionRepository.findBackgroundChildrenOf(cmd.executionId).catch(() => []);
  for (const child of backgroundChildren) {
    await agentExecutionRepository.setAbortFlag(child.id).catch(err => {
      logger.warn('[Abort] Failed to set abort on background child', {
        childExecutionId: child.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    if (child.status === 'awaiting_permission' || child.status === 'paused' || child.status === 'awaiting_subagent') {
      await agentExecutionRepository.markAborted(child.id).catch(() => {});
    }
  }

  await sendAgentEvent(connectionId, endpoint, {
    action: 'abort_acknowledged',
    executionId: cmd.executionId,
    backgroundChildrenAborted: backgroundChildren.length,
  });

  logger.info('[Abort] Abort flag set', {
    executionId: cmd.executionId,
    backgroundChildren: backgroundChildren.length,
    waitingOnChild: execution.waitingOnChild?.childExecutionId,
  });
}

async function handlePermissionResponse(
  cmd: z.infer<typeof PermissionResponseSchema>,
  userId: string,
  connectionId: string,
  logger: Logger
): Promise<void> {
  const execution = await agentExecutionRepository.findById(cmd.executionId);
  if (!execution || execution.userId !== userId) return;
  if (execution.status !== 'awaiting_permission') return;

  // Validate toolName matches the pending permission request
  if (execution.pendingPermission && execution.pendingPermission.toolName !== cmd.toolName) {
    logger.warn('[Permission] toolName mismatch — ignoring', {
      expected: execution.pendingPermission.toolName,
      received: cmd.toolName,
    });
    return;
  }

  // Update permission state
  if (cmd.approved) {
    await agentExecutionRepository.updatePermissionState(cmd.executionId, {
      pendingPermission: null,
      approvedTool: cmd.rememberForSession ? cmd.toolName : undefined,
    });
  } else {
    await agentExecutionRepository.updatePermissionState(cmd.executionId, {
      pendingPermission: null,
      deniedTool: cmd.rememberForSession ? cmd.toolName : undefined,
    });
  }

  // Re-invoke Lambda to resume execution.
  // Note: checkpointDepth is not carried here - it lives in the SQS message from the previous
  // Lambda handoff, not in the AgentExecution document, so this handler cannot read it.
  // The resumed Lambda starts at depth 0. This is safe: permission pauses are user-driven,
  // not loop-driven, so they cannot cause runaway self-dispatch on their own.
  await agentExecutionRepository.updateStatus(cmd.executionId, 'continuing');

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: Resource.AgentExecutor.name,
      InvocationType: 'Event',
      Payload: Buffer.from(
        JSON.stringify({
          executionId: cmd.executionId,
          connectionId,
        })
      ),
    })
  );

  logger.info('[Permission] Response processed, Lambda re-invoked', {
    executionId: cmd.executionId,
    approved: cmd.approved,
  });
}

/**
 * Handle a client response to a confidence-gate pause. Two outcomes:
 * - `continue` -> clear `pendingGate`, transition `paused -> continuing`,
 *   re-invoke the executor Lambda. Mirrors the structural template of
 *   `handlePermissionResponse` so the CAS contract on the executor side
 *   (`['continuing'] -> 'running'`) is satisfied identically.
 * - `stop` -> mark the execution complete with the partial answer captured
 *   in the checkpoint so far, and emit a `completed` event. The user keeps
 *   whatever the agent had produced before the gate fired.
 *
 * Validates `executionId` ownership and current status. Silently ignores
 * gate responses for executions not in `paused` to defend against stale
 * client retries.
 */
async function handleGateResponse(
  cmd: z.infer<typeof GateResponseSchema>,
  userId: string,
  connectionId: string,
  endpoint: string,
  logger: Logger
): Promise<void> {
  const execution = await agentExecutionRepository.findById(cmd.executionId);
  if (!execution || execution.userId !== userId) return;
  if (execution.status !== 'paused') {
    logger.warn('[Gate] gate_response received for non-paused execution — ignoring', {
      executionId: cmd.executionId,
      status: execution.status,
    });
    return;
  }

  if (cmd.decision === 'stop') {
    // Same `abortedAt`-not-exists guard as the `continue` branch - bail if a
    // concurrent abort landed between the status read above and now. Without
    // this, `markComplete` (which has no such guard) would silently overwrite
    // a freshly-aborted execution back to `completed`, contradicting the
    // user's abort decision.
    const cleared = await agentExecutionRepository.clearPendingGate(cmd.executionId);
    if (!cleared) {
      logger.warn('[Gate] Stop ignored — clearPendingGate matched 0 docs (likely aborted concurrently)', {
        executionId: cmd.executionId,
      });
      return;
    }
    const checkpoint = execution.checkpoint as AgentCheckpoint | undefined;
    const finalAnswer = checkpoint ? extractFinalAnswer(checkpoint.steps) : undefined;
    await agentExecutionRepository.markComplete(cmd.executionId, {
      answer: finalAnswer,
      steps: checkpoint?.steps ?? [],
      totalTokens: checkpoint?.totalTokens ?? 0,
      totalIterations: checkpoint?.iteration ?? 0,
      stoppedByGate: true,
    });
    await sendAgentEvent(connectionId, endpoint, {
      action: 'completed',
      executionId: cmd.executionId,
      answer: finalAnswer,
      totalIterations: checkpoint?.iteration ?? 0,
      totalCreditsUsed: execution.totalCreditsUsed,
      stoppedByGate: true,
      mementoIds: execution.usedMementoIds ?? [],
    });
    // Persist a Quest so the partial answer survives a page refresh - parity
    // with the executor's natural completion path. Without this, refreshing
    // after a stop leaves chat history blank (the prompt
    // bubble exists with an empty `replies[]` until something writes it).
    await persistRunAsQuest(
      cmd.executionId,
      finalAnswer ?? 'Agent stopped at confidence gate without a partial answer.',
      logger
    );
    // Memento parity with chat_completion. Stop-at-gate is also a
    // terminal `completed` write, so fire the same event the executor's
    // natural completion path fires. Guarded inside the helper on
    // `enableMementos` and `parentExecutionId`.
    await publishMementoCompletion(execution, logger);
    logger.info('[Gate] Stopped execution with partial answer', { executionId: cmd.executionId });
    return;
  }

  // decision === 'continue' - clear the gate and resume.
  const cleared = await agentExecutionRepository.clearPendingGate(cmd.executionId);
  if (!cleared) {
    // Either the doc no longer exists or the execution was aborted between
    // the status check above and now. Bail rather than re-invoke into a
    // state the executor's CAS will reject.
    logger.warn('[Gate] clearPendingGate matched 0 docs — likely aborted concurrently', {
      executionId: cmd.executionId,
    });
    return;
  }
  await agentExecutionRepository.updateStatus(cmd.executionId, 'continuing');

  // Note: checkpointDepth is not carried here - same limitation as the permission_response
  // path above. Gate resumes are user-driven and cannot cause a runaway loop on their own.
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: Resource.AgentExecutor.name,
      InvocationType: 'Event',
      Payload: Buffer.from(
        JSON.stringify({
          executionId: cmd.executionId,
          connectionId,
        })
      ),
    })
  );

  logger.info('[Gate] Continue — Lambda re-invoked', { executionId: cmd.executionId });
}

async function handleReconnect(
  cmd: z.infer<typeof ReconnectCommandSchema>,
  userId: string,
  connectionId: string,
  endpoint: string,
  logger: Logger
): Promise<void> {
  let execution;
  if (cmd.executionId) {
    execution = await agentExecutionRepository.findById(cmd.executionId);
  } else if (cmd.sessionId) {
    execution = await agentExecutionRepository.findActiveBySessionId(cmd.sessionId);
  }

  if (!execution || execution.userId !== userId) {
    await sendAgentEvent(connectionId, endpoint, {
      action: 'reconnect_result',
      found: false,
    });
    return;
  }

  // Update connection ID for future streaming
  await agentExecutionRepository.updateConnectionId(execution.id, connectionId);

  // Persisted iteration trace for step replay. The checkpoint
  // carries the full step history; we include it inline when it fits in
  // `STEPS_INLINE_BUDGET_BYTES` (see the module-level constant above for
  // the budget rationale and the truncation contract with the client).
  //
  // NOTE: `stepsJsonSize` measures the steps array only - not the assembled
  // payload. The headroom assumes the rest of `reconnect_result` stays small
  // (current fields total well under 1KB even with a verbose
  // pendingPermission). If a future field bloats that envelope, switch this
  // to measure the full payload before deciding to truncate.
  const checkpoint = execution.checkpoint as AgentCheckpoint | undefined;
  const persistedSteps: AgentStep[] = checkpoint?.steps ?? [];
  const stepsJsonSize = persistedSteps.length > 0 ? Buffer.byteLength(JSON.stringify(persistedSteps), 'utf8') : 0;

  // Child subagent snapshots. Sized independently of the parent's
  // steps so a giant parent trace doesn't drop child context, and vice-versa.
  // But both ride the same WS frame, so the budget is shared - see
  // `decideInlineBudgets`. Like `steps`, oversize children fall back to REST
  // hydration via `/api/agent-executions/[id]`.
  const childSnapshots = await buildChildExecutionSnapshots(execution.id);
  const childrenJsonSize = childSnapshots.length > 0 ? Buffer.byteLength(JSON.stringify(childSnapshots), 'utf8') : 0;
  const { includeStepsInline, includeChildrenInline } = decideInlineBudgets(stepsJsonSize, childrenJsonSize);

  // Send current state to client
  await sendAgentEvent(connectionId, endpoint, {
    action: 'reconnect_result',
    found: true,
    executionId: execution.id,
    status: execution.status,
    pendingPermission: execution.pendingPermission,
    // Confidence-gate state - clients re-render the gate UI when
    // they reconnect to a `paused` execution. `pendingGate` and `paused`
    // are written atomically by `setPendingGate`, so either both are
    // present or neither is.
    pendingGate: execution.pendingGate,
    totalCreditsUsed: execution.totalCreditsUsed,
    iterationCount: checkpoint?.iteration ?? 0,
    ...(includeStepsInline ? { steps: persistedSteps } : { stepsTruncated: true }),
    ...(childSnapshots.length === 0
      ? {}
      : includeChildrenInline
        ? { children: childSnapshots }
        : { childrenTruncated: true }),
  });

  logger.info('[Reconnect] Client reconnected', {
    executionId: execution.id,
    status: execution.status,
    stepCount: persistedSteps.length,
    stepsBytes: stepsJsonSize,
    stepsTruncated: !includeStepsInline,
    childCount: childSnapshots.length,
    childrenBytes: childrenJsonSize,
    childrenTruncated: childSnapshots.length > 0 && !includeChildrenInline,
  });
}
