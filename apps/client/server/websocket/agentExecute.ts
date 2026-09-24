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
import { adminSettingsRepository, agentExecutionRepository, sessionToolApprovalRepository } from '@bike4mind/database';
import type { AgentCheckpoint, AgentStep } from '@bike4mind/agents';
import { buildChildExecutionSnapshots } from '@server/utils/childExecutionSnapshot';
import { persistRunAsQuest } from '@server/utils/persistRunAsQuest';
import { extractFinalAnswer } from '@server/utils/extractFinalAnswer';
import { startAgentExecution } from '@server/utils/startAgentExecution';
import { resolveAndPublishMementoCompletion } from '@server/utils/publishMementoCompletion';
import { decideInlineBudgets } from '@server/websocket/reconnectBudget';
import { verifyJwtToken, checkRateLimit, verifyApiKey, checkApiKeyRateLimitOrThrow } from '@server/cli/auth';
import {
  dispatchAgentExecution,
  resolveAgentExecutorTarget,
  AgentExecutorRejectedError,
  type ExecutorTarget,
} from '@server/utils/dispatchAgentExecution';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { z } from 'zod';
import { GenerateImageToolCallSchema, AudioGenerationToolCallSchema } from '@bike4mind/common';
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
  // See `agentExecutor.schemas.ts`: marks `enabledTools` as ambient chat picks to be unioned
  // onto the resolved profile rather than a pinned selection that replaces it.
  enabledToolsAreAmbient: z.boolean().optional(),
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
  // Artifact parity with chat_completion's `enableArtifacts` body field: the caller's per-request
  // intent, which the executor ANDs with the admin `EnableArtifacts` setting via
  // `resolveArtifactsEnabled`. Absent means "no preference" (admin setting decides); only an
  // explicit `false` opts out. Persisted on the doc so continuations and dispatched children see it.
  enableArtifacts: z.boolean().optional(),
  // User's selected image-generation config (#agent-mode-image-gen). Forwarded
  // so the image_generation / edit_image tools have a model to run with - the
  // executor path otherwise passes no image config and the tool short-circuits
  // with "Image model selection required" (no picker UI exists in a headless
  // run). `.partial()` because the client may omit fields (notably `model`,
  // which is required on the base schema) - the tool defaults what's missing.
  // Consumed only by `buildSubagentToolConfig`; never enters the checkpoint, so
  // it doesn't reintroduce the prior `structuredClone` failure.
  imageConfig: GenerateImageToolCallSchema.partial().optional(),
  // User's selected audio-generation config, forwarded so the audio_generation
  // tool resolves the user's saved provider/voice/format instead of its built-in
  // defaults (the agent-mode analogue of imageConfig). Same lifecycle: consumed
  // only by `buildSubagentToolConfig`, never enters the checkpoint. `.partial()`
  // because the client may omit fields.
  audioConfig: AudioGenerationToolCallSchema.partial().optional(),
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
  // Echoed from the `permission_request`/`reconnect_result` this card rendered. Optional
  // for a client that reconnected before this field existed; when present it is what
  // `handlePermissionResponse` binds the response to instead of `toolName` alone - see
  // that function's identity check for why a name match is not enough.
  toolCallId: z.string().optional(),
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
      await handlePermissionResponse(permCmd, userId, connectionId, endpoint, logger);
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
  // Guards, document creation and Lambda dispatch are shared with the public REST
  // route (`pages/api/v1/agent-executions/index.ts`) so the two transports cannot
  // drift; this handler only translates the outcome into `agent_error` frames.
  const result = await startAgentExecution(
    {
      userId,
      sessionId: cmd.sessionId,
      questId: cmd.questId,
      query: cmd.query,
      model: cmd.model,
      connectionId,
      organizationId: cmd.organizationId,
      agentId: cmd.agentId,
      enabledTools: cmd.enabledTools,
      enabledToolsAreAmbient: cmd.enabledToolsAreAmbient,
      maxIterations: cmd.maxIterations,
      messageFileIds: cmd.messageFileIds,
      sessionFabFileIds: cmd.sessionFabFileIds,
      temperature: cmd.temperature,
      maxTokens: cmd.maxTokens,
      thinking: cmd.thinking,
      enableMementos: cmd.enableMementos,
      enableLattice: cmd.enableLattice,
      enableArtifacts: cmd.enableArtifacts,
      imageConfig: cmd.imageConfig,
      audioConfig: cmd.audioConfig,
      routingSource: cmd.routingSource,
    },
    logger
  );

  if (result.ok) return;

  await sendAgentEvent(connectionId, endpoint, {
    action: 'agent_error',
    // `concurrent_limit` is the one reason the client branches on (it renders a
    // dedicated toast rather than the generic error), so it keeps its `reason` key.
    ...(result.reason === 'concurrent_limit' ? { reason: 'concurrent_limit' } : {}),
    ...(result.executionId ? { executionId: result.executionId } : {}),
    message: result.message,
  });
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

/**
 * Persist an "Allow/Deny for Session" choice beyond this execution.
 *
 * `AgentExecution.approvedTools` only lives as long as the run; the next message starts a
 * fresh document and would re-ask. `startAgentExecution` seeds the new run from this store,
 * which is what makes "for Session" mean the notebook rather than the execution.
 *
 * Best-effort: the run is already resuming on the in-execution approval, so a write failure
 * here costs the user a repeat prompt next message, not the current turn.
 */
async function rememberToolDecision(
  sessionId: string | undefined,
  userId: string,
  toolName: string,
  decision: 'approved' | 'denied',
  logger: Logger
): Promise<void> {
  if (!sessionId) return;
  try {
    await sessionToolApprovalRepository.rememberDecision(userId, sessionId, toolName, decision);
  } catch (error) {
    logger.warn('[Permission] Could not persist the remembered decision for this session', {
      sessionId,
      toolName,
      decision,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Flip the execution to `continuing` and re-dispatch the executor. Idempotent
 * enough to call twice: `updateStatus` to the same value is a no-op, and a duplicate
 * dispatch is caught by `processExecution`'s own CAS claim on pickup (see
 * `agentExecutor.ts`'s "Atomic CAS - prevent duplicate Lambda execution"), so retrying
 * this after a failed first attempt cannot double-run the resumed work.
 *
 * Note: checkpointDepth is not carried here - it lives in the SQS message from the
 * previous Lambda handoff, not in the AgentExecution document, so this handler cannot
 * read it. The resumed Lambda starts at depth 0. This is safe on two counts: permission
 * pauses are user-driven, not loop-driven, so they cannot self-dispatch a runaway on
 * their own; and the resume runs as status `continuing`, which the executor still
 * bounds via the persisted `lambdaInvocationCount` guard (MAX_LAMBDA_HANDOFFS) - a
 * counter the message payload cannot reset.
 */
async function dispatchPermissionResume(
  executionId: string,
  connectionId: string,
  target: ExecutorTarget
): Promise<void> {
  await agentExecutionRepository.updateStatus(executionId, 'continuing');
  await dispatchAgentExecution({ executionId, connectionId }, target);
}

export async function handlePermissionResponse(
  cmd: z.infer<typeof PermissionResponseSchema>,
  userId: string,
  connectionId: string,
  endpoint: string,
  logger: Logger
): Promise<void> {
  const execution = await agentExecutionRepository.findById(cmd.executionId);
  if (!execution || execution.userId !== userId) return;

  // Recovery for a stuck `continuing` pause: an earlier call of this handler flipped
  // the status via `updateStatus` and then threw during the Lambda dispatch that
  // follows it, leaving the doc `continuing` with `pendingPermission.approved` true
  // and no Lambda running. The client retries with the same approval; that retry
  // would otherwise be dropped by the `awaiting_permission` guard below, since this
  // doc no longer satisfies it - so match it to the stuck pause here first and
  // re-drive the dispatch instead. `dispatchPermissionResume` is safe to call twice
  // (see its own docstring).
  if (
    execution.status === 'continuing' &&
    cmd.approved &&
    execution.pendingPermission?.approved === true &&
    (!execution.pendingPermission.toolCallId || cmd.toolCallId === execution.pendingPermission.toolCallId)
  ) {
    logger.warn('[Permission] Approval landed but the resume dispatch did not - retrying', {
      executionId: cmd.executionId,
      toolName: cmd.toolName,
    });
    const recoveryTarget = resolveAgentExecutorTarget();
    if (!recoveryTarget) throw new Error('Agent execution is not configured');
    await dispatchPermissionResume(cmd.executionId, connectionId, recoveryTarget);
    logger.info('[Permission] Approved - Lambda re-invoked (recovered retry)', {
      executionId: cmd.executionId,
    });
    return;
  }

  if (execution.status !== 'awaiting_permission') return;

  // Bind the response to the SPECIFIC pause it answers, not just its tool name. One
  // iteration can withhold two calls to the same tool with different arguments: the
  // first approval's replay can re-pause on the second under the same `toolName`,
  // and a still-open card for the first (or a reconnect echoing stale state) would
  // otherwise still match here and approve/deny the wrong call's arguments.
  const pendingCallId = execution.pendingPermission?.toolCallId;
  if (pendingCallId) {
    if (cmd.toolCallId !== pendingCallId) {
      logger.warn('[Permission] toolCallId mismatch - ignoring stale response', {
        executionId: cmd.executionId,
        expected: pendingCallId,
        received: cmd.toolCallId,
      });
      // A pause created by the current code always carries a toolCallId (see
      // `PermissionRequestAction`/`settleGatedCall`), so an omitted `cmd.toolCallId`
      // here is a genuinely stale tab, not just a name collision - and a silent
      // return would leave it waiting on a reply that never comes. Send the
      // current status like the "approval did not land" branch below does, so the
      // UI can leave its spinner instead of hanging until the stale sweep.
      await sendAgentEvent(connectionId, endpoint, {
        action: 'progress',
        executionId: cmd.executionId,
        status: execution.status,
      });
      return;
    }
  } else if (execution.pendingPermission && execution.pendingPermission.toolName !== cmd.toolName) {
    // Fallback for a pause persisted before `toolCallId` existed on `IPendingPermission`.
    logger.warn('[Permission] toolName mismatch — ignoring', {
      expected: execution.pendingPermission.toolName,
      received: cmd.toolName,
    });
    return;
  }

  // Deny stops the run. The gate withheld the call before it executed, so denying
  // costs nothing and leaves no side effect behind - clearing `pendingPermission`
  // discards the withheld calls unrun. Mirror the executor's own denied-tool
  // outcome: mark the run failed and emit `failed`; do NOT resume. (Previously this
  // branch fell through to the resume below, so a one-time Deny silently let the run
  // continue - the tool was only recorded when `rememberForSession` was set,
  // which the Deny button never sends.)
  if (!cmd.approved) {
    const denialMessage = `Execution stopped: you denied "${cmd.toolName}".`;
    // CAS-guarded the same way `approvePendingPermission` is (status
    // `awaiting_permission`, pause not already approved, identity-pinned on
    // `toolCallId`) - an approval for this exact pause that has already won its own
    // CAS cannot be undone by a denial racing it from another tab.
    const denied = await agentExecutionRepository.denyPendingPermission(cmd.executionId, {
      toolCallId: pendingCallId,
      deniedTool: cmd.rememberForSession ? cmd.toolName : undefined,
      errorMessage: denialMessage,
    });
    if (!denied) {
      // Lost the CAS - almost certainly to a concurrent approval for the same pause
      // that already claimed it. Nothing is left here to deny; report current status
      // like the toolCallId-mismatch branch above so the UI does not hang.
      const current = await agentExecutionRepository.findById(cmd.executionId);
      logger.warn('[Permission] Deny lost the CAS - a concurrent response already claimed this pause', {
        executionId: cmd.executionId,
        toolName: cmd.toolName,
      });
      await sendAgentEvent(connectionId, endpoint, {
        action: 'progress',
        executionId: cmd.executionId,
        status: current?.status ?? execution.status,
      });
      return;
    }
    if (cmd.rememberForSession) {
      await rememberToolDecision(execution.sessionId, userId, cmd.toolName, 'denied', logger);
    }
    await sendAgentEvent(connectionId, endpoint, {
      action: 'failed',
      executionId: cmd.executionId,
      reason: 'tool_denied',
      toolName: cmd.toolName,
      message: denialMessage,
    });
    logger.info('[Permission] Denied — execution stopped', {
      executionId: cmd.executionId,
      toolName: cmd.toolName,
    });
    return;
  }

  const executorTarget = resolveAgentExecutorTarget();
  if (!executorTarget) throw new Error('Agent execution is not configured');

  // Approved: record (optionally remembering it for the session) and resume.
  // `pendingPermission` is marked rather than cleared - it still holds the tool calls
  // the gate withheld, and the resumed executor is what finally runs them. The CAS is
  // on `awaiting_permission`, so a duplicate approval for a pause already consumed is
  // dropped here instead of replaying the tool a second time.
  const marked = await agentExecutionRepository.approvePendingPermission(cmd.executionId, {
    approvedTool: cmd.rememberForSession ? cmd.toolName : undefined,
    toolCallId: pendingCallId,
  });
  if (!marked) {
    // The CAS can lose for two different reasons that need different answers. Tell
    // them apart by re-reading the doc: if THIS exact pause is already marked
    // approved, the CAS lost to an earlier call of this same handler (a retry after
    // `updateStatus`/the Lambda invoke below failed, or the response simply arrived
    // twice) - the resume dispatch just never happened, so drive it again. Anything
    // else (a different pause entirely, or one already past `awaiting_permission`) is
    // a genuinely stale response with nothing left to resume.
    const current = await agentExecutionRepository.findById(cmd.executionId);
    // The `continuing` disjunct here covers two concurrent responses to the same
    // pause both clearing the entry-point `awaiting_permission` read before either
    // writes: the CAS winner has already flipped the status (and, past it, already
    // dispatched) by the time the loser re-reads. The invoke-throwing-after-flip
    // window is caught earlier, by the entry-point `continuing` check above - this
    // branch is only reachable for the race, so the dispatch below is a safe,
    // idempotent duplicate rather than the actual recovery for that window.
    // `claimExecution`'s CAS in agentExecutor.ts (around the "Atomic CAS - prevent
    // duplicate Lambda execution" comment) de-dupes the actual replay either way.
    const sameApprovedPauseStuck =
      (current?.status === 'awaiting_permission' || current?.status === 'continuing') &&
      current.pendingPermission?.approved === true &&
      (!pendingCallId || current.pendingPermission?.toolCallId === pendingCallId);

    if (sameApprovedPauseStuck) {
      logger.warn('[Permission] Approval landed but the resume dispatch did not - retrying', {
        executionId: cmd.executionId,
        toolName: cmd.toolName,
      });
      await dispatchPermissionResume(cmd.executionId, connectionId, executorTarget);
      logger.info('[Permission] Approved - Lambda re-invoked (recovered retry)', {
        executionId: cmd.executionId,
      });
      return;
    }

    logger.warn('[Permission] Approval did not land - the pause was already settled', {
      executionId: cmd.executionId,
      toolName: cmd.toolName,
    });
    // The card that sent this approval is waiting on a reply, and no resume is coming.
    // Send whatever the run's status actually is now so the UI leaves its spinner
    // instead of hanging until the stale sweep - the deny path always answers too.
    await sendAgentEvent(connectionId, endpoint, {
      action: 'progress',
      executionId: cmd.executionId,
      status: current?.status ?? execution.status,
    });
    return;
  }
  if (cmd.rememberForSession) {
    await rememberToolDecision(execution.sessionId, userId, cmd.toolName, 'approved', logger);
  }

  try {
    await dispatchPermissionResume(cmd.executionId, connectionId, executorTarget);
  } catch (error) {
    // A lost ACK may still have queued work. Only an explicit rejection permits rollback.
    if (error instanceof AgentExecutorRejectedError) {
      await agentExecutionRepository.restoreRejectedResume(cmd.executionId, {
        status: 'awaiting_permission',
        pendingPermission: execution.pendingPermission,
      });
    }
    throw error;
  }

  logger.info('[Permission] Approved — Lambda re-invoked', {
    executionId: cmd.executionId,
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
export async function handleGateResponse(
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
    // natural completion path fires. Resolve gates through the shared authority
    // and hand them over; the helper guards on the gates and `parentExecutionId`.
    await resolveAndPublishMementoCompletion(execution, { db: { adminSettings: adminSettingsRepository } }, logger);
    logger.info('[Gate] Stopped execution with partial answer', { executionId: cmd.executionId });
    return;
  }

  const executorTarget = resolveAgentExecutorTarget();
  if (!executorTarget) throw new Error('Agent execution is not configured');

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
  // path above. Gate resumes are user-driven and cannot cause a runaway loop on their own, and
  // are likewise bounded by the persisted `lambdaInvocationCount` guard (MAX_LAMBDA_HANDOFFS).
  try {
    await dispatchAgentExecution({ executionId: cmd.executionId, connectionId }, executorTarget);
  } catch (error) {
    // A lost ACK may still have queued work. Only an explicit rejection permits rollback.
    if (error instanceof AgentExecutorRejectedError) {
      await agentExecutionRepository.restoreRejectedResume(cmd.executionId, {
        status: 'paused',
        pendingGate: execution.pendingGate,
      });
    }
    throw error;
  }

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
    // Projected, not passed through: `pendingPermission` also stores the withheld
    // tool calls the executor replays on approval, and their arguments are
    // unbounded. Only what the permission card renders belongs in this envelope -
    // see the steps-budget note above, which assumes the rest of it stays under 1KB.
    pendingPermission: execution.pendingPermission
      ? {
          toolName: execution.pendingPermission.toolName,
          toolInput: execution.pendingPermission.toolInput,
          requestedAt: execution.pendingPermission.requestedAt,
          toolCallId: execution.pendingPermission.toolCallId,
        }
      : undefined,
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
