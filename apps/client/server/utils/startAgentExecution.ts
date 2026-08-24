/**
 * Transport-agnostic dispatch into the agent executor (ReAct) pipeline.
 *
 * The WebSocket `agent_execute` route (`@server/websocket/agentExecute.ts`) and the
 * public REST route (`pages/api/v1/agent-executions/index.ts`) both start a run, and
 * both must apply the SAME guards - session ownership, organization membership, the
 * stale-active sweep, the per-user concurrency cap - and create the SAME two documents
 * (AgentExecution + the dispatch-time prompt Quest) before invoking the executor Lambda.
 * Duplicating that across two transports is how the two drift; it lives here instead.
 *
 * The function never throws for a rejected request and never speaks HTTP or WebSocket:
 * it returns a discriminated {@link StartAgentExecutionResult} and each caller maps the
 * `reason` onto its own wire (an `agent_error` frame, or an HTTP status).
 */

import {
  agentExecutionRepository,
  organizationRepository,
  sessionRepository,
  Quest,
  type AgentExecutionStatus,
} from '@bike4mind/database';
import type { GenerateImageToolCall, AudioGenerationToolCall, IChatHistoryItem } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { MAX_CONCURRENT_EXECUTIONS_PER_USER, STALE_ACTIVE_MS } from '@server/utils/executionLimits';
import { settleStrandedQuests } from '@server/utils/settleStrandedQuests';

const lambdaClient = new LambdaClient({});

/**
 * Per-user, in-container memoization of the stale-active sweep. The sweep is an
 * `updateMany` on every start; a user firing several in quick succession would
 * otherwise pay that write each time. Module scope so it survives warm invocations.
 */
const SWEEP_MEMO_TTL_MS = 60 * 1000;
const lastSweptAtByUser = new Map<string, number>();

/**
 * Provenance of the routing decision, persisted on the dispatch-time Quest. Derived
 * from the chat-history field rather than re-listed, so this dispatcher can never
 * offer a value the Quest schema's enum would reject (a rejected write is swallowed
 * as a best-effort failure, which would silently lose the prompt bubble).
 */
type AgentExecutionRoutingSource = NonNullable<IChatHistoryItem['routingSource']>;

export type StartAgentExecutionInput = {
  userId: string;
  sessionId: string;
  /**
   * Back-reference stored on the AgentExecution doc. Historically the caller has no
   * authored Quest at dispatch time, so the WebSocket client passes the sessionId and
   * the run is grouped under its notebook. The Quest this function creates below is a
   * different id and is forwarded to the Lambda separately.
   */
  questId: string;
  query: string;
  model: string;
  /** `HEADLESS_CONNECTION_ID` (`@server/utils/headlessConnection`) when there is no WS peer. */
  connectionId: string;
  organizationId?: string;
  /**
   * Persisted IAgent id. When present the executor resolves that agent's orchestration
   * profile; when absent it builds a synthetic profile from admin defaults - or, on an
   * optimizer-surface session, the surface's own profile. That surface branch is what
   * makes agent mode reproducible from any transport without a transport-specific flag.
   */
  agentId?: string;
  enabledTools?: string[];
  maxIterations?: number;
  messageFileIds?: string[];
  sessionFabFileIds?: string[];
  temperature?: number;
  maxTokens?: number;
  thinking?: { enabled: boolean; budget_tokens?: number };
  enableMementos?: boolean;
  enableLattice?: boolean;
  /** Caller's per-request artifact intent. Absent means "no preference" (the admin
   * `EnableArtifacts` setting decides); only an explicit `false` opts out. */
  enableArtifacts?: boolean;
  imageConfig?: Partial<GenerateImageToolCall>;
  audioConfig?: Partial<AudioGenerationToolCall>;
  routingSource?: AgentExecutionRoutingSource;
};

/** Why a start was refused. Callers map these onto their own transport's errors. */
export type StartAgentExecutionFailureReason =
  'session_not_found' | 'organization_not_found' | 'concurrent_limit' | 'dispatch_failed';

export type StartAgentExecutionResult =
  | {
      ok: true;
      executionId: string;
      /** Absent when the dispatch-time Quest write failed (best-effort; see below). */
      questId?: string;
    }
  | {
      ok: false;
      reason: StartAgentExecutionFailureReason;
      /** Caller-safe message; already phrased for an end user. */
      message: string;
      /** Set only for `dispatch_failed` - the doc exists but the Lambda never started. */
      executionId?: string;
    };

export async function startAgentExecution(
  input: StartAgentExecutionInput,
  logger: Logger
): Promise<StartAgentExecutionResult> {
  const { userId } = input;

  // Validate session ownership before creating anything.
  const session = await sessionRepository.findById(input.sessionId);
  if (!session || session.userId !== userId) {
    logger.warn('[Start] Session ownership validation failed', { sessionId: input.sessionId, userId });
    return { ok: false, reason: 'session_not_found', message: 'Session not found or unauthorized' };
  }

  // Validate organization membership. Without this, a caller could pass another
  // tenant's organizationId and bill executions to that org's credit pool.
  if (input.organizationId) {
    const org = await organizationRepository.findById(input.organizationId);
    const isOwner = org?.userId === userId;
    const isManager = org?.managerId === userId;
    const isMember = org?.users?.some(u => u.userId === userId) ?? false;
    if (!org || (!isOwner && !isManager && !isMember)) {
      logger.warn('[Start] Organization membership validation failed', {
        organizationId: input.organizationId,
        userId,
      });
      return { ok: false, reason: 'organization_not_found', message: 'Organization not found or unauthorized' };
    }
  }

  // Sweep stale active executions before counting - `pending` / `running` /
  // `continuing` / `awaiting_permission` / `paused` that the executor Lambda never
  // finished (SQS handoff dropped, Lambda crashed, SST live-lambda tunnel
  // disconnected, user closed the tab on a permission card). Accumulating those locks
  // the user out of new runs. Mongoose `updatedAt` slipping past the threshold is the
  // cleanest "this is dead" signal - a healthy run writes the doc on every step.
  // `awaiting_subagent` is intentionally excluded - see `cleanupStaleActive`
  // docstring for the multi-hour-orchestration rationale.
  //
  // Memoized per user so only the first of N rapid starts pays the DB hit. The 60s
  // memo cooperates with the 20-min sweep window: it can't hide a stale execution
  // from the next sweep more than 60s past its eligibility.
  const now = Date.now();
  const lastSweptAt = lastSweptAtByUser.get(userId) ?? 0;
  if (now - lastSweptAt > SWEEP_MEMO_TTL_MS) {
    const swept = await agentExecutionRepository.cleanupStaleActive(userId, STALE_ACTIVE_MS);
    lastSweptAtByUser.set(userId, now);
    if (swept.length > 0) {
      logger.info('[Start] Swept stale active executions before count', { userId, swept: swept.length });
      // These executions are now `aborted`, which is terminal - the hourly
      // abandoned-sweep can never see them again, so this is the only chance to
      // settle the bubbles they leave behind.
      await settleStrandedQuests(swept, logger, '[Start]');
    }
  }

  // Concurrent execution cap. We count then create - a tiny race window can let one
  // extra slip in under heavy parallel start. The cap is a guard rail, not a
  // billing-grade lock; the next start sees the right count and rejects.
  const activeCount = await agentExecutionRepository.countActiveByUserId(userId);
  if (activeCount >= MAX_CONCURRENT_EXECUTIONS_PER_USER) {
    logger.info('[Start] Concurrent execution cap reached', { userId, activeCount });
    const message = `${MAX_CONCURRENT_EXECUTIONS_PER_USER} agents already running. Wait for one to finish before starting another.`;
    // Also write the rejection into chat history so the session isn't left looking
    // empty after a refresh - the live UI showed the prompt bubble + toast, but
    // without a Quest the next page load shows an empty notebook with no
    // explanation. The marker prefix keeps it visually distinct from a real reply.
    // Best-effort: a Quest write failure must not turn this rejection into an error.
    const replyText = `⚠️ **System:** ${message}`;
    try {
      await Quest.create({
        sessionId: input.sessionId,
        type: 'message',
        prompt: input.query,
        replies: [replyText],
        timestamp: new Date(),
        status: 'done',
      });
    } catch (err) {
      logger.warn('[Start] Failed to write concurrent-limit Quest - chat history will not reflect this rejection', {
        userId,
        sessionId: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ok: false, reason: 'concurrent_limit', message };
  }

  const execution = await agentExecutionRepository.create({
    userId,
    organizationId: input.organizationId,
    sessionId: input.sessionId,
    questId: input.questId,
    query: input.query,
    model: input.model,
    status: 'pending' as AgentExecutionStatus,
    connectionId: input.connectionId,
    approvedTools: [],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
    // Snapshot the forwarded context on the doc so continuation Lambdas
    // reconstruct the same first-iteration materialization.
    messageFileIds: input.messageFileIds,
    sessionFabFileIds: input.sessionFabFileIds,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    thinking: input.thinking,
    enableMementos: input.enableMementos,
    enableLattice: input.enableLattice,
    enableArtifacts: input.enableArtifacts,
    imageConfig: input.imageConfig,
    audioConfig: input.audioConfig,
  });

  const executionId = execution.id;

  // Persist the user's prompt as a Quest immediately so the bubble survives a mid-run
  // reload, and so a REST caller has a chat-history record of what it asked. The
  // completion handler (`persistRunAsQuest`) later patches `replies` onto this same
  // doc by `agentExecutionId`.
  //
  // Best-effort: a Quest write failure must not block dispatch - the AgentExecution
  // doc carries the query for the completion handler.
  let persistedQuestId: string | undefined;
  try {
    const quest = await Quest.create({
      sessionId: input.sessionId,
      type: 'message',
      prompt: input.query,
      replies: [],
      timestamp: new Date(),
      // `pending` (not `done`) so Slack completion pollers don't false-trigger on an
      // empty `replies` array between dispatch and `persistRunAsQuest`, which flips
      // this to `done` once `replies` is filled.
      status: 'pending',
      agentExecutionId: executionId,
      routingSource: input.routingSource,
    });
    const linkedQuestId = quest.id;
    persistedQuestId = linkedQuestId;
    // Persisted on the execution doc (not just forwarded in the start payload below) so a
    // resumed/checkpointed Lambda invocation still has the real Quest id available for
    // lake-access audit rows - the start payload only carries it on the first invocation. Never
    // read `execution.questId` for this purpose; that field holds the sessionId (see its own doc
    // comment). Best-effort, same as the Quest write above.
    await agentExecutionRepository.persistLinkedQuestId(executionId, linkedQuestId).catch(err =>
      logger.warn('[Start] Failed to persist linkedQuestId on AgentExecution', {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      })
    );
  } catch (err) {
    logger.warn('[Start] Failed to persist user prompt Quest - bubble will not survive a mid-run reload', {
      executionId,
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('[Start] Created execution, invoking Lambda', { executionId, persistedQuestId });

  // Invoke the Agent Executor Lambda (async - don't wait for completion). If the
  // invoke throws (throttle, IAM, network), tear down the dispatch-time Quest so we
  // don't leak a `pending` bubble with no reply and no iteration trace. The
  // AgentExecution doc lingers as `pending`; the stale-active sweep above reaps it on
  // the next start by the same user.
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: Resource.AgentExecutor.name,
        InvocationType: 'Event',
        Payload: Buffer.from(
          JSON.stringify({
            executionId,
            userId,
            sessionId: input.sessionId,
            // Only the real Quest id, never a fallback: the WS caller's `questId` is
            // the sessionId (a client-side back-ref) and would mis-key the optimistic
            // bubble swap the executor drives off this field.
            questId: persistedQuestId,
            query: input.query,
            model: input.model,
            connectionId: input.connectionId,
            organizationId: input.organizationId,
            agentId: input.agentId,
            enabledTools: input.enabledTools,
            maxIterations: input.maxIterations,
            // Forwarded here *and* persisted on the doc (above), unlike
            // `enableMementos` which is doc-only. The executor resolves
            // `startPayload?.enableLattice ?? execution.enableLattice ?? false`, so
            // this channel is defense-in-depth: the first iteration never depends on
            // the doc write having landed first.
            enableLattice: input.enableLattice,
            // Same dual channel as `enableLattice`, and for the same reason: the executor
            // resolves `startPayload?.enableArtifacts ?? execution.enableArtifacts`, so the
            // first iteration never depends on the doc write having landed first.
            enableArtifacts: input.enableArtifacts,
          })
        ),
      })
    );
  } catch (invokeErr) {
    logger.error('[Start] Lambda invoke failed - cleaning up dispatch-time Quest', {
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
    return {
      ok: false,
      reason: 'dispatch_failed',
      message: 'Failed to start agent execution. Please try again.',
      executionId,
    };
  }

  logger.info('[Start] Lambda invoked', { executionId });
  return { ok: true, executionId, questId: persistedQuestId };
}
