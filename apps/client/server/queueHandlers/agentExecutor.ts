/**
 * Agent Executor Lambda Handler
 *
 * Runs ReActAgent in an iteration loop with:
 * - Per-iteration checkpointing for Lambda self-dispatch
 * - WebSocket streaming of execution events
 * - MongoDB-based abort signal checking
 * - Credit billing per iteration (delta-based)
 * - Permission gating for sensitive tools
 * - Lambda self-dispatch via SQS for executions exceeding 15min
 *
 * Entry points:
 * 1. Direct Lambda invocation (from WebSocket route or API) - starts new execution
 * 2. SQS trigger (from agentContinuationQueue) - resumes from checkpoint
 * 3. Direct Lambda invocation with ContinuationSchema - resumes after permission response
 */

import {
  connectDB,
  sessionRepository,
  User,
  userRepository,
  adminSettingsRepository,
  organizationRepository,
  creditTransactionRepository,
  apiKeyRepository,
  fabFileRepository,
  FabFile,
  fabFileChunkRepository,
  projectRepository,
  dataLakeRepository,
  mongoose,
  agentExecutionRepository,
  agentRepository,
  mementoRepository,
  questRepository,
  latticeModelRepository,
  skillRepository,
  usageEventRepository,
  imageModerationIncidentRepository,
  mcpServerRepository,
} from '@bike4mind/database';
import { registerLambdaErrorHandlers, getSettingsByNames, fetchAgentConversationHistory } from '@bike4mind/utils';
import { toRetrievalFilter } from '@bike4mind/utils/retrievalExclusion';
import { getLlmByModel, getAvailableModels, resolveDeprecatedModelId, type ApiKeyTable } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { Permission, OPTI_SURFACE } from '@bike4mind/common';
import { accessibleBy } from '@casl/mongoose';
import defineAbilitiesFor from '@server/auth/ability';
import { missionChatTools, MISSION_CHAT_TOOL_NAMES } from '@server/deepAgent/missionChatTools';
import { premiumLlmTools } from '@server/premium-generated/premiumLlmTools.generated';
import {
  ReActAgent,
  type AgentCheckpoint,
  type AgentStep,
  type IterationResult,
  type ServerAgentDefinition,
} from '@bike4mind/agents';
import {
  getTextModelCost,
  CreditHolderType,
  ARTIFACT_EMISSION_PROMPT,
  type IAgent,
  type IUserDocument,
} from '@bike4mind/common';
import { usdToCreditsStochastic } from '@bike4mind/utils';
import {
  buildSharedTools,
  ServerAgentStore,
  ServerSubagentOrchestrator,
  PARENT_DEADLINE_BUFFER_MS,
  type ServerSubagentTracker,
  type SubagentHandoffSignal,
  type ChildExecutionStatus,
  type ToolBuilderDeps,
  type ToolBuilderCallbacks,
} from '@bike4mind/services';
import { creditService, apiKeyService } from '@bike4mind/services';
// Lattice launch-gate. `resolveLatticeTools` owns the `enableLattice` flag
// resolution and the Lattice tool contribution (names + `externalTools`
// definitions); see that module's header for the Next-tracing split and the
// continuation-fallback rationale.
import { resolveLatticeTools, buildSubagentLatticeToolPool } from './agentExecutor.latticeTools';
import { selectGatedAction } from './agentExecutorUtils/toolPermissions';
import { guardDecomposeOnce } from './agentExecutorUtils/decomposeGuard';
import { buildTruncatedRunReply } from './agentExecutorUtils/truncatedReply';
import { guardPlanCompletion, type PlanProgressState } from './agentExecutorUtils/planCompletionGuard';
import { injectBriefContext } from './agentExecutorUtils/briefContextInjector';
import { buildDagResumeReport, makeDagDispatcher, onDagNodeTerminal } from './agentExecutorDag';
import { collectDagChildArtifactBlocks } from './agentExecutor.dagArtifacts';
import type { DagHandoffSignal } from '@bike4mind/services';
// `buildFirstIterationQuery` lives in its own module so it can be
// unit-tested without dragging in this file's server-only dependency graph
// (Mongo, AWS SDK, ReActAgent, etc.). `maybeBuildFirstIterationQuery` wraps
// it with the new-execution/iteration-0 gate so the gate is testable too.
import { maybeBuildFirstIterationQuery } from './agentExecutor.firstIterationQuery';
import { toUserFacingFailureMessage } from './agentExecutor.failureMessage';
import { buildReActAgentRuntimeConfig } from './agentExecutor.reActAgentConfig';
import { buildSubagentToolConfig } from './agentExecutor.subagentToolConfig';
import {
  resolveTopLevelProfile,
  pickEffectiveMaxIterations,
  pickEffectiveEnabledTools,
  type ResolvedOrchestrationProfile,
} from './agentExecutor.orchestrationProfile';
import { buildOptiOrchestrationProfile } from './agentExecutor.optiProfile';
// Wire schemas live in their own side-effect-free module so unit tests can
// import them without dragging this file's Mongo/AWS/ReActAgent deps and the
// `registerLambdaErrorHandlers()` call into the test sandbox. See
// `agentExecutor.schemas.ts` for the schema docstrings.
import {
  StartExecutionSchema,
  ContinuationSchema,
  TaggedQueueMessageSchema,
  type StartExecutionPayload,
  type SubagentDispatchPayload,
} from './agentExecutor.schemas';
import { enforceCheckpointDepth } from './agentExecutor.checkpointDepth';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import { emitMetric } from '@server/utils/cloudwatch';
import { persistRunAsQuest } from '@server/utils/persistRunAsQuest';
import { extractFinalAnswer } from '@server/utils/extractFinalAnswer';
import { publishMementoCompletion } from '@server/utils/publishMementoCompletion';
import { getFirstIterationMementosPreamble } from '@server/utils/getFirstIterationMementosPreamble';
import { getFirstIterationSkillsPreamble } from '@server/utils/getFirstIterationSkillsPreamble';
import { getMcpClientAdapter } from '@server/utils/getMcpClientAdapter';
import { loadAgentMcpTools, type AgentMcpTools } from '@server/utils/loadAgentMcpTools';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';

registerLambdaErrorHandlers();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LAMBDA_HANDOFFS = 5;
const TIMEOUT_BUFFER_MS = 120_000; // 2-minute buffer before Lambda timeout

// Runtime defaults applied when an IAgent record lacks orchestration fields.
// Legacy IAgent records from before the unification have no
// `maxIterations` / `defaultThoroughness` - the executor still has to run
// them as subagents, so we fall back to reasonable values here rather than
// requiring a data migration.
const DEFAULT_MAX_ITERATIONS = { quick: 5, medium: 15, very_thorough: 30 } as const;
const DEFAULT_THOROUGHNESS = 'medium' as const;

/**
 * Cap for `awaiting_subagent -> continuing` self-dispatch cycles. Independent of
 * `MAX_LAMBDA_HANDOFFS` so subagent-induced handoffs don't consume the
 * runaway-iteration budget, but still bounded so a stuck dispatched child
 * can't burn through an unlimited chain of parent Lambdas. Sized generously
 * (10 handoffs x 15 min = up to ~2.5h of parent wall-clock waiting on a
 * pathologically slow child) since the legitimate case is rare.
 */
const MAX_SUBAGENT_HANDOFFS = 10;

/**
 * Number of prior quests (≈2x messages) to seed a new agent run with as conversation history, so
 * short follow-ups ("yes", "go ahead") resolve against earlier turns instead of starting amnesiac.
 * Bounded for the context window: seeded history is preserved across iterations (not trimmed), and
 * large sessions are further bounded by the context-summary boundary inside the loader. Tunable.
 */
const AGENT_HISTORY_QUEST_COUNT = 20;

// MAX_CHECKPOINT_DEPTH and CHECKPOINT_DEPTH_WARNING imported from agentExecutor.checkpointDepth
// (kept in a side-effect-free module so the thresholds can be unit-tested).

/**
 * Confidence-gate threshold for the web agent execution flow.
 * Iteration-average confidence below this triggers a pause for human review.
 * Shared default across autonomous agent flows - the value below
 * which a run is considered "not autonomous-safe". A persisted gate stalls
 * the execution in `paused` until the client responds via `gate_response`,
 * or until the stale-active sweep reaps it (`cleanupStaleActive` includes
 * `paused`).
 */
const CONFIDENCE_GATE_THRESHOLD = 0.6;

// `persistRunAsQuest` moved to `@server/utils/persistRunAsQuest` so the
// WebSocket `gate_response: stop` handler can share the same chat-history
// write contract - both code paths produce identical Quest docs.

/**
 * Convert a stored unified `IAgent` to the runtime `ServerAgentDefinition`
 * shape consumed by `ServerAgentStore` and `ServerSubagentOrchestrator`.
 *
 * Only IAgents with a non-empty `systemPrompt` are usable as subagents - chat
 * personas without a prompt are rejected upstream by `pickRunnableAgents()`.
 * Orchestration fields fall back to runtime defaults when absent so legacy
 * IAgent records (created before orchestration fields were unified) still run.
 */
function toServerAgentDefinition(agent: IAgent): ServerAgentDefinition {
  return {
    name: agent.name,
    description: agent.description,
    model: agent.preferredModel ?? '',
    systemPrompt: agent.systemPrompt ?? '',
    allowedTools: agent.allowedTools,
    deniedTools: agent.deniedTools,
    maxIterations: agent.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    defaultThoroughness: agent.defaultThoroughness ?? DEFAULT_THOROUGHNESS,
    defaultVariables: agent.defaultVariables,
    exclusiveMcpServers: agent.exclusiveMcpServers,
    fallbackModels: agent.fallbackModels,
  };
}

/**
 * Filter to IAgents that have enough configuration to run as a subagent.
 * Requires `systemPrompt` AND `preferredModel` - chat-only personas (no
 * prompt) and agents without a model selection are not runnable as
 * subagents and would otherwise blow up `getLlmByModel` at execution time.
 */
function pickRunnableAgents(agents: IAgent[]): IAgent[] {
  return agents.filter(a => Boolean(a.systemPrompt) && Boolean(a.preferredModel));
}

// ---------------------------------------------------------------------------
// Cached resources (warm Lambda reuse)
// ---------------------------------------------------------------------------

let cachedDbConnection: typeof mongoose.connection | null = null;
const sqsClient = new SQSClient({});

// ---------------------------------------------------------------------------
// WebSocket streaming helpers
// ---------------------------------------------------------------------------

function createWsSender(connectionId: string, logger: Logger) {
  const wsEndpoint = Resource.websocket.managementEndpoint;
  const client = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });

  return async (action: string, payload: Record<string, unknown> = {}) => {
    try {
      await client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify({ action, ...payload })),
        })
      );
    } catch (err) {
      // Connection may be stale - log but don't fail the execution
      logger.warn(`[WS] Failed to send ${action} to ${connectionId}:`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Constants shared across in-process and dispatched paths
// ---------------------------------------------------------------------------

/**
 * API Gateway WebSocket frames have a 128KB hard limit. Tool observations
 * (web search, file reads) can blow past that, and `createWsSender` swallows
 * send errors so oversized frames silently drop. Truncate at the same 2KB
 * ceiling `summarizeResult()` uses to keep behaviour predictable.
 */
const MAX_STEP_CONTENT = 2_000;

/** Polling cadence for dispatched-child status. Start fast, back off exponentially. */
const POLL_INITIAL_MS = 2_000;
const POLL_MAX_MS = 30_000;

/**
 * How often `processSubagentDispatch` checks whether the parent has aborted
 * the dispatched child. Short relative to thoroughness budgets so cascade-abort
 * has a bounded latency. Setting too low is wasteful (DB reads); too high
 * widens the window where an aborted child keeps running.
 */
const SUBAGENT_ABORT_POLL_MS = 5_000;

// ---------------------------------------------------------------------------
// Subagent handoff helpers
// ---------------------------------------------------------------------------

/**
 * Poll a child execution until it reaches a terminal state, then inject its result
 * into the parent agent's message history. If the parent's NEW Lambda also runs out
 * of time while the child is still running, the parent persists `awaiting_subagent`
 * again and self-dispatches - bounded by the soft `subagentHandoffCount` so a
 * never-finishing child can't burn through the parent's whole lifecycle silently.
 *
 * Returns `true` when the child result was successfully injected and the iteration
 * loop should proceed. Returns `false` when the helper has already terminated the
 * execution (self-dispatch, child failed unrecoverably) and the caller should exit.
 */
async function resumeAfterSubagentHandoff(args: {
  executionId: string;
  connectionId: string;
  waitingOnChild: {
    childExecutionId: string;
    agentName: string;
    toolUse: { id: string; name: string; arguments: string };
    dispatchedAt: Date;
  };
  agent: ReActAgent;
  sendWs: (action: string, payload?: Record<string, unknown>) => Promise<void>;
  context: Context;
  logger: Logger;
  checkpointDepth: number;
}): Promise<boolean> {
  const { executionId, connectionId, waitingOnChild, agent, sendWs, context, logger, checkpointDepth } = args;
  let delay = POLL_INITIAL_MS;

  await sendWs('progress', {
    executionId,
    status: `Resuming after subagent handoff (${waitingOnChild.agentName})…`,
  });

  while (true) {
    // Parent abort while waiting - cascade to child and fail.
    const aborted = await agentExecutionRepository.checkAbortFlag(executionId);
    if (aborted) {
      await agentExecutionRepository.setAbortFlag(waitingOnChild.childExecutionId).catch(() => {});
      await agentExecutionRepository.markAborted(executionId);
      await sendWs('failed', { executionId, reason: 'aborted' });
      return false;
    }

    // Self-dispatch again if parent is about to run out of time.
    if (context.getRemainingTimeInMillis() < PARENT_DEADLINE_BUFFER_MS) {
      await agentExecutionRepository.updateStatus(executionId, 'awaiting_subagent');
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: Resource.agentContinuationQueue.url,
          MessageBody: JSON.stringify({
            kind: 'continuation',
            executionId,
            connectionId,
            checkpointDepth: checkpointDepth + 1,
          }),
        })
      );
      await sendWs('resumed', { executionId, reason: 'subagent_handoff' });
      logger.info('[Handoff] Parent ran out of time during resume; re-handing off', {
        childExecutionId: waitingOnChild.childExecutionId,
      });
      return false;
    }

    // Lean projection - `result.answer` is what we inject; `checkpoint`,
    // `steps[]`, and `iterationBilling[]` aren't needed here and can be large.
    const child = await agentExecutionRepository.getPollableStatus(waitingOnChild.childExecutionId);
    if (!child) {
      await agentExecutionRepository.markFailed(executionId, {
        message: `Subagent execution ${waitingOnChild.childExecutionId} disappeared while parent was waiting`,
      });
      await sendWs('failed', { executionId, reason: 'subagent_missing' });
      return false;
    }

    if (child.status === 'completed' || child.status === 'failed' || child.status === 'aborted') {
      const result = (child.result as { answer?: string } | undefined)?.answer;
      // Don't inject raw error messages into the LLM's context: they can carry
      // DB connection strings, internal paths, or stack fragments that the LLM
      // might surface in its final answer. The terminal status alone is enough
      // signal for the parent agent to course-correct. The full error is still
      // available on the child doc for server-side debugging.
      const observation =
        child.status === 'completed'
          ? (result ?? `Subagent "${waitingOnChild.agentName}" completed with no answer.`)
          : child.status === 'aborted'
            ? `Subagent "${waitingOnChild.agentName}" was aborted.`
            : `Subagent "${waitingOnChild.agentName}" failed. Consider an alternative approach or escalating.`;

      try {
        agent.replaceLastToolResultObservation(waitingOnChild.toolUse.id, observation);
      } catch (err) {
        // The backend may not support replaceLastToolResultObservation, or the
        // placeholder block may have been pruned. Fail loud so we don't silently
        // resume with stale tool history.
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('[Handoff] replaceLastToolResultObservation failed', { error: errMsg });
        await agentExecutionRepository.markFailed(executionId, {
          message: `Resume after subagent handoff failed: ${errMsg}`,
        });
        await sendWs('failed', { executionId, reason: 'subagent_resume_error' });
        return false;
      }

      // Conditional on the parent NOT being aborted - see clearWaitingOnChild
      // docstring for the race scenario. If a late abort landed while we were
      // polling, this returns false and we bail out cleanly.
      const cleared = await agentExecutionRepository.clearWaitingOnChild(executionId);
      if (!cleared) {
        logger.info('[Handoff] Parent was aborted during resume — bailing out');
        await sendWs('failed', { executionId, reason: 'aborted' });
        return false;
      }
      logger.info('[Handoff] Child terminal — injected observation and resuming iteration', {
        childExecutionId: waitingOnChild.childExecutionId,
        childStatus: child.status,
      });
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

// ---------------------------------------------------------------------------
// Payload detection
// ---------------------------------------------------------------------------

function isStartPayload(event: Record<string, unknown>): boolean {
  return 'query' in event && 'sessionId' in event && 'model' in event;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handler = async (event: Record<string, unknown> | SQSEvent, context: Context) => {
  const logger = new Logger({ metadata: { handler: 'agentExecutor' } });

  // Connect to MongoDB (reuse warm connection)
  if (!cachedDbConnection || mongoose.connection.readyState !== 1) {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
    cachedDbConnection = mongoose.connection;
  }

  // Determine invocation type: SQS (continuation), direct start, or direct continuation
  const isSqsEvent = 'Records' in event && Array.isArray(event.Records);

  let executionId: string;
  let connectionId: string;
  let isNewExecution: boolean;
  let startPayload: StartExecutionPayload | undefined;

  if (isSqsEvent) {
    // Process all SQS records, not just the first. The queue is subscribed with
    // batch.partialResponses: true, so a per-record failure is reported via
    // batchItemFailures instead of swallowed, letting SQS retry/DLQ just that record.
    const sqsEvent = event as SQSEvent;
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of sqsEvent.Records) {
      // Per-record try/catch so a poison message (malformed JSON, schema
      // mismatch) doesn't take down the rest of the batch. SQS's own DLQ
      // mechanism takes over after `maxReceiveCount` retries (currently 3).
      try {
        const body = JSON.parse(record.body);
        // Route by discriminator when present (subagent_dispatch vs continuation),
        // with a legacy fallback for in-flight messages that pre-date the
        // discriminator.
        // TODO: drop the legacy fallback ~14 days after this ships (queue
        // messages age out at the 16-min visibility timeout; no in-flight
        // message lasts more than a few days even under DLQ retries).
        if (typeof body === 'object' && body !== null && 'kind' in body) {
          const tagged = TaggedQueueMessageSchema.parse(body);
          if (tagged.kind === 'subagent_dispatch' || tagged.kind === 'dag_node_dispatch') {
            // DAG nodes are mechanically identical to subagent dispatches -
            // they're stored as child docs with `subagentConfig` set. The
            // routing distinction only matters for the completion hook, which
            // `processSubagentDispatch` fires post-markComplete by checking
            // whether the child has a `dagNodeId`.
            await processSubagentDispatch(
              tagged.childExecutionId,
              tagged.connectionId,
              context,
              logger,
              'depth' in tagged ? tagged.depth : undefined
            );
          } else {
            await processExecution(
              tagged.executionId,
              tagged.connectionId,
              false,
              undefined,
              context,
              logger,
              tagged.checkpointDepth ?? 0
            );
          }
        } else {
          const continuation = ContinuationSchema.parse(body);
          await processExecution(
            continuation.executionId,
            continuation.connectionId,
            false,
            undefined,
            context,
            logger,
            continuation.checkpointDepth ?? 0
          );
        }
      } catch (recordErr) {
        logger.error('[SQS] Failed to process record — continuing batch', {
          messageId: record.messageId,
          error: recordErr instanceof Error ? recordErr.message : String(recordErr),
        });
        // Report this record as failed so SQS retries/DLQs it; keep processing the
        // rest. The continuation is CAS-guarded (processExecution claims the
        // execution before mutating it), so a retry-driven redelivery is safe.
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  } else if (isStartPayload(event as Record<string, unknown>)) {
    // Distinguish start vs continuation by payload shape
    startPayload = StartExecutionSchema.parse(event);
    executionId = startPayload.executionId;
    connectionId = startPayload.connectionId;
    isNewExecution = true;
  } else {
    // Continuation payload (from permission response re-invoke)
    const continuation = ContinuationSchema.parse(event);
    executionId = continuation.executionId;
    connectionId = continuation.connectionId;
    isNewExecution = false;
  }

  await processExecution(executionId, connectionId, isNewExecution, startPayload, context, logger);
};

// ---------------------------------------------------------------------------
// Core execution logic
// ---------------------------------------------------------------------------

/**
 * Load the user's enabled MCP servers' tools, degrading to none on failure.
 * Shared by the top-level and re-dispatch handlers (each runs in its own Lambda
 * invocation). agent_executor never touched mcpServerRepository before this
 * wiring, so a transient DB error here must not take down runs that use no MCP
 * tools (mirrors the userAgents/orgAgents fallbacks in each caller).
 */
async function loadMcpToolsSafe(userId: string, logger: Logger): Promise<AgentMcpTools> {
  const enableMCPServer = (await adminSettingsRepository.getSettingsValue('EnableMCPServer')) ?? false;
  try {
    return await loadAgentMcpTools(
      { mcpServers: mcpServerRepository, getMcpClient: getMcpClientAdapter, logger },
      { userId, enableMCPServer }
    );
  } catch (err) {
    logger.warn('[AgentExecutor][MCP] Failed to load MCP tools; continuing without MCP overlay', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { mcpToolsByServer: {}, serverAgentConfig: {} };
  }
}

async function processExecution(
  executionId: string,
  connectionId: string,
  isNewExecution: boolean,
  startPayload: StartExecutionPayload | undefined,
  context: Context,
  logger: Logger,
  checkpointDepth: number = 0
): Promise<void> {
  logger.updateMetadata({ executionId });
  const sendWs = createWsSender(connectionId, logger);

  // Depth guard: refuse to process if this execution has self-dispatched too many times.
  // A runaway agent (infinite tool loop, stuck abort signal) would otherwise chain Lambdas
  // indefinitely. Must stay above the DB load below - terminating before any DB work is the
  // point of the guard. The guard itself lives in agentExecutor.checkpointDepth.ts so its
  // thresholds and side effects can be unit-tested without this module's Mongo/AWS/SST deps.
  const terminated = await enforceCheckpointDepth(checkpointDepth, {
    executionId,
    logger,
    emitMetric,
    markFailed: agentExecutionRepository.markFailed.bind(agentExecutionRepository),
    sendWs,
  });
  if (terminated) return;

  try {
    // Load execution document
    const execution = await agentExecutionRepository.findById(executionId);
    if (!execution) {
      throw new Error(`AgentExecution ${executionId} not found`);
    }

    // Check abort before starting
    if (execution.abortedAt) {
      logger.info('[Abort] Execution was aborted before Lambda started');
      await agentExecutionRepository.markAborted(executionId);
      await sendWs('failed', { executionId, reason: 'aborted' });
      return;
    }

    // Atomic CAS - prevent duplicate Lambda execution.
    // New: also accept `awaiting_subagent -> running` so the continuation Lambda can
    // resume after a sync subagent-handoff. The resume logic below detects this case
    // by checking `execution.waitingOnChild`.
    const isSubagentResume = !isNewExecution && execution.status === 'awaiting_subagent';
    // Phase 4a - accept `awaiting_dag_children -> running` so the continuation
    // Lambda woken by the last-child completion hook can resume the parent.
    const isDagResume = !isNewExecution && execution.status === 'awaiting_dag_children';
    const expectedStatuses = isNewExecution
      ? (['pending'] as const)
      : isSubagentResume
        ? (['awaiting_subagent'] as const)
        : isDagResume
          ? (['awaiting_dag_children'] as const)
          : (['continuing'] as const);
    const targetStatus = 'running';
    const claimed = await agentExecutionRepository.claimExecution(executionId, [...expectedStatuses], targetStatus);
    if (!claimed) {
      logger.warn('[CAS] Another Lambda already claimed this execution, exiting gracefully', {
        expectedStatuses,
        actualStatus: execution.status,
      });
      return;
    }

    await agentExecutionRepository.updateConnectionId(executionId, connectionId);

    // Load user
    const user = await User.findById(execution.userId);
    if (!user) throw new Error(`User ${execution.userId} not found`);

    // Validate session ownership
    const session = await sessionRepository.findById(execution.sessionId);
    if (!session) throw new Error(`Session ${execution.sessionId} not found`);
    if (session.userId !== execution.userId) {
      logger.error('[Auth] Session ownership mismatch', {
        sessionUserId: session.userId,
        executionUserId: execution.userId,
      });
      await agentExecutionRepository.markFailed(executionId, {
        message: 'Session ownership validation failed',
      });
      await sendWs('failed', { executionId, reason: 'unauthorized' });
      return;
    }

    // Load organization if applicable
    const organization = execution.organizationId
      ? await organizationRepository.findById(execution.organizationId)
      : null;

    // If continuation, increment Lambda invocation count and check cap.
    // Subagent resumes (awaiting_subagent -> running) bump `subagentHandoffCount`
    // instead so they don't consume the runaway-iteration `MAX_LAMBDA_HANDOFFS`
    // budget that protects against agents that never finish.
    if (!isNewExecution) {
      if (isSubagentResume) {
        const subagentHandoffCount = await agentExecutionRepository.incrementSubagentHandoffCount(executionId);
        if (subagentHandoffCount > MAX_SUBAGENT_HANDOFFS) {
          // A dispatched child that never finishes (e.g., its Lambda was killed
          // mid-run leaving status `running` with no recovery) would otherwise
          // chain parent Lambdas indefinitely - each resume polls the stuck
          // child, runs out of time, and self-dispatches again. Cap the chain
          // and fail the parent so the user gets a terminal event.
          logger.warn(`[Handoff] Max subagent handoffs (${MAX_SUBAGENT_HANDOFFS}) exceeded`, {
            subagentHandoffCount,
            waitingOnChild: execution.waitingOnChild?.childExecutionId,
          });
          await agentExecutionRepository.markFailed(executionId, {
            message: `Execution exceeded maximum subagent handoffs (${MAX_SUBAGENT_HANDOFFS}) — dispatched subagent appears stuck`,
          });
          await sendWs('failed', { executionId, reason: 'max_subagent_handoffs_exceeded' });
          return;
        }
        await sendWs('resumed', { executionId, reason: 'subagent_handoff', subagentHandoffCount });
      } else {
        const invocationCount = await agentExecutionRepository.incrementLambdaInvocationCount(executionId);
        if (invocationCount > MAX_LAMBDA_HANDOFFS) {
          logger.warn(`[Handoff] Max Lambda handoffs (${MAX_LAMBDA_HANDOFFS}) exceeded`);
          await agentExecutionRepository.markFailed(executionId, {
            message: `Execution exceeded maximum Lambda handoffs (${MAX_LAMBDA_HANDOFFS})`,
          });
          await sendWs('failed', { executionId, reason: 'max_handoffs_exceeded' });
          return;
        }
        await sendWs('resumed', { executionId, invocationCount });
      }
    } else {
      // Forward the persisted Quest id (created in `agentExecute.handleStart`)
      // so the client can swap its optimistic prompt bubble's fake id for the
      // stable, server-side one - needed for the bubble to survive a mid-run
      // reload. Omitted if the Quest write failed at dispatch.
      await sendWs('execution_started', {
        executionId,
        ...(startPayload?.questId ? { questId: startPayload.questId } : {}),
      });
    }

    // Get API keys and LLM backend
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(execution.userId, {
      db: {
        apiKeys: apiKeyRepository,
        adminSettings: adminSettingsRepository,
      },
      getSettingsByNames,
    });

    const models = await getAvailableModels(apiKeyTable as ApiKeyTable);
    // Upgrade a deprecated/retired model id to its modern equivalent before lookup. getAvailableModels
    // filters retired ids out, so an agent/session still pinned to a sunset snapshot would otherwise
    // miss the lookup and throw instead of running on the mapped replacement.
    const resolvedModelId = resolveDeprecatedModelId(execution.model, 'agentExecutor');
    const modelInfo = models.find((m: { id: string }) => m.id === resolvedModelId);
    const llm = getLlmByModel(apiKeyTable as ApiKeyTable, { modelInfo, logger, endUserId: execution.userId });
    if (!llm) throw new Error(`Failed to create LLM backend for model "${execution.model}"`);
    llm.currentModel = resolvedModelId;

    // Pre-flight credit check
    const userCredits = (user as IUserDocument).currentCredits ?? 0;
    const orgCredits = organization?.currentCredits ?? 0;
    const availableCredits = organization ? orgCredits : userCredits;
    if (availableCredits <= 0) {
      logger.warn('[Credits] Insufficient credits to start execution', { availableCredits });
      await agentExecutionRepository.markFailed(executionId, {
        message: 'Insufficient credits to run agent execution',
      });
      await sendWs('failed', { executionId, reason: 'insufficient_credits' });
      return;
    }

    // Resolve the top-level orchestration profile. Two paths:
    //   - `startPayload.agentId` set -> load the persisted IAgent and project
    //     its orchestration fields onto the profile (`@agent` literal trigger).
    //   - `startPayload.agentId` absent -> build a synthetic default profile
    //     from admin `orchestrationDefaults` (Agent-mode toggle path).
    //
    // The profile drives `enabledTools` and `maxIterations` defaults only when
    // the payload doesn't pin them explicitly - the existing `@mention` flow
    // ships those fields directly and so its behavior is unchanged.
    //
    // Resolved only on new executions; continuations carry forward whatever the
    // first invocation set up (checkpoint replay restores agent state).
    let orchestrationProfile: ResolvedOrchestrationProfile | undefined;
    // Optimizer surface with no pinned `@agent`: use the opti-scoped profile (optimizer
    // tools only, image-gen/delegation denied, higher iteration ceiling, ReAct loop
    // prompt) instead of the generic synthetic default. Resolved on continuations too,
    // NOT just new executions: it's a deterministic function of the persisted
    // `session.surface`, and the tool list is rebuilt on every Lambda invocation, so a
    // post-permission / post-timeout resume (isNewExecution=false, no startPayload) would
    // otherwise collapse the toolbelt to mission-only and the loop could no longer
    // formulate/schedule to advance the ladder. An explicit `@agent` mention still wins
    // on the initial send (it sets `startPayload.agentId` -> the persisted-agent path).
    if (!startPayload?.agentId && session.surface === OPTI_SURFACE) {
      orchestrationProfile = buildOptiOrchestrationProfile();
    } else if (isNewExecution) {
      // `getSettingsValue<K>` is generic-narrowed to `SettingValue<K>` -
      // `OrchestrationDefaults` here - so no cast is needed.
      const orchestrationDefaults = await adminSettingsRepository
        .getSettingsValue('orchestrationDefaults')
        .catch(err => {
          logger.warn('[Orchestration] Failed to load orchestrationDefaults; using built-in fallbacks', {
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        });
      orchestrationProfile = await resolveTopLevelProfile({
        agentId: startPayload?.agentId,
        loadAgent: async (id: string) => {
          try {
            const stored = await agentRepository.findById(id);
            if (!stored) return null;
            // Reject soft-deleted records - `IAgent.deletedAt` is the soft-delete
            // marker; the persisted-agent path should not resurrect them.
            if (stored.deletedAt) return null;
            // Authz: user-scoped records require an owner match; org-scoped records
            // require an org match. System agents (`isSystem: true`) have neither
            // `userId` nor `organizationId` set and are intentionally accessible
            // to any caller - both guards short-circuit on the falsy side.
            if (stored.userId && stored.userId !== execution.userId) return null;
            if (stored.organizationId && stored.organizationId !== execution.organizationId) return null;
            return stored;
          } catch (err) {
            logger.warn('[Orchestration] Failed to load IAgent; falling back to synthetic profile', {
              agentId: id,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          }
        },
        adminDefaults: orchestrationDefaults,
        model: execution.model,
      });
    }
    if (orchestrationProfile) {
      logger.info('[Orchestration] Resolved profile', {
        profileId: orchestrationProfile.id,
        profileName: orchestrationProfile.name,
        isSynthetic: orchestrationProfile.isSynthetic,
        allowedToolCount: orchestrationProfile.allowedTools.length,
        defaultThoroughness: orchestrationProfile.defaultThoroughness,
        isContinuation: !isNewExecution,
      });
    }

    // Build tools - per-request agent store (unified agent model).
    // Built-in factory agents are always present; user-scoped and org-scoped
    // IAgent records are overlaid on top. Precedence on name collision:
    // org > user > built-in (see ServerAgentStore).
    let userAgents: ServerAgentDefinition[] = [];
    let orgAgents: ServerAgentDefinition[] = [];
    try {
      const userStored = await agentRepository.listForUser(execution.userId);
      userAgents = pickRunnableAgents(userStored).map(toServerAgentDefinition);
    } catch (err) {
      // Don't fail execution if user agents can't be loaded - fall back to built-ins + org.
      logger.warn('[AgentStore] Failed to load user agents; continuing without user overlay', {
        userId: execution.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (execution.organizationId) {
      try {
        const orgStored = await agentRepository.listForOrganization(execution.organizationId);
        orgAgents = pickRunnableAgents(orgStored).map(toServerAgentDefinition);
      } catch (err) {
        logger.warn('[AgentStore] Failed to load org agents; continuing without org overlay', {
          organizationId: execution.organizationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Load the user's enabled MCP servers' tools so delegated subagents
    // (e.g. project_manager -> atlassian) actually receive them. Agent Mode had
    // NO MCP wiring, so exclusive-MCP subagents spawned with 0 tools and the
    // model fabricated results. Mirrors ChatCompletionProcess's buildMcpTools.
    const { mcpToolsByServer, serverAgentConfig } = await loadMcpToolsSafe(execution.userId, logger);
    const agentStore = new ServerAgentStore(serverAgentConfig, { userAgents, orgAgents });
    // MCP servers claimed exclusively by an agent (e.g. atlassian by
    // project_manager). Withheld from the parent LLM's tool list; reach the
    // delegated subagent via buildSharedTools' internal parentTools closure.
    const agentOnlyMcpServers = agentStore.getExclusiveMcpServers();
    // An agent that EXCLUSIVELY claims a server spawns with 0 tools if that server produced none
    // (disabled / no cached schemas / load failed) - the exact failure this fix targets. Surface it
    // by server name so it is not a silent fabrication again.
    const missingExclusive = agentOnlyMcpServers.filter(s => !mcpToolsByServer[s]?.length);
    if (missingExclusive.length > 0) {
      logger.warn(
        '[AgentExecutor][MCP] Exclusive MCP server(s) loaded 0 tools - dependent subagents will spawn empty-handed',
        {
          missingExclusive,
        }
      );
    }
    logger.info(
      `[AgentStore] Loaded ${agentStore.getAllAgents().length} agents (user: ${userAgents.length}, org: ${orgAgents.length})`,
      {
        userNames: userAgents.map(a => a.name),
        orgNames: orgAgents.map(a => a.name),
      }
    );

    const subagentTracker: ServerSubagentTracker = {
      onStart: async info => {
        // Background children are treated as TOP-LEVEL for cap/billing purposes:
        // they outlive their parent and bill independently. The parent link is
        // preserved via `spawnedByExecutionId` for audit + abort cascade.
        //
        // Lambda-dispatched (sync) children + in-process children both get
        // `parentExecutionId` set so the existing "exclude children from cap"
        // query naturally excludes them.
        const baseFields = {
          userId: execution.userId,
          organizationId: execution.organizationId,
          sessionId: execution.sessionId,
          questId: execution.questId,
          query: info.task,
          model: info.model,
          approvedTools: [] as string[],
          deniedTools: [] as string[],
          iterationBilling: [],
          totalCreditsUsed: 0,
          lambdaInvocationCount: 1,
          childExecutionIds: [] as string[],
          startedAt: new Date(),
          connectionId,
          // Persist the agent identity at creation time so the replay/reconnect
          // path can resurface "X - running" / "X - completed" without relying
          // on the in-memory `subagent_started` WS event. Lambda-dispatched
          // children get `subagentConfig` overwritten by `onLambdaDispatch`
          // anyway (same keys, broader payload), so this is a no-op for them.
          // Without this, in-process children land in Mongo with no persisted
          // `agentName` and `SubagentStepNest` falls back to "Subagent" after
          // refresh.
          subagentConfig: {
            agentName: info.agentName,
            thoroughness: info.thoroughness,
            maxIterations: info.maxIterations,
          },
          // Inherit the parent's image config. Unlike
          // `enableLattice` below, this is a tool-capability setting, not a
          // launch-gate: a subagent that generates images should reach for the
          // same model the parent resolved, otherwise `processSubagentDispatch`
          // reads `child.imageConfig === undefined` and the `image_generation` /
          // `edit_image` tools short-circuit with "Image model selection
          // required" (no picker UI in a headless run). Omitted when the parent
          // had none, so the tool falls back to its built-in default.
          ...(execution.imageConfig && { imageConfig: execution.imageConfig }),
          // NOTE: `enableLattice` (and other parent-only launch-gate flags) is
          // intentionally omitted here - subagents / DAG children do NOT inherit
          // it. The parent's Lattice toolbelt is scoped to the parent run; a
          // child that needs Lattice must be granted it explicitly. A future PR
          // adding a sibling flag should make the same deliberate choice.
        };

        // Three execution modes mapped to schema state:
        //
        //   in-process (running, parentExecutionId set) - agent runs in THIS lambda
        //   sync Lambda dispatch (pending, parentExecutionId set) - dispatched lambda
        //     CAS-claims pending -> running
        //   background (pending, NO parentExecutionId, isBackgroundExecution: true,
        //     spawnedByExecutionId set) - counts independently in the cap, bills
        //     independently, and outlives the parent
        //
        // `info.willDispatchToLambda` is set by the orchestrator: true for both
        // `dispatchBackgroundAgent` and `dispatchAndPollSubagent`, false for the
        // in-process path. See `ServerSubagentOrchestrator.shouldDispatchToLambda`
        // for the heuristic that picks the path.
        const initialStatus = info.willDispatchToLambda ? 'pending' : 'running';

        const child = await agentExecutionRepository.create(
          info.isBackground
            ? {
                ...baseFields,
                status: initialStatus,
                isBackgroundExecution: true,
                spawnedByExecutionId: executionId,
              }
            : {
                ...baseFields,
                status: initialStatus,
                // Use the direct parent id when provided (grandchildren);
                // fall back to the closed-over top-level id for direct children.
                parentExecutionId: info.parentExecutionId ?? executionId,
              }
        );
        if (!info.isBackground) {
          await agentExecutionRepository.addChildExecution(info.parentExecutionId ?? executionId, child.id);
        }
        await sendWs('subagent_started', {
          executionId,
          parentExecutionId: info.parentExecutionId ?? executionId,
          childExecutionId: child.id,
          agentName: info.agentName,
          model: info.model,
          thoroughness: info.thoroughness,
          maxIterations: info.maxIterations,
          isBackground: info.isBackground,
        });
        return child.id;
      },
      onStep: async ({ childExecutionId, agentName, step, iteration }) => {
        const truncatedStep =
          step.content.length > MAX_STEP_CONTENT
            ? { ...step, content: step.content.slice(0, MAX_STEP_CONTENT) + '\n\n...(truncated)' }
            : step;
        await sendWs('subagent_iteration_step', {
          executionId,
          childExecutionId,
          agentName,
          iteration,
          step: truncatedStep,
        });
      },
      // Forward streaming token deltas so the parent UI renders partial subagent
      // responses live within each iteration. Fire-and-forget so a slow
      // WS send cannot stall the agent loop - the orchestrator already wraps
      // this in .catch(), but we also avoid awaiting here to keep the LLM
      // callback non-blocking.
      //
      // Defense-in-depth: split deltas larger than MAX_STEP_CONTENT into
      // multiple frames so a pathological chunk (e.g., a buffering adapter
      // coalescing many tokens, or a single large code block) cannot exceed
      // the 128KB API Gateway frame limit and get silently dropped by
      // `createWsSender`. Reuses the same ceiling `onStep` enforces.
      onTextDelta: async ({ childExecutionId, agentName, iteration, delta }) => {
        for (let offset = 0; offset < delta.length; offset += MAX_STEP_CONTENT) {
          const chunk = delta.slice(offset, offset + MAX_STEP_CONTENT);
          await sendWs('subagent_text_delta', {
            executionId,
            childExecutionId,
            agentName,
            iteration,
            delta: chunk,
          });
        }
      },
      onChildProgress: async ({ childExecutionId, status }) => {
        await sendWs('subagent_progress', {
          executionId,
          childExecutionId,
          status,
        });
      },
      onComplete: async ({ childExecutionId, result }) => {
        // Only in-process subagents reach this hook - `dispatchAndPollSubagent` in
        // the orchestrator returns directly without calling `onComplete`, and
        // `dispatchBackgroundAgent` never runs to completion in this Lambda. So
        // here the child is always still `running` and we own the terminal write.
        const credits = result.completionInfo.totalCredits ?? 0;
        await agentExecutionRepository.markComplete(childExecutionId, {
          answer: result.finalAnswer,
          steps: result.steps,
          totalTokens: result.completionInfo.totalTokens,
          totalIterations: result.completionInfo.iterations,
          reachedMaxIterations: result.completionInfo.reachedMaxIterations,
          totalCredits: credits,
        });
        // In-process subagents are by definition NOT background (background always
        // dispatches), so the rollup applies - match PR 1's behaviour. The rollup
        // updates the parent's audit counter only; `creditService.deductCreditsWithOrgSupport`
        // is not yet called for subagent tokens (Phase 1 known gap).
        if (credits > 0) {
          await agentExecutionRepository.incrementCreditsUsed(executionId, credits);
        }
        await sendWs('subagent_completed', {
          executionId,
          childExecutionId,
          agentName: result.agentName,
          totalCredits: credits,
          iterations: result.completionInfo.iterations ?? 0,
          finalAnswer: result.finalAnswer,
        });
      },
      onFailure: async ({ childExecutionId, error, isTimeout, partialResult }) => {
        // Symmetric with `onComplete`: only fires for in-process subagents.
        // Persist the raw error for server-side debugging, but never forward it to
        // the client - raw `Error.message` can leak internal paths, DB connection
        // info, or stack fragments. `timedOut` is a typed signal so downstream
        // consumers don't substring-match `message`.
        await agentExecutionRepository.markFailed(childExecutionId, { message: error, timedOut: isTimeout });
        await sendWs('subagent_failed', {
          executionId,
          childExecutionId,
          error: isTimeout ? 'Subagent timed out' : 'Subagent execution failed',
          isTimeout,
          partialAnswer: partialResult?.finalAnswer,
        });
      },
      onLambdaDispatch: async ({ childExecutionId, subagentConfig, depth }) => {
        // Persist the agent config snapshot on the child doc - the dispatched
        // Lambda reads this to resolve the agent definition + reconstruct the agent.
        await agentExecutionRepository.setSubagentConfig(childExecutionId, subagentConfig);

        // Reuse the continuation queue with a discriminator. SQS visibility timeout
        // is 16min (> 15min Lambda) so the dispatched Lambda has a full budget. IAM
        // grant `sqs:SendMessage -> agentContinuationQueue.arn` already exists.
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: Resource.agentContinuationQueue.url,
            MessageBody: JSON.stringify({
              kind: 'subagent_dispatch',
              childExecutionId,
              connectionId,
              // Thread delegation depth so the dispatched Lambda enforces MAX_SUBAGENT_DEPTH
              // correctly - without this the dispatched orchestrator defaults to depth=1
              // and the cap only fires 3 levels below it instead of at the right level.
              ...(depth !== undefined ? { depth } : {}),
            } satisfies SubagentDispatchPayload),
          })
        );
      },
      pollChildStatus: async childExecutionId => {
        // Lean projection - avoid loading the child's full checkpoint/steps/
        // iterationBilling on every poll tick (~15-20 ticks per very_thorough run).
        const doc = await agentExecutionRepository.getPollableStatus(childExecutionId);
        if (!doc) return null;
        const childStatus: ChildExecutionStatus = {
          status: doc.status,
          result: doc.result as ChildExecutionStatus['result'],
          error: doc.error?.message,
          abortedAt: doc.abortedAt,
        };
        return childStatus;
      },
      abortChild: async childExecutionId => {
        await agentExecutionRepository.setAbortFlag(childExecutionId);
      },
    };

    // Side-channel ref the orchestrator populates when the parent runs out of time
    // mid-poll on a sync Lambda-dispatched subagent. The iteration loop reads this
    // AFTER `runIteration()` returns and self-dispatches if set. NOT a thrown
    // exception: `ReActAgent.executeToolWithQueueFallback` swallows tool throws and
    // converts them to "Error: ..." observation strings.
    const handoffSignal: SubagentHandoffSignal = {};

    // Phase 4a - parallel side-channel for `coordinate_task` DAG handoff.
    const dagHandoffSignal: DagHandoffSignal = {};
    const dagDispatcher = makeDagDispatcher({
      connectionId,
      nodeDefaults: {
        userId: execution.userId,
        organizationId: execution.organizationId,
        sessionId: execution.sessionId,
        questId: execution.questId,
        spawnedByExecutionId: executionId,
      },
      logger,
    });

    const toolDeps: ToolBuilderDeps = {
      userId: execution.userId,
      user: user as IUserDocument,
      logger,
      // Generic retrieval exclusion (opt-in per session) - thread it here so the agent's
      // knowledge tools honor the same exclusion as the chat path; absent it fails OPEN
      // (an excluded file leaks + gets cited). Session is resolved above at execution start.
      retrievalFilter: toRetrievalFilter(session),
      db: {
        apiKeys: apiKeyRepository,
        adminSettings: adminSettingsRepository,
        fabfiles: fabFileRepository,
        fabfilechunks: fabFileChunkRepository,
        users: userRepository,
        projects: projectRepository,
        dataLakes: dataLakeRepository,
        // Lattice tools persist models to Mongo and reload them by ObjectId on
        // subsequent calls (add_entity / set_value / query). Without this
        // adapter they fall back to an in-memory id that fails the ObjectId
        // guard, silently breaking the create->populate->query chain. Required
        // for the `enableLattice` tools registered below to actually work.
        latticeModels: latticeModelRepository,
        // Audit trail for images blocked by the image_generation/edit_image tools'
        // moderation gate. The gate itself is unconditional (constructed
        // inline in the tool) - this only wires the incident record, not the block.
        imageModerationIncidents: imageModerationIncidentRepository,
      },
      sessionRepository: sessionRepository,
      storage: getFilesStorage(),
      imageGenerateStorage: getGeneratedImageStorage(),
      imageProcessorLambdaName: Resource.ImageProcessor.name,
      llm,
      model: execution.model,
      precomputed: {
        adminSettingsEnforceCredits: false, // Agent executor handles billing per-iteration, not per-tool
        models,
      },
      apiKeyTable: apiKeyTable as ApiKeyTable,
      agentStore,
      getRemainingTimeMs: () => context.getRemainingTimeInMillis(),
      handoffSignal,
      dagHandoffSignal,
      dagDispatcher,
      getCurrentExecutionId: () => executionId,
    };

    // Accumulate filenames of images generated by tools during the run. Unlike the
    // classic chat path - which mutates `quest.images` live via applyQuestStatusChanges -
    // the agent path never had a quest to accrete into, so generated images were dropped
    // entirely (prod session 6a41abae...: 4 images generated, 0 persisted, user saw none).
    // We collect them here and write them onto the Quest in persistRunAsQuest so the inline
    // "image 1 of N" grid renders just like classic chat after the run completes.
    const generatedImages: string[] = [];

    // UI side-effects a tool emitted (e.g. optimizer console populate). The chat path
    // collects these on quest.uiSideEffects via its onUiSideEffect callback; the agent
    // path never supplied one, so they were silently dropped. `pendingSideEffects` buffers
    // the current tool call's effects until the observation step streams (drain-on-observation
    // in streamStep, 1:1 with the tool result); `allSideEffects` accumulates the whole run for
    // persistRunAsQuest so a reload can replay them non-destructively.
    let pendingSideEffects: { type: string; payload: unknown }[] = [];
    const allSideEffects: { type: string; payload: unknown }[] = [];

    const toolCallbacks: ToolBuilderCallbacks = {
      onStatusUpdate: async (changes, status) => {
        if (changes?.images?.length) {
          for (const img of changes.images) {
            if (!generatedImages.includes(img)) generatedImages.push(img);
          }
        }
        if (status) {
          await sendWs('progress', { executionId, status });
        }
      },
      onToolStart: async () => {
        // Agent Executor handles credit billing per-iteration, not per-tool-call
      },
      onToolFinish: async () => {
        // Tool finish side effects tracked via ReActAgent steps
      },
      onUiSideEffect: async sideEffect => {
        // Fires inside the wrapped toolFn (sharedToolBuilder extraction), i.e. between the
        // action and observation emits for this tool call. Buffer here; streamStep drains it
        // onto the observation iteration_step so the effect streams live with its tool result.
        pendingSideEffects.push(sideEffect);
        allSideEffects.push(sideEffect);
      },
      sessionId: execution.sessionId,
      onSubagentCredits: credits => {
        logger.info(`[Credits] Subagent used ${credits} credits`);
      },
      onSubagentStatusUpdate: async status => {
        await sendWs('progress', { executionId, status });
      },
      subagentTracker,
    };

    // Chat-native missions: create_mission / mission_status are ALWAYS exposed
    // so "@Cerebo do X weekly" works in chat - including for agents with an
    // empty toolbelt. buildSharedTools only surfaces tools named in
    // enabledTools, so the mission names must be appended even when the agent
    // enabled none of its own (the old `?.length` guard silently dropped them).
    //
    // For new executions, the orchestration profile supplies the
    // default `enabledTools` when the payload doesn't pin them - that's how
    // the agentless path (Agent-mode toggle / `@agent` literal trigger) ends
    // up with a non-empty toolbelt instead of mission-tools only.
    const profileEnabledTools = orchestrationProfile
      ? pickEffectiveEnabledTools(startPayload?.enabledTools, orchestrationProfile)
      : (startPayload?.enabledTools ?? []);

    // Lattice parity with chat_completion. Mirrors
    // `ChatCompletionProcess`'s `enableLattice` consumption: append the Lattice
    // tool names so the ReAct loop can offload structured data into a queryable
    // model instead of bloating the context window. The flag is read from the
    // start payload on new executions and from the persisted doc on
    // continuations - the tool list is rebuilt on every Lambda invocation, so
    // the flag must be re-resolved each time or Lattice would silently vanish
    // after the first handoff. Unlike `b4mTools`, Lattice definitions aren't in
    // the default resolvable map, so they're also merged into `externalTools`.
    // The resolution lives in `resolveLatticeTools` so it stays unit-tested.
    const { latticeEnabledTools, latticeExternalTools } = resolveLatticeTools({
      startPayloadEnableLattice: startPayload?.enableLattice,
      executionEnableLattice: execution.enableLattice,
    });

    const subagentToolConfig = buildSubagentToolConfig({
      model: execution.model,
      apiKeyTable: apiKeyTable as ApiKeyTable,
      imageConfig: execution.imageConfig,
    });

    // Lattice opt-in pool for delegated subagents. Built UNCONDITIONALLY (unlike
    // the parent's own Lattice toolbelt above, which is gated on `enableLattice`)
    // and threaded to `delegate_to_agent` / `coordinate_task` via `optInTools`. A
    // subagent whose IAgent `allowedTools` names `lattice_*` then gets Lattice
    // even when the parent run didn't enable it — and Lattice never leaks into the
    // parent's own toolbelt because this pool is kept out of `tools`. See
    // `buildSubagentLatticeToolPool` and `ServerOrchestratorDeps.optInTools`.
    const subagentLatticeTools = buildSubagentLatticeToolPool(toolDeps, toolCallbacks, subagentToolConfig);

    // Let optihashi_decompose run only ONCE per run (#666). The loop occasionally re-plans
    // mid-run, which reloads step 1 (a console yank), burns an iteration, and re-sources;
    // the guard turns any repeat into a no-op redirect that steers the agent back to
    // advancing its existing plan. Only affects opti runs (decompose isn't offered elsewhere).
    const decomposeGuard = { used: false };
    // Two complementary opti-loop guards: #666 stops re-PLANNING (decompose at most once); the
    // plan-completion guard stops re-SOLVING (once every planned step has a solver result, further
    // formulate/solve calls redirect to "write the final summary"). Without the latter the agent
    // -- which has no reliable memory of which steps it finished -- re-does solved families until
    // it hits the iteration ceiling. Both are inert on non-opti runs (decompose isn't offered).
    const planProgress: PlanProgressState = { needed: null, solved: {} };
    // Outermost: give the loop the real active brief in-context (#57) so it passes the exact
    // problem to solve/edit instead of reconstructing it. Wraps the guarded tools last, so it
    // augments real tool observations and leaves guard redirects (non-envelope strings) untouched.
    const guardedPremiumTools = injectBriefContext(
      guardPlanCompletion(
        guardDecomposeOnce(premiumLlmTools, decomposeGuard, () =>
          logger.info('[opti] blocked a repeat optihashi_decompose call (advancing existing plan)', { executionId })
        ),
        planProgress,
        () =>
          logger.info('[opti] plan complete -- all planned steps solved; steering to final summary', { executionId })
      )
    );

    const tools = buildSharedTools({ ...toolDeps, optInTools: subagentLatticeTools }, toolCallbacks, {
      // Dedupe: a caller may already have enabled create_mission/mission_status;
      // a raw append would make buildSharedTools wrap the same tool twice.
      enabledTools: [...new Set([...profileEnabledTools, ...MISSION_CHAT_TOOL_NAMES, ...latticeEnabledTools])],
      externalTools: { ...guardedPremiumTools, ...missionChatTools, ...latticeExternalTools },
      config: subagentToolConfig,
      mcpToolsByServer,
      agentOnlyMcpServers,
    });
    if (!tools) throw new Error('Failed to build tools');

    // Log the tool list seen by the parent agent on each invocation. Cheap +
    // CloudWatch-greppable, lets ops verify which tools (e.g.
    // `coordinate_task`, `delegate_to_agent`) are actually registered without
    // adding runtime instrumentation. Skip if there are no tools (defensive).
    if (tools.length > 0) {
      logger.info('[AgentExecutor] Registered tools', {
        toolNames: tools.map(t => t.toolSchema?.name).filter(Boolean),
        count: tools.length,
        hasCoordinateTask: tools.some(t => t.toolSchema?.name === 'coordinate_task'),
        agentOnlyMcpServers,
      });
    }

    // Artifact-emission parity with chat completions. When the admin
    // `EnableArtifacts` setting is on, inject the SAME guidance chat injects
    // (`ArtifactEmissionPrompt`, falling back to the built-in
    // `ARTIFACT_EMISSION_PROMPT`) so the agent wraps chart/code/HTML/SVG/Mermaid
    // output in `<artifact>` tags in its final answer - which the existing client
    // machinery renders as a card and durably persists, no client change needed.
    //
    // Resolved only on NEW executions: continuations already carry the composed
    // system message in the checkpoint (messages[0]), same as `personaPrompt`.
    // `enableArtifacts` is read on every invocation (new + continuation) because
    // the DAG bubble-up at persist-time gates on it too, and reading it here
    // avoids a second settings round-trip further down.
    // `?? true` is defensive: `EnableArtifacts` .prefault's to true, so
    // getSettingsValue can't actually return undefined - kept as belt-and-suspenders.
    const enableArtifacts = (await adminSettingsRepository.getSettingsValue('EnableArtifacts')) ?? true;
    // NOTE: this `|| ARTIFACT_EMISSION_PROMPT` fallback must resolve to the SAME default as the chat
    // path, which uses the util getSettingsValue('ArtifactEmissionPrompt', settings, ARTIFACT_EMISSION_PROMPT)
    // in ChatCompletionProcess. Two resolvers, one default - keep them in sync so an empty/unset value
    // reverts to the same built-in prompt on both paths.
    const artifactEmissionPrompt =
      isNewExecution && enableArtifacts
        ? (await adminSettingsRepository.getSettingsValue('ArtifactEmissionPrompt')) || ARTIFACT_EMISSION_PROMPT
        : undefined;

    // Create or restore ReActAgent. LLM runtime knobs are merged via
    // `buildReActAgentRuntimeConfig` - a pure helper that conditionally spreads
    // temperature / maxTokens / thinking so they only override the agent's
    // built-in defaults when the client actually selected a value. Extracted
    // for unit-testability (the `{ enabled: false }` guard for `thinking`
    // prevents a `structuredClone()` failure in `ReActAgent.toCheckpoint()`).
    const agent = new ReActAgent({
      userId: execution.userId,
      logger,
      llm,
      model: execution.model,
      tools,
      // Persona injection. Prepended to the ReAct prompt
      // so an Agent-mode run speaks in the configured agent's personality.
      // Resolved only on new executions; on continuations the persona is already
      // baked into the checkpointed system message (messages[0]), so it carries
      // forward without re-resolving the profile.
      ...(orchestrationProfile?.systemPrompt && { personaPrompt: orchestrationProfile.systemPrompt }),
      // Appended after persona/base in getSystemPrompt(); undefined on
      // continuations (baked into the checkpoint) and when artifacts are off.
      ...(artifactEmissionPrompt && { artifactEmissionPrompt }),
      ...buildReActAgentRuntimeConfig(execution),
    });

    // Restore from checkpoint if continuing
    if (!isNewExecution && execution.checkpoint) {
      agent.fromCheckpoint(execution.checkpoint as AgentCheckpoint);
      logger.info('[Checkpoint] Restored agent from checkpoint', {
        iteration: (execution.checkpoint as AgentCheckpoint).iteration,
      });
    }

    // Stream each step (thought / action / observation / final_answer) the
    // moment the agent emits it, instead of waiting for runIteration() to
    // return and sending only the trailing step. Without this, a long
    // tool call (e.g. delegate_to_agent) makes the UI look frozen until the
    // observation lands - the CLI subscribes to the same events for the same
    // reason (packages/cli/src/commands/headlessCommand.ts). EventEmitter dispatch
    // is synchronous; fire-and-forget the WS send so a slow socket can't stall
    // the iteration loop.
    const streamStep = (step: AgentStep) => {
      // Attach any UI side-effects the just-finished tool call emitted. Extraction
      // fires between the action and observation emits, so at observation-emit time
      // the buffer holds exactly this tool call's effects. Drain on observation to
      // keep a 1:1 association and empty the buffer for the next call.
      const drainedSideEffects = step.type === 'observation' ? pendingSideEffects : [];
      if (drainedSideEffects.length) pendingSideEffects = [];
      void sendWs('iteration_step', {
        executionId,
        // `getIteration()` reflects the agent's internal counter, which is
        // incremented at the start of each `runIteration()` call - so for steps
        // emitted during iteration N (1-indexed), this reports N. We subtract 1
        // to match the existing 0-indexed `iteration` field on the wire.
        iteration: Math.max(0, agent.getIteration() - 1),
        step,
        isComplete: false,
        ...(drainedSideEffects.length ? { uiSideEffects: drainedSideEffects } : {}),
      });
      // Persist in-flight steps so a mid-iteration refresh sees them on
      // reconnect. Without this, `checkpoint.steps` is only written when
      // `runIteration()` returns (the boundary `updateCheckpoint` below) -
      // for long tool calls (notably `delegate_to_agent` to an in-process
      // subagent that runs for minutes), a hard refresh in that window left
      // the persisted state empty and `handleReconnect` shipped no steps,
      // stranding the post-refresh UI on the rotating "Considering
      // approaches..." placeholder for the duration.
      //
      // Fire-and-forget for the same reason the WS send is: a slow DB write
      // must not stall the iteration loop. The boundary `updateCheckpoint`
      // remains the source of truth for Lambda continuation (it re-
      // serializes `messages` + token counters atomically); this in-flight
      // write only touches `checkpoint.steps` via dot-path `$set`.
      //
      // Skip `final_answer` - `runIteration()` returns almost immediately
      // after emitting it, so the boundary `updateCheckpoint` covers the
      // same step data. Firing here would be redundant and opens a narrow
      // race window where a delayed in-flight write could land *after* the
      // boundary write and overwrite `checkpoint.steps` with a stale
      // snapshot.
      if (step.type !== 'final_answer') {
        void agentExecutionRepository.updateInflightSteps(executionId, agent.getSteps()).catch(err => {
          logger.warn('[Stream] Failed to persist in-flight steps', {
            executionId,
            error: err instanceof Error ? err.message : String(err),
          });
          void emitMetric('Lumina5/AgentExecutor', 'InflightStepsPersistFailed', 1);
        });
      }
    };
    agent.on('thought', streamStep);
    agent.on('action', streamStep);
    agent.on('observation', streamStep);
    agent.on('final_answer', streamStep);
    // Forward the top-level agent's streaming token deltas so the console renders the
    // agent's reasoning/narration and final answer live within each iteration, instead of
    // the whole step landing at once after a long generation (a decompose turn is ~40s).
    // Mirrors the subagent `onTextDelta` path. Chunk to stay under the API Gateway frame
    // limit; fire-and-forget so a slow WS send can't stall the loop. The emitted
    // `iteration` matches the `iteration_step` wire index, so the client clears its
    // per-iteration buffer when the terminal step lands.
    // Serialize the delta sends through a promise chain. `sendWs` -> API Gateway
    // postToConnection is a separate async call per frame; firing them concurrently
    // (fire-and-forget) lets frames arrive out of order and scramble the live text.
    // Chaining makes each frame await the previous, preserving token order, while the
    // listener stays non-blocking to the agent loop (we never await the chain here).
    let textDeltaSendChain: Promise<unknown> = Promise.resolve();
    agent.on('text_delta', ({ delta, iteration }: { delta: string; iteration: number }) => {
      for (let offset = 0; offset < delta.length; offset += MAX_STEP_CONTENT) {
        const chunk = delta.slice(offset, offset + MAX_STEP_CONTENT);
        textDeltaSendChain = textDeltaSendChain
          .then(() => sendWs('agent_text_delta', { executionId, iteration, delta: chunk }))
          .catch(() => {});
      }
    });

    // Set up timeout watchdog
    const deadlineMs = context.getRemainingTimeInMillis() - TIMEOUT_BUFFER_MS;
    const startTime = Date.now();
    // The orchestration profile supplies the iteration ceiling default
    // when the payload doesn't pin one - agentless dispatches (Agent-mode
    // toggle path) land on the profile's `defaultThoroughness` ceiling rather
    // than the legacy 25-iteration fallback.
    const maxIterations = orchestrationProfile
      ? pickEffectiveMaxIterations(startPayload?.maxIterations, orchestrationProfile)
      : (startPayload?.maxIterations ?? 25);

    // Track cumulative usage for delta-based billing.
    // Token counts in iterationBilling are stored as per-iteration deltas, so
    // summing them gives the cumulative-since-start figure. `cumulativeCost`
    // must be in USD to match `getTextModelCost` output used at billing time -
    // recompute it from cumulative tokens rather than summing `billing.credits`
    // (which is in credits, not USD; a prior bug had the loop summing credits
    // into a USD-typed counter, which made every iteration after a Lambda
    // re-invoke compute a negative costDelta and silently skip billing).
    //
    // Bundled into a single `counters` object so the in-place mutation
    // performed by `billIterationIfNeeded` is visible at the call site
    // (you pass `counters`, the helper mutates its fields). Five loose
    // `let` variables would have the same semantics but the contract
    // would be invisible to a reader.
    const counters = {
      cumulativeCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    if (!isNewExecution && execution.iterationBilling.length > 0) {
      for (const billing of execution.iterationBilling) {
        counters.inputTokens += billing.inputTokens;
        counters.outputTokens += billing.outputTokens;
        counters.cacheReadTokens += billing.cacheReadTokens;
        counters.cacheWriteTokens += billing.cacheWriteTokens;
      }
      if (modelInfo) {
        counters.cumulativeCost = getTextModelCost(
          modelInfo,
          counters.inputTokens,
          counters.outputTokens,
          counters.cacheReadTokens,
          counters.cacheWriteTokens
        );
      }
    }

    // Bill the iteration that just ran. Centralised so all code paths
    // downstream of `runIteration` see a consistent "iteration N has been
    // billed" invariant - see the call site at the top of the loop body
    // for the ordering rationale.
    //
    // Both `iterationIndex` and `counters` are passed explicitly rather
    // than captured via closure so the helper's I/O contract is visible
    // at the call site (it reads `counters` and mutates them in place as
    // billing advances). The closure still captures immutable references
    // (`modelInfo`, `executionId`, `execution`, `user`, etc.) since those
    // are fixed for the lifetime of the Lambda invocation.
    const billIterationIfNeeded = async (
      iterationIndex: number,
      checkpoint: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheReadTokens: number;
        totalCacheWriteTokens: number;
      },
      counters: {
        cumulativeCost: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      }
    ) => {
      if (!modelInfo) return;
      // Price cache tokens explicitly: totalInputTokens EXCLUDES cache-read/write (they're
      // tracked as separate counters), so passing them here bills cache-read at ~0.1x and
      // cache-write at ~1.25x rather than pricing them at zero. Mirrors the chat path.
      const cumulativeCost = getTextModelCost(
        modelInfo,
        checkpoint.totalInputTokens,
        checkpoint.totalOutputTokens,
        checkpoint.totalCacheReadTokens,
        checkpoint.totalCacheWriteTokens
      );
      const costDelta = cumulativeCost - counters.cumulativeCost;
      if (costDelta <= 0) return;
      const inputTokensDelta = checkpoint.totalInputTokens - counters.inputTokens;
      const outputTokensDelta = checkpoint.totalOutputTokens - counters.outputTokens;
      const cacheReadTokensDelta = checkpoint.totalCacheReadTokens - counters.cacheReadTokens;
      const cacheWriteTokensDelta = checkpoint.totalCacheWriteTokens - counters.cacheWriteTokens;
      counters.cumulativeCost = cumulativeCost;
      counters.inputTokens = checkpoint.totalInputTokens;
      counters.outputTokens = checkpoint.totalOutputTokens;
      counters.cacheReadTokens = checkpoint.totalCacheReadTokens;
      counters.cacheWriteTokens = checkpoint.totalCacheWriteTokens;
      // Stochastic settlement: a sub-credit delta legitimately rounds to 0
      // (paid in expectation across iterations), so only skip the ledger
      // deduction - the usage event below still records the COGS delta,
      // otherwise margin reporting would silently under-count cost.
      const credits = usdToCreditsStochastic(costDelta);
      if (credits > 0) {
        await creditService.deductCreditsWithOrgSupport(
          {
            type: 'text_generation_usage',
            user: user as IUserDocument,
            organization,
            credits,
            sessionId: execution.sessionId,
            questId: execution.questId,
            model: execution.model,
            inputTokens: inputTokensDelta,
            outputTokens: outputTokensDelta,
          },
          {
            db: {
              creditTransactions: creditTransactionRepository,
              users: userRepository,
              organizations: organizationRepository,
            },
          }
        );
      }
      // Dual-write usage event: analytics only, never billing. One per billed iteration.
      usageEventRepository
        .record({
          requestId: execution.questId || executionId,
          userId: execution.userId,
          ownerId: organization ? organization.id : (user as IUserDocument).id,
          ownerType: organization ? CreditHolderType.Organization : CreditHolderType.User,
          sessionId: execution.sessionId,
          feature: 'agent_execution',
          provider: modelInfo.backend,
          model: execution.model,
          inputTokens: inputTokensDelta,
          outputTokens: outputTokensDelta,
          cachedInputTokens: cacheReadTokensDelta,
          cacheWriteTokens: cacheWriteTokensDelta,
          costUsd: costDelta,
          creditsCharged: credits,
          status: 'ok',
          latencyMs: Date.now() - startTime,
        })
        .catch(err => logger.warn('Failed to record usage event', { err }));
      await agentExecutionRepository.addIterationBilling(executionId, {
        iteration: iterationIndex,
        inputTokens: inputTokensDelta,
        outputTokens: outputTokensDelta,
        cacheReadTokens: cacheReadTokensDelta,
        cacheWriteTokens: cacheWriteTokensDelta,
        credits,
        model: execution.model,
        timestamp: new Date(),
      });
      await sendWs('progress', {
        executionId,
        creditsUsed: credits,
        // 0-indexed wire convention (matches `permission_request` and the
        // per-step listener). DB `addIterationBilling.iteration` keeps the
        // 1-indexed value since billing records are persisted.
        iteration: Math.max(0, iterationIndex - 1),
      });
    };

    // Load current approved/denied tools for permission checking
    const approvedTools = [...(execution.approvedTools ?? [])];
    const deniedTools = [...(execution.deniedTools ?? [])];

    // --- Resume after subagent handoff ---
    // If we're resuming an `awaiting_subagent` execution, the parent was mid-poll on a
    // Lambda-dispatched child when it ran out of time. Fetch the child's terminal
    // status (poll-with-backoff in case the child is still finishing in its own
    // Lambda), inject the result into the agent's tool history by surgically replacing
    // the placeholder observation, and clear `waitingOnChild` before entering the
    // iteration loop.
    if (isSubagentResume && execution.waitingOnChild) {
      const childInjected = await resumeAfterSubagentHandoff({
        executionId,
        connectionId,
        waitingOnChild: execution.waitingOnChild,
        agent,
        sendWs,
        context,
        logger,
        checkpointDepth,
      });
      if (!childInjected) {
        // Either the child is still running and parent ran out of time again (we
        // self-dispatched inside the helper), or the child failed unrecoverably and
        // we already marked the parent failed. Either way, exit.
        return;
      }
    }

    // Phase 4a - resume from `awaiting_dag_children`. The completion hook for
    // the last terminal DAG child enqueued this continuation; load all child
    // results, build the aggregated markdown via shared `buildPipelineResult`,
    // and surgically replace the `coordinate_task` placeholder observation.
    if (isDagResume && execution.dagSpec && execution.waitingOnDagChildren) {
      // NOTE (merge): combined with main's first-iteration CASL scope below -
      // these are independent additions in the same spot; both are kept.
      const children = await agentExecutionRepository.findDagChildrenLean(executionId);
      const { summary, success, failedNodes } = buildDagResumeReport({
        dagSpec: execution.dagSpec,
        children,
      });
      try {
        agent.replaceLastToolResultObservation(execution.waitingOnDagChildren.toolUseId, summary);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('[DAG] replaceLastToolResultObservation failed on DAG resume', { error: errMsg });
        await agentExecutionRepository.markFailed(executionId, {
          message: `DAG resume failed: ${errMsg}`,
        });
        await sendWs('failed', { executionId, reason: 'dag_resume_error' });
        return;
      }
      const cleared = await agentExecutionRepository.clearWaitingOnDagChildren(executionId);
      if (!cleared) {
        logger.info('[DAG] Parent was aborted during DAG resume — bailing out');
        await sendWs('failed', { executionId, reason: 'aborted' });
        return;
      }
      logger.info('[DAG] Aggregated DAG result injected — resuming parent iteration', {
        executionId,
        success,
        failedNodes,
      });
      // Roll up child credits to the parent's totalCreditsUsed counter.
      // Sums ALL children regardless of terminal status (completed, failed,
      // aborted) because the LLM tokens behind the cost were already
      // consumed - failed/aborted runs still hit Bedrock. This keeps cap
      // and billing math honest even when the user sees a partial result.
      const childCreditSum = children.reduce((sum, c) => sum + (c.totalCreditsUsed ?? 0), 0);
      if (childCreditSum > 0) {
        await agentExecutionRepository.incrementCreditsUsed(executionId, childCreditSum);
      }
      await sendWs('resumed', {
        executionId,
        reason: 'dag_completed',
        nodeCount: execution.dagSpec.tasks.length,
        failedNodes,
      });
    }

    // CASL read scope used to surface org/group/shared files in the first-
    // iteration `[ATTACHED FILES]` preamble. Hoisted out of the loop because
    // the preamble is only built on iteration 0 of a new execution and the
    // scope doesn't depend on iteration state - evaluating it once avoids
    // rebuilding the ability set every iteration.
    const fabFileReadScope = accessibleBy(defineAbilitiesFor(user as IUserDocument), Permission.read).ofType(FabFile);

    // --- Iteration loop ---
    let iterationResult: IterationResult | undefined;
    let iterationIndex = isNewExecution ? 0 : ((execution.checkpoint as AgentCheckpoint)?.iteration ?? 0);

    // Confidence-gate plumbing. The agent calls this callback after
    // tool execution with the iteration's average tool-result confidence;
    // we capture it via a getter+setter pair so the post-iteration check
    // below can read the last value, and always return `proceed` so the
    // agent doesn't short-circuit with a synthetic "[Paused for review]"
    // final_answer step (we want full control over the pause flow + WS
    // event shape).
    //
    // The getter shape (rather than a plain `let foo: T | null`) is here
    // for TypeScript's benefit: TS narrows a let-binding re-assigned via
    // closure callback back to `null` along the local control-flow path -
    // the reassignment inside the callback is invisible to the analyzer,
    // so a direct read after `runIteration` would type as `null`. Reading
    // through a function call defeats that narrowing without resorting to
    // a cast.
    //
    // Reset to `null` before every `runIteration` call so a no-tool
    // iteration doesn't reuse a stale value from the previous loop turn
    // (the agent skips the gate callback when no tools ran).
    type IterationConfidence = { iteration: number; confidence: number };
    let lastIterationConfidenceState: IterationConfidence | null = null;
    const readLastIterationConfidence = (): IterationConfidence | null => lastIterationConfidenceState;
    const resetLastIterationConfidence = () => {
      lastIterationConfidenceState = null;
    };
    const confidenceGate = (iterationConfidence: number, agentIterationIndex: number) => {
      lastIterationConfidenceState = { iteration: agentIterationIndex, confidence: iterationConfidence };
      // Always proceed - the actual gate decision is made post-iteration by
      // the block below. `confidence` and `reason` are echoed back only to
      // satisfy the `ConfidenceGateDecision` type; the agent ignores both
      // when `action === 'proceed'`.
      return {
        action: 'proceed' as const,
        confidence: iterationConfidence,
        reason: '',
      };
    };

    while (iterationIndex < maxIterations) {
      // Check abort flag
      const isAborted = await agentExecutionRepository.checkAbortFlag(executionId);
      if (isAborted) {
        logger.info('[Abort] Abort flag detected during iteration loop');
        const checkpoint = agent.toCheckpoint();
        const partialAnswer = extractFinalAnswer(checkpoint.steps);
        await agentExecutionRepository.markAborted(executionId, {
          steps: checkpoint.steps,
          partialAnswer,
        });
        await sendWs('failed', {
          executionId,
          reason: 'aborted',
          partialResult: checkpoint.steps,
        });
        // Persist the user-initiated abort in chat history so the user still
        // sees the conversation after refresh. Include the partial answer if
        // the agent had started forming one before the abort landed.
        await persistRunAsQuest(
          executionId,
          partialAnswer ? `Stopped by user. Partial response:\n\n${partialAnswer}` : 'Stopped by user.',
          logger,
          generatedImages,
          undefined,
          allSideEffects
        );
        return;
      }

      // Check timeout watchdog
      if (Date.now() - startTime > deadlineMs) {
        logger.info('[Timeout] Approaching Lambda timeout, triggering self-dispatch');
        const checkpoint = agent.toCheckpoint();
        // Atomic write: persisting checkpoint + status separately could leave the
        // doc in `running` with a fresh checkpoint if Lambda is killed between
        // calls, which would fail the continuation Lambda's CAS and orphan the
        // execution.
        await agentExecutionRepository.updateCheckpointAndStatus(executionId, checkpoint, 'continuing');

        // Publish to continuation queue
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: Resource.agentContinuationQueue.url,
            MessageBody: JSON.stringify({
              kind: 'continuation',
              executionId,
              connectionId,
              checkpointDepth: checkpointDepth + 1,
            }),
          })
        );

        await sendWs('resumed', { executionId, reason: 'timeout_handoff' });
        logger.info('[Timeout] Self-dispatched to continuation queue');
        return;
      }

      // Run one iteration. The `[ATTACHED FILES]` preamble is gated to
      // iteration 0 of a new execution - continuation Lambdas replay the
      // checkpoint, which already embeds the preamble in the first user
      // message. The gate is wrapped in a helper so it's unit-testable.
      let firstIterationQuery = await maybeBuildFirstIterationQuery(
        {
          isNewExecution,
          iterationIndex,
          baseQuery: execution.query,
          execution,
          sessionKnowledgeIds: session.knowledgeIds ?? [],
          scope: fabFileReadScope,
        },
        logger,
        fabFileRepository
      );
      // Memento retrieval parity with chat_completion. Append the
      // `[KNOWN FACTS ABOUT THE USER ...]` preamble to the same iteration-0 user
      // message the file preamble lands in, so the agent reads both from a
      // single materialized string that gets persisted into the checkpoint.
      // Continuation Lambdas, gate-resumes, and DAG-resumes inherit it via
      // the checkpoint replay - same handoff contract as the file preamble.
      // The helper itself guards on `enableMementos` + `parentExecutionId`,
      // matching `publishMementoCompletion` on the write side.
      if (firstIterationQuery !== undefined) {
        const { preamble: mementoPreamble, mementoIds } = await getFirstIterationMementosPreamble(
          execution,
          {
            db: {
              mementos: mementoRepository,
              apiKeys: apiKeyRepository,
              adminSettings: adminSettingsRepository,
            },
          },
          logger
        );
        if (mementoPreamble) firstIterationQuery = `${firstIterationQuery}${mementoPreamble}`;
        if (mementoIds.length > 0) {
          // Persist to AgentExecution so every terminal path (continuation Lambda,
          // gate-stop, abort) can read the IDs from the DB rather than relying on
          // this Lambda's in-memory variable.
          await agentExecutionRepository.persistMementoIds(executionId, mementoIds);
        }

        // Skill-invocation expansion parity with chat_completion's SkillsFeature.
        // Resolve `/skill-name args` mentions in the raw query and append
        // the expanded body so an agent-mode turn runs the skill instead of
        // sending the literal slash text to the LLM. Detect against the original
        // query (not the augmented string) so the preambles above never confuse
        // the mention parser. Gated to iteration 0 by the enclosing block, so the
        // expansion is baked into the checkpointed first message for continuations.
        const skillsPreamble = await getFirstIterationSkillsPreamble(
          execution.query,
          execution.userId,
          skillRepository,
          logger
        );
        if (skillsPreamble) firstIterationQuery = `${firstIterationQuery}${skillsPreamble}`;
      }
      // Seed the run with recent session history so short follow-ups ("yes", "go ahead") resolve
      // against prior turns. Only on iteration 0 of a new execution - continuation Lambdas restore
      // previousMessages from the checkpoint. The current user message is not yet persisted as a
      // Quest, so the loader keeps the most-recent stored turn (the one with the follow-up
      // question) rather than dropping it. A history-load failure must not fail the run.
      let previousMessages: Awaited<ReturnType<typeof fetchAgentConversationHistory>> = [];
      if (isNewExecution && iterationIndex === 0) {
        try {
          previousMessages = await fetchAgentConversationHistory(session, AGENT_HISTORY_QUEST_COUNT, {
            db: { quests: questRepository },
          });
        } catch (historyErr) {
          logger.error('[History] Failed to load agent conversation history; proceeding without it', {
            error: historyErr instanceof Error ? historyErr.message : String(historyErr),
          });
        }
      }

      resetLastIterationConfidence();
      iterationResult = await agent.runIteration(firstIterationQuery, {
        maxIterations,
        confidenceGate,
        previousMessages,
        // Cache the (large, static) system prompt + tool schemas across iterations. An
        // agent run is always multi-iteration, and previously this was omitted - so the
        // full system prompt + tools were re-sent at full input price EVERY iteration
        // (the chat path already caches via ChatCompletionProcess). Enabling it is the
        // single biggest cost reduction for multi-iteration runs; cache-read tokens are
        // priced at ~0.1x (see billIterationIfNeeded passing the cache-token counts).
        enableCaching: true,
      });

      iterationIndex = iterationResult.checkpoint.iteration;

      // Persist checkpoint + bill the iteration before ANY branching.
      // Centralised here so:
      //   1. Every code path that follows (subagent handoff, denied,
      //      needs_approval, completion, continue-loop) sees a consistent
      //      "iteration N has been billed" invariant.
      //   2. If `billIterationIfNeeded` throws (credit service failure, DB
      //      contention, etc.), the outer catch at the bottom of
      //      processExecution converts it to a clean failure WITHOUT any
      //      prior WS event (permission_request, subagent_handoff, etc.)
      //      having been emitted that the client would then have to
      //      reconcile with the terminal state.
      //   3. The subagent-handoff path now bills the parent's deciding
      //      iteration, which previously slipped through unbilled.
      await agentExecutionRepository.updateCheckpoint(executionId, iterationResult.checkpoint);
      await billIterationIfNeeded(iterationIndex, iterationResult.checkpoint, counters);

      // Handoff signal: orchestrator-side polling on a sync Lambda-dispatched
      // subagent ran out of time. The placeholder observation has been appended
      // to the agent's messages by `appendToolMessages` during this iteration -
      // we capture its tool_use id from the latest assistant message (last
      // tool_use block) so the continuation Lambda can surgically replace the
      // observation with the real result when the child finishes.
      if (handoffSignal.awaitingSubagent) {
        const toolUseId = agent.getLatestToolCallId('delegate_to_agent');
        if (!toolUseId) {
          // Couldn't recover the tool_use id - fail the parent cleanly rather than
          // self-dispatch into a state we can't resume from.
          logger.error('[Handoff] handoffSignal set but no tool_use id found in messages');
          await agentExecutionRepository.markFailed(executionId, {
            message: 'Subagent dispatch state inconsistency: unable to locate tool_use id for resume',
          });
          await sendWs('failed', {
            executionId,
            reason: 'subagent_handoff_error',
          });
          return;
        }

        const checkpoint = agent.toCheckpoint();
        await agentExecutionRepository.setWaitingOnChild(
          executionId,
          {
            childExecutionId: handoffSignal.awaitingSubagent.childExecutionId,
            agentName: handoffSignal.awaitingSubagent.agentName,
            toolUse: {
              id: toolUseId,
              name: 'delegate_to_agent',
              arguments: JSON.stringify(iterationResult.step.metadata?.toolInput ?? {}),
            },
            dispatchedAt: new Date(),
          },
          checkpoint
        );

        // Self-dispatch via continuation queue. The continuation Lambda will see
        // status `awaiting_subagent` and route into the resume-after-handoff path.
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: Resource.agentContinuationQueue.url,
            MessageBody: JSON.stringify({
              kind: 'continuation',
              executionId,
              connectionId,
              checkpointDepth: checkpointDepth + 1,
            }),
          })
        );

        await sendWs('resumed', { executionId, reason: 'subagent_handoff' });
        logger.info('[Handoff] Self-dispatched while awaiting subagent', {
          childExecutionId: handoffSignal.awaitingSubagent.childExecutionId,
        });
        return;
      }

      // Phase 4a - coordinate_task DAG handoff. The tool created the children
      // and dispatched roots; we persist the spec (with the tool_use id we look
      // up from the agent's history) and transition to awaiting_dag_children.
      // The completion hook on the last terminal child will self-dispatch this
      // parent back via `kind: 'continuation'` -> `resumeAfterDagChildren`.
      if (dagHandoffSignal.awaitingDagChildren) {
        const toolUseId = agent.getLatestToolCallId('coordinate_task');
        if (!toolUseId) {
          logger.error('[DAG] dagHandoffSignal set but no coordinate_task tool_use id found');
          await agentExecutionRepository.markFailed(executionId, {
            message: 'DAG handoff inconsistency: unable to locate tool_use id for resume',
          });
          await sendWs('failed', { executionId, reason: 'dag_handoff_error' });
          return;
        }
        const checkpoint = agent.toCheckpoint();
        const { spec, pendingNodeIds } = dagHandoffSignal.awaitingDagChildren;
        await agentExecutionRepository.setDagSpec(executionId, {
          toolUseId,
          tasks: spec.tasks.map(t => ({
            id: t.id,
            description: t.description,
            agentType: t.agentType,
            dependsOn: t.dependsOn,
            onFailure: t.onFailure,
          })),
        });
        await agentExecutionRepository.setWaitingOnDagChildren(
          executionId,
          {
            pendingNodeIds,
            toolUseId,
            dispatchedAt: new Date(),
          },
          checkpoint
        );
        await sendWs('resumed', { executionId, reason: 'dag_handoff', pendingNodeCount: pendingNodeIds.length });
        logger.info('[DAG] Parent transitioned to awaiting_dag_children', {
          executionId,
          pendingNodes: pendingNodeIds,
        });
        return;
      }

      // Permission check after iteration - classify tool calls across all steps.
      //
      // KNOWN LIMITATION (Phase 1): Permission classification happens AFTER
      // runIteration() executes the tool. Side effects (e.g., send_slack_message)
      // have already occurred by this point. Pre-execution gating requires splitting
      // runIteration() into plan + execute phases - tracked for Phase 2.
      //
      // Inspect `allSteps` (not the primary `step`): for tool-calling iterations
      // the primary step is the trailing `observation`, so the action step lives
      // only in `allSteps`. See selectGatedAction for multi-tool semantics.
      const gated = selectGatedAction(iterationResult.allSteps, approvedTools, deniedTools);
      if (gated) {
        const { toolName, toolInput, verdict } = gated;

        if (verdict === 'denied') {
          // Fail the execution - the tool already executed (Phase 1 limitation),
          // but continuing would let the agent act on the denied tool's result
          // and potentially retry it indefinitely. Checkpoint persistence and
          // iteration billing already happened above the branch.
          logger.warn(`[Permission] Tool "${toolName}" is denied — failing execution`);
          await agentExecutionRepository.markFailed(executionId, {
            message: `Execution stopped: tool "${toolName}" is not permitted`,
          });
          await sendWs('failed', {
            executionId,
            reason: 'tool_denied',
            toolName,
          });
          return;
        }

        // verdict === 'needs_approval' - pause and ask the user. Note: the tool
        // has already executed (Phase 1 limitation) - approval gates future
        // iterations, not this one. Checkpoint persistence and iteration
        // billing already happened above the branch.
        logger.info(`[Permission] Tool "${toolName}" needs approval, pausing execution`);
        await agentExecutionRepository.updateStatus(executionId, 'awaiting_permission');
        await agentExecutionRepository.updatePermissionState(executionId, {
          pendingPermission: {
            toolName,
            toolInput,
            requestedAt: new Date(),
          },
        });

        await sendWs('permission_request', {
          executionId,
          toolName,
          toolInput,
          // 0-indexed to match per-step `iteration_step` events and the
          // accordion labels in `IterationStream` (which renders
          // `Iteration {group.iteration + 1}`). `iterationIndex` is the
          // agent's 1-indexed `this.iterations` after the iteration ran,
          // so subtract 1 here so `PermissionCard`'s `pending.iteration + 1`
          // display lines up with the iteration the user is actually
          // approving.
          iteration: Math.max(0, iterationIndex - 1),
        });

        // Lambda exits - client sends permission_response via WebSocket,
        // which re-invokes this Lambda with ContinuationSchema
        return;
      }

      // Checkpoint persistence + iteration billing happened immediately
      // after `runIteration` returned, before any branching. Per-step WS
      // streaming happens via the `streamStep` listener attached above -
      // each step (thought / action / observation / final_answer) already
      // reached the client mid-iteration.

      // Confidence gate - pause low-confidence runs for human
      // review. Evaluated AFTER the permission gate so a tool that needs
      // approval pauses for that more specific signal first, and only
      // checked on non-terminal iterations (a final_answer iteration is
      // complete by definition; pausing it would discard the answer).
      const gate = readLastIterationConfidence();
      if (gate !== null) {
        // Telemetry (#56 M1.1): record every iteration the gate evaluates -
        // including ones that complete in the same turn (isComplete=true) or
        // clear the threshold - so `evaluatedCount` is the true denominator for
        // fire rate. `recordGateEmitted` below increments the numerator only on
        // a real pause. Baseline observability before touching signal quality.
        await agentExecutionRepository.recordIterationConfidence(executionId, gate.confidence);
      }
      // Per-profile override wins over the global default; a profile threshold of 0
      // disables the gate entirely (confidence is never < 0) for unattended loops.
      const confidenceGateThreshold = orchestrationProfile?.confidenceGateThreshold ?? CONFIDENCE_GATE_THRESHOLD;
      if (
        gate !== null &&
        !iterationResult.isComplete &&
        !iterationResult.reachedMaxIterations &&
        gate.confidence < confidenceGateThreshold
      ) {
        // 0-indexed wire convention: the agent reports 1-indexed
        // `this.iterations`, but the client's `IterationStream` and
        // `permission_request` use 0-indexed (see the matching subtraction
        // in the permission_request emit above). Keep both pause events
        // consistent so the eventual gate UI doesn't render an off-by-one
        // iteration label relative to the permission card.
        const wireIteration = Math.max(0, gate.iteration - 1);
        const reason = `Iteration confidence ${(gate.confidence * 100).toFixed(0)}% below threshold ${(confidenceGateThreshold * 100).toFixed(0)}%`;
        const gatePayload = { iteration: wireIteration, confidence: gate.confidence, reason };
        logger.info('[ConfidenceGate] Pausing execution for human review', { executionId, ...gatePayload });
        // `updateCheckpoint` above already persisted the current iteration's
        // checkpoint, so `setPendingGate` only needs to flip status + write
        // the gate marker atomically. Returns `false` if a concurrent
        // `handleAbort` set `abortedAt` between the loop-top abort check and
        // here - bail without overwriting the aborted doc.
        const paused = await agentExecutionRepository.setPendingGate(executionId, {
          ...gatePayload,
          requestedAt: new Date(),
        });
        if (!paused) {
          logger.info('[ConfidenceGate] Aborted concurrently — bailing without pausing');
          await sendWs('failed', { executionId, reason: 'aborted' });
          return;
        }
        // Telemetry (#56 M1.1): count this real pause only after `setPendingGate`
        // confirms it landed (i.e. not raced by a concurrent abort).
        await agentExecutionRepository.recordGateEmitted(executionId);
        await sendWs('confidence_gate', { executionId, ...gatePayload });
        // Emit a `progress` event with the paused status so the client's
        // existing `progress` subscriber flips `ExecutionStatusBanner` to
        // "Agent paused" without waiting for a refresh + `reconnect_result`.
        // The DB-side status is the source of truth; this just keeps the
        // in-memory store in sync without adding a new client subscriber.
        await sendWs('progress', { executionId, status: 'paused' });
        // Lambda exits - client sends `gate_response` via WebSocket,
        // which clears `pendingGate`, transitions `paused -> continuing`,
        // and re-invokes this Lambda with ContinuationSchema.
        return;
      }

      // TODO(Phase 2): Add mid-execution credit exhaustion check here.
      // Pre-flight check at line ~280 prevents starting with 0 credits, but once
      // running, credits are deducted without re-checking balance. A user with 1
      // credit can run many iterations. Re-read user/org credits periodically and
      // stop execution if exhausted.

      // Check if agent is done
      if (iterationResult.isComplete || iterationResult.reachedMaxIterations) {
        break;
      }
    }

    // Execution complete - re-read totalCreditsUsed from DB for accurate value
    const updatedExecution = await agentExecutionRepository.findById(executionId);
    const finalCheckpoint = agent.toCheckpoint();
    const finalAnswer = extractFinalAnswer(finalCheckpoint.steps);
    // A run that stopped on the iteration ceiling (not model completion) leaves `finalAnswer` as
    // a mid-sentence fragment; wrap it in a deterministic truncation notice so the user sees an
    // honest "partial, hit the limit" reply instead of a trailed-off thought. See #674.
    const reachedMaxIterations = iterationResult?.reachedMaxIterations ?? false;
    const displayAnswer = reachedMaxIterations ? buildTruncatedRunReply(maxIterations, finalAnswer) : finalAnswer;

    await agentExecutionRepository.markComplete(executionId, {
      answer: displayAnswer,
      steps: finalCheckpoint.steps,
      totalTokens: finalCheckpoint.totalTokens,
      totalIterations: finalCheckpoint.iteration,
      reachedMaxIterations,
    });

    await sendWs('completed', {
      executionId,
      answer: displayAnswer,
      totalIterations: finalCheckpoint.iteration,
      totalCreditsUsed: updatedExecution?.totalCreditsUsed ?? 0,
      // Surface memento IDs in the WS event so the client can populate the
      // badge immediately - without this, the badge only appears after the
      // change-stream subscriber delivers the updated Quest (seconds later,
      // and silently dropped when the client-clock-set updatedAt is ahead).
      mementoIds: updatedExecution?.usedMementoIds ?? [],
    });

    // Persist a Quest so the run survives page refresh - see persistRunAsQuest
    // docstring. Best-effort; failures are logged but don't fail the run.
    let replyText = displayAnswer ?? 'Agent execution completed without a final answer.';

    // DAG subagent artifact bubble-up. The parent re-summarizes the aggregated
    // child report and may drop the raw `<artifact>` blocks the workers emitted,
    // so append the ones the parent didn't reproduce to the reply text - the
    // client renders cards from the text (see collectDagChildArtifactBlocks).
    // Re-read children here (rather than carrying from the DAG-resume block)
    // so it survives a parent self-dispatch after resume; gated on the same
    // `EnableArtifacts` flag as emission. Best-effort - never fails the run.
    if (enableArtifacts && execution.dagSpec) {
      try {
        const dagChildren = await agentExecutionRepository.findDagChildrenLean(executionId);
        const childAnswers = dagChildren
          .filter(c => c.status === 'completed')
          .map(c => (c.result as { answer?: string } | undefined)?.answer ?? '');
        const extraBlocks = collectDagChildArtifactBlocks({ parentAnswer: replyText, childAnswers });
        if (extraBlocks.length > 0) {
          replyText = `${replyText}\n\n${extraBlocks.join('\n\n')}`;
          logger.info('[Artifacts] Surfaced DAG subagent artifacts on parent completion', {
            executionId,
            count: extraBlocks.length,
          });
        }
      } catch (bubbleErr) {
        logger.warn('[Artifacts] Failed to bubble up DAG subagent artifacts — continuing', {
          executionId,
          error: bubbleErr instanceof Error ? bubbleErr.message : String(bubbleErr),
        });
      }
    }

    await persistRunAsQuest(
      executionId,
      replyText,
      logger,
      generatedImages,
      finalCheckpoint.finishReason,
      allSideEffects
    );

    // Memento parity with chat_completion. Fires only when the user
    // (or admin default) opted into mementos for this run; skipped for
    // subagent / DAG children via the `parentExecutionId` guard inside the
    // helper. Reads `execution` (loaded at the top of this function) so
    // continuation Lambdas see the persisted flag the WS handler stamped at
    // dispatch.
    await publishMementoCompletion(execution, logger);

    logger.info('[Complete] Agent execution finished', {
      iterations: finalCheckpoint.iteration,
      totalTokens: finalCheckpoint.totalTokens,
      hasAnswer: !!finalAnswer,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;

    logger.error('[Error] Agent execution failed', { error: errorMessage, stack: errorStack });

    try {
      await agentExecutionRepository.markFailed(executionId, {
        message: errorMessage,
        stack: errorStack,
      });
      // Don't leak internal error details to client. Recognized, non-sensitive failure
      // categories (billing/rate-limit/timeout/auth) get a specific message; everything else stays
      // generic. Full details remain in the logs above.
      const userFacingMessage = toUserFacingFailureMessage(errorMessage);
      await sendWs('failed', { executionId, reason: 'error', message: userFacingMessage });
      // Persist the failed run in chat history so the user still sees their
      // prompt after refresh, with the (sanitized) reason as the reply.
      await persistRunAsQuest(executionId, `${userFacingMessage}.`, logger);
    } catch (cleanupErr) {
      logger.error('[Error] Failed to update execution status on error', {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatched subagent handler
// ---------------------------------------------------------------------------

/**
 * Runs a subagent that was dispatched to its own Lambda (either via `background: true`
 * or via the parent's mid-poll handoff when running out of time). The child doc
 * already has `subagentConfig` populated by the orchestrator; we resolve the agent
 * definition via `ServerAgentStore`, construct an in-process orchestrator (no
 * tracker - this Lambda IS the lifecycle owner), and run the agent to completion.
 *
 * All progress events flow to the parent's WebSocket connection as `subagent_*`
 * events, identical to the in-process subagent path. The parent's resume-after-
 * handoff path (in `processExecution`) polls this execution's terminal status
 * and injects the result into the parent's tool history.
 *
 * Credit billing: this updates the child's own `totalCreditsUsed` audit counter
 * via `incrementCreditsUsed`. No rollup to a parent (the parent reads the child
 * doc directly on resume) and no wallet deduction yet (Phase 1 known gap - a
 * future PR will add `creditService.deductCreditsWithOrgSupport`).
 *
 * KNOWN LIMITATION - no per-iteration checkpointing or self-dispatch.
 * Unlike the top-level `processExecution`, this handler runs `agent.run()` to
 * completion in a single Lambda invocation. There's no checkpoint loop and no
 * SQS self-dispatch on Lambda timeout. The realistic failure mode is a
 * `very_thorough` (10-min budget) subagent whose cold start + slow MCP tools
 * push past Lambda's 15-min budget - the child doc would be left in `running`
 * status with no recovery. Bounded in practice by `SUBAGENT_TIMEOUT_BY_THOROUGHNESS`
 * in the orchestrator (2/5/10min < 15min budget) plus the abort poller below.
 *
 * TODO (Phase 2 follow-up): port the top-level iteration loop here so dispatched
 * children also checkpoint + self-dispatch.
 */
async function processSubagentDispatch(
  childExecutionId: string,
  connectionId: string,
  context: Context,
  logger: Logger,
  depth?: number
): Promise<void> {
  logger.updateMetadata({ executionId: childExecutionId, role: 'subagent_dispatch' });
  const sendWs = createWsSender(connectionId, logger);

  let parentId: string | undefined;
  let agentName: string | undefined;

  try {
    const child = await agentExecutionRepository.findById(childExecutionId);
    if (!child) throw new Error(`Subagent execution ${childExecutionId} not found`);
    if (!child.subagentConfig) {
      throw new Error(`Subagent execution ${childExecutionId} is missing subagentConfig`);
    }

    parentId = child.parentExecutionId ?? child.spawnedByExecutionId ?? childExecutionId;
    agentName = child.subagentConfig.agentName;

    // Check abort flag before claiming.
    if (child.abortedAt) {
      await agentExecutionRepository.markAborted(childExecutionId);
      await sendWs('subagent_failed', {
        executionId: parentId,
        childExecutionId,
        agentName,
        error: 'Subagent was aborted before start',
        isTimeout: false,
      });
      return;
    }

    // Atomic CAS: only the first dispatched Lambda claims the child.
    const claimed = await agentExecutionRepository.claimExecution(childExecutionId, ['pending'], 'running');
    if (!claimed) {
      logger.warn('[CAS] Another Lambda already claimed this subagent, exiting gracefully', {
        actualStatus: child.status,
      });
      return;
    }
    await agentExecutionRepository.updateConnectionId(childExecutionId, connectionId);

    // Auth + ownership checks (mirror processExecution).
    const user = await User.findById(child.userId);
    if (!user) throw new Error(`User ${child.userId} not found`);
    const session = await sessionRepository.findById(child.sessionId);
    if (!session) throw new Error(`Session ${child.sessionId} not found`);
    if (session.userId !== child.userId) {
      await agentExecutionRepository.markFailed(childExecutionId, { message: 'Session ownership validation failed' });
      await sendWs('subagent_failed', {
        executionId: parentId,
        childExecutionId,
        agentName,
        error: 'unauthorized',
        isTimeout: false,
      });
      return;
    }
    const organization = child.organizationId ? await organizationRepository.findById(child.organizationId) : null;

    // Pre-flight credit check.
    const availableCredits = organization
      ? (organization.currentCredits ?? 0)
      : ((user as IUserDocument).currentCredits ?? 0);
    if (availableCredits <= 0) {
      await agentExecutionRepository.markFailed(childExecutionId, {
        message: 'Insufficient credits to run subagent',
      });
      await sendWs('subagent_failed', {
        executionId: parentId,
        childExecutionId,
        agentName,
        error: 'insufficient_credits',
        isTimeout: false,
      });
      return;
    }

    // Resolve LLM + models.
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(child.userId, {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    });
    const models = await getAvailableModels(apiKeyTable as ApiKeyTable);
    const modelInfo = models.find((m: { id: string }) => m.id === child.model);
    const llm = getLlmByModel(apiKeyTable as ApiKeyTable, { modelInfo, logger, endUserId: child.userId });
    if (!llm) throw new Error(`Failed to create LLM backend for model "${child.model}"`);
    llm.currentModel = child.model;

    // Resolve agent definition (built-in + user/org-scoped overlays).
    let userAgents: ServerAgentDefinition[] = [];
    let orgAgents: ServerAgentDefinition[] = [];
    try {
      const userStored = await agentRepository.listForUser(child.userId);
      userAgents = pickRunnableAgents(userStored).map(toServerAgentDefinition);
    } catch (err) {
      logger.warn('[AgentStore] Failed to load user agents for subagent dispatch', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (child.organizationId) {
      try {
        const orgStored = await agentRepository.listForOrganization(child.organizationId);
        orgAgents = pickRunnableAgents(orgStored).map(toServerAgentDefinition);
      } catch (err) {
        logger.warn('[AgentStore] Failed to load org agents for subagent dispatch', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Rebuild MCP tools on THIS invocation - a re-dispatched subagent runs in its
    // own Lambda, so the top-level path's load does not carry over. See Task 3.
    const { mcpToolsByServer, serverAgentConfig } = await loadMcpToolsSafe(child.userId, logger);
    const agentStore = new ServerAgentStore(serverAgentConfig, { userAgents, orgAgents });
    const agentDef = agentStore.getAgent(agentName);
    if (!agentDef) {
      await agentExecutionRepository.markFailed(childExecutionId, {
        message: `Unknown agent: ${agentName}`,
      });
      await sendWs('subagent_failed', {
        executionId: parentId,
        childExecutionId,
        agentName,
        error: `Unknown agent: ${agentName}`,
        isTimeout: false,
      });
      return;
    }

    // Build the full tool set - same as the top-level path. The orchestrator filters
    // these per agentDef.allowedTools/deniedTools.
    const toolDeps: ToolBuilderDeps = {
      userId: child.userId,
      user: user as IUserDocument,
      logger,
      // Delegated subagent: thread retrieval exclusion here too (same fail-open risk as the
      // parent toolbelt). Session is resolved above from the child's sessionId.
      retrievalFilter: toRetrievalFilter(session),
      db: {
        apiKeys: apiKeyRepository,
        adminSettings: adminSettingsRepository,
        fabfiles: fabFileRepository,
        fabfilechunks: fabFileChunkRepository,
        users: userRepository,
        projects: projectRepository,
        dataLakes: dataLakeRepository,
        // Required for the Lattice opt-in pool below to actually work: the
        // Lattice tools persist models to Mongo and reload them by ObjectId on
        // subsequent calls. Without this adapter they fall back to an in-memory
        // id that fails the ObjectId guard, silently breaking the
        // create->populate->query chain (same wiring as the top-level path).
        latticeModels: latticeModelRepository,
        // Audit trail for images blocked by the image_generation/edit_image tools'
        // moderation gate. The gate itself is unconditional (constructed
        // inline in the tool) - this only wires the incident record, not the block.
        imageModerationIncidents: imageModerationIncidentRepository,
      },
      sessionRepository,
      storage: getFilesStorage(),
      imageGenerateStorage: getGeneratedImageStorage(),
      imageProcessorLambdaName: Resource.ImageProcessor.name,
      llm,
      model: child.model,
      precomputed: { adminSettingsEnforceCredits: false, models },
      apiKeyTable: apiKeyTable as ApiKeyTable,
      agentStore,
      // Propagate delegation depth so the dispatched orchestrator's delegate_to_agent
      // tool starts at the right level and the depth cap fires correctly.
      depth,
    };
    const toolCallbacks: ToolBuilderCallbacks = {
      onStatusUpdate: async changes => {
        // A subagent has no Quest of its own and runs in a separate Lambda from the parent,
        // so any images it generates would never reach the chat bubble. Write them onto the
        // PARENT's Quest so they render inline alongside the parent's images ($addToSet keeps
        // both sets - see addImagesByAgentExecutionId). Best-effort: the file is already a
        // session FabFile (visible in the Knowledge Base) regardless of this write.
        //
        // `parentId` is the IMMEDIATE parent (parentExecutionId ?? spawnedByExecutionId ??
        // self). Only the top-level run has a Quest (created by handleStart), so for a nested
        // subagent - whose immediate parent is itself a subagent with no Quest - this update
        // matches nothing and is a no-op. That's acceptable: the image still persists as a
        // session FabFile and shows in the Knowledge Base; only the inline grid misses it.
        if (changes?.images?.length && parentId) {
          await questRepository.addImagesByAgentExecutionId(parentId, changes.images).catch(err =>
            logger.warn('[SubagentDispatch] failed to attach generated images to parent quest', {
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
      },
      onToolStart: async () => {},
      onToolFinish: async () => {},
      sessionId: child.sessionId,
    };
    const subagentToolConfig = buildSubagentToolConfig({
      model: child.model,
      apiKeyTable: apiKeyTable as ApiKeyTable,
      imageConfig: child.imageConfig,
    });

    // Lattice opt-in pool for this subagent (and any grandchildren it delegates
    // to). Built unconditionally and granted only when the agent's `allowedTools`
    // names `lattice_*`; mirrors the top-level path so Lattice availability is
    // identical whether a subagent runs in-process or in its own Lambda.
    const subagentLatticeTools = buildSubagentLatticeToolPool(toolDeps, toolCallbacks, subagentToolConfig);

    const tools = buildSharedTools({ ...toolDeps, optInTools: subagentLatticeTools }, toolCallbacks, {
      config: subagentToolConfig,
      mcpToolsByServer,
      // Empty on purpose: buildSharedTools RETURNS only `tools` (agent-only MCP
      // tools are excluded from the return), and that return is passed as the
      // orchestrator's parentTools below. So MCP tools must land in `tools`
      // here; the dispatched agent's allowedTools (e.g. atlassian__*) scopes
      // them. Marking them agent-only here would hide them and reproduce the
      // 0-tools bug.
      agentOnlyMcpServers: [],
    });
    if (!tools) throw new Error('Failed to build tools for dispatched subagent');

    await sendWs('subagent_started', {
      executionId: parentId,
      childExecutionId,
      agentName,
      model: child.model,
      thoroughness: child.subagentConfig.thoroughness,
      maxIterations: child.subagentConfig.maxIterations,
      isBackground: child.isBackgroundExecution ?? false,
    });

    // Streaming tracker for the orchestrator - no DB writes, just forwards step
    // events to the parent's connection. `onStart` returns the existing child id
    // so the orchestrator doesn't create a duplicate doc.
    const streamTracker: ServerSubagentTracker = {
      onStart: async () => childExecutionId,
      onStep: async ({ step, iteration }) => {
        const truncatedStep =
          step.content.length > MAX_STEP_CONTENT
            ? { ...step, content: step.content.slice(0, MAX_STEP_CONTENT) + '\n\n...(truncated)' }
            : step;
        await sendWs('subagent_iteration_step', {
          executionId: parentId,
          childExecutionId,
          agentName,
          iteration,
          step: truncatedStep,
        });
      },
      onChildProgress: async ({ status }) => {
        await sendWs('subagent_progress', {
          executionId: parentId,
          childExecutionId,
          status,
        });
      },
      onComplete: async () => {},
      onFailure: async () => {},
    };

    // Abort + deadline watchdog for dispatched subagents.
    //
    // Two triggers fire the same AbortController:
    //
    // 1. Abort flag (user/cascade): the parent's WebSocket route sets
    //    `abortedAt` on the child doc via `findBackgroundChildrenOf`
    //    (background) or `waitingOnChild` (sync handoff). Poll the DB and
    //    trip the signal when the flag flips.
    //
    // 2. Lambda deadline: this handler has no per-iteration checkpointing
    //    (see the KNOWN LIMITATION docstring above), so if we run out of
    //    wall-clock we MUST stop cleanly before AWS kills the Lambda mid-run
    //    - otherwise the child doc is left in `running` with no recovery.
    //    Trip the signal when remaining time drops below the same buffer
    //    used by the parent's resume path so the orchestrator returns a
    //    partial result we can persist.
    //
    // LIMITATION: 0..5s window where an aborted child keeps running before
    // the next poll tick. Acceptable - the agent stops at the next iteration
    // boundary inside the LLM call.
    const abortController = new AbortController();
    const abortPoller = setInterval(() => {
      // Cheap synchronous check first - no DB roundtrip if we're already done.
      if (context.getRemainingTimeInMillis() < PARENT_DEADLINE_BUFFER_MS && !abortController.signal.aborted) {
        logger.warn('[SubagentDispatch] Lambda deadline approaching — aborting agent', {
          remainingMs: context.getRemainingTimeInMillis(),
        });
        abortController.abort();
        return;
      }
      agentExecutionRepository
        .checkAbortFlag(childExecutionId)
        .then(aborted => {
          if (aborted && !abortController.signal.aborted) {
            logger.info('[SubagentDispatch] Abort flag detected — signalling agent');
            abortController.abort();
          }
        })
        .catch(err => {
          logger.warn('[SubagentDispatch] Abort poll failed (will retry next tick)', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, SUBAGENT_ABORT_POLL_MS);
    // Don't keep the event loop alive in test/non-Lambda contexts. In Lambda
    // this is a no-op (the runtime shuts down regardless); in vitest it prevents
    // the test process from hanging on a stray interval. The `?.` guards
    // browser-like runtimes where `Timer.unref` doesn't exist.
    abortPoller.unref?.();

    // Artifact-emission parity for dispatched subagents (DAG worker nodes and
    // Lambda-dispatched delegates). Give them the same `<artifact>` guidance as
    // the top-level agent so their answers carry tags the parent can surface on
    // the completion. Gated on the admin `EnableArtifacts` setting; dispatched
    // children are always fresh in-process runs (no checkpoint), so no
    // isNewExecution guard is needed.
    // Hoist the gate into a local (mirrors the top-level path) so we only read
    // ArtifactEmissionPrompt when artifacts are actually on.
    const childArtifactsEnabled = await adminSettingsRepository.getSettingsValue('EnableArtifacts');
    const childArtifactEmissionPrompt = childArtifactsEnabled
      ? (await adminSettingsRepository.getSettingsValue('ArtifactEmissionPrompt')) || ARTIFACT_EMISSION_PROMPT
      : undefined;

    logger.info('[AgentExecutor][MCP] dispatched subagent tool pool', {
      agentName,
      poolSize: tools.length,
      mcpToolNames: tools.map(t => t.toolSchema?.name).filter((n): n is string => !!n && n.includes('__')),
    });

    const orchestrator = new ServerSubagentOrchestrator({
      userId: child.userId,
      llm,
      logger,
      parentTools: tools,
      // Granted to this dispatched subagent only when its `allowedTools` names
      // `lattice_*`; the orchestrator dedupes against `parentTools`.
      optInTools: subagentLatticeTools,
      availableModels: models,
      signal: abortController.signal,
      onProgress: async (status: string) => {
        await sendWs('progress', { executionId: parentId, status });
      },
      tracker: streamTracker,
      // Restore delegation depth so the depth cap fires at the right level.
      // Without this, the orchestrator defaults to depth=1 and allows 3 more
      // levels of delegation below itself regardless of actual chain depth.
      depth,
      // Only present when artifacts are on; makes subagents emit <artifact> tags.
      ...(childArtifactEmissionPrompt && { artifactEmissionPrompt: childArtifactEmissionPrompt }),
    });

    try {
      const result = await orchestrator.delegateToAgent({
        task: child.query,
        agentDef,
        thoroughness: child.subagentConfig.thoroughness,
        variables: child.subagentConfig.variables,
        attachedFiles: child.subagentConfig.attachedFiles,
      });
      const credits = result.completionInfo.totalCredits ?? 0;

      // If the abort signal fired during the run, treat the result as terminal.
      // The orchestrator's timeout-handling path returns partial results on
      // AbortError instead of throwing - so a successful return value here can
      // still represent a terminated run.
      //
      // Disambiguate by checking the actual abort flag: if it's set in the DB,
      // the user/parent aborted us (mark aborted). Otherwise the signal was
      // fired by our own deadline watchdog (mark failed with isTimeout). The
      // distinction matters for the WS event and downstream telemetry.
      if (abortController.signal.aborted) {
        const userAborted = await agentExecutionRepository.checkAbortFlag(childExecutionId).catch(() => false);
        if (userAborted) {
          await agentExecutionRepository.markAborted(childExecutionId, {
            steps: result.steps,
            partialAnswer: result.finalAnswer,
          });
          await sendWs('subagent_failed', {
            executionId: parentId,
            childExecutionId,
            agentName,
            error: 'Subagent aborted',
            isTimeout: false,
            partialAnswer: result.finalAnswer,
          });
        } else {
          await agentExecutionRepository.markFailed(childExecutionId, {
            message: 'Subagent stopped before Lambda deadline (partial result preserved in result.steps)',
            timedOut: true,
          });
          await sendWs('subagent_failed', {
            executionId: parentId,
            childExecutionId,
            agentName,
            error: 'Subagent timed out',
            isTimeout: true,
            partialAnswer: result.finalAnswer,
          });
        }
        return;
      }

      await agentExecutionRepository.markComplete(childExecutionId, {
        answer: result.finalAnswer,
        steps: result.steps,
        totalTokens: result.completionInfo.totalTokens,
        totalIterations: result.completionInfo.iterations,
        reachedMaxIterations: result.completionInfo.reachedMaxIterations,
        totalCredits: credits,
      });
      // Update the child's own audit counter. `markComplete` stores the result
      // snapshot with `totalCredits`; `incrementCreditsUsed` updates the
      // top-level `totalCreditsUsed` field used by cap/billing queries.
      //
      // KNOWN GAP (Phase 1): no `creditService.deductCreditsWithOrgSupport`
      // call here - dispatched-subagent tokens are audited only, not deducted
      // from the user/org wallet. Tracked as a Phase 2 follow-up.
      if (credits > 0) {
        await agentExecutionRepository.incrementCreditsUsed(childExecutionId, credits);
      }
      await sendWs('subagent_completed', {
        executionId: parentId,
        childExecutionId,
        agentName,
        totalCredits: credits,
        iterations: result.completionInfo.iterations ?? 0,
        finalAnswer: result.finalAnswer,
      });

      logger.info('[SubagentDispatch] Completed', {
        agentName,
        iterations: result.completionInfo.iterations,
        totalTokens: result.completionInfo.totalTokens,
      });

      // Phase 4a - if this child was a DAG node, fire the completion hook
      // so any newly-unblocked siblings get dispatched, or the parent gets
      // woken if the whole DAG is done.
      //
      // Recovery: if the hook itself throws (SQS error, mongo error during
      // sibling scan) the parent would otherwise sit in `awaiting_dag_children`
      // forever - `cleanupStaleActive` deliberately excludes that status.
      // Catch here, mark the parent failed, and surface a WS event so the
      // session unwedges instead of hanging.
      if (child.dagNodeId) {
        try {
          await onDagNodeTerminal({
            child: {
              id: childExecutionId,
              parentExecutionId: child.parentExecutionId,
              dagNodeId: child.dagNodeId,
              status: 'completed',
            },
            connectionId,
            logger,
          });
        } catch (hookErr) {
          const msg = hookErr instanceof Error ? hookErr.message : String(hookErr);
          logger.error('[DAG] onDagNodeTerminal failed — marking parent failed', {
            parentId: child.parentExecutionId,
            childExecutionId,
            error: msg,
          });
          if (child.parentExecutionId) {
            await agentExecutionRepository
              .markFailed(child.parentExecutionId, { message: `DAG completion hook failed: ${msg}` })
              .catch(markErr => {
                logger.error('[DAG] markFailed on parent also failed', {
                  parentId: child.parentExecutionId,
                  error: markErr instanceof Error ? markErr.message : String(markErr),
                });
              });
            await sendWs('failed', {
              executionId: child.parentExecutionId,
              reason: 'dag_hook_error',
            });
          }
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Three failure shapes can reach this catch:
      //   1. Our own abort fired during the run and the orchestrator threw
      //      instead of returning a partial - `abortController.signal.aborted`
      //      is true. Treat as aborted, not failed.
      //   2. AbortError that escaped the orchestrator's own abort handling
      //      (rare; the orchestrator normally converts these to partial results).
      //   3. Real failures (LLM API error, network, etc).
      // Detect (1) and (2) reliably via the controller state + AbortError name
      // rather than a fragile `errorMessage.includes('aborted')` heuristic,
      // which would misclassify any error containing the word "aborted".
      const isAbortError = err instanceof Error && err.name === 'AbortError';
      const wasAborted = abortController.signal.aborted || isAbortError;

      if (wasAborted) {
        await agentExecutionRepository.markAborted(childExecutionId);
        await sendWs('subagent_failed', {
          executionId: parentId,
          childExecutionId,
          agentName,
          error: 'Subagent aborted',
          isTimeout: false,
        });
      } else {
        // Reaching this branch means the orchestrator threw without our deadline
        // watchdog having fired (the `wasAborted` case above handles that). So
        // this is a real downstream failure (LLM API error, network, etc.) -
        // NOT a subagent timeout. The previous substring match on `errorMessage`
        // would falsely flag any error whose message happened to contain
        // "timeout" (e.g. an LLM-API HTTP timeout) as a subagent timeout.
        await agentExecutionRepository.markFailed(childExecutionId, {
          message: errorMessage,
          timedOut: false,
        });
        await sendWs('subagent_failed', {
          executionId: parentId,
          childExecutionId,
          agentName,
          error: 'Subagent execution failed',
          isTimeout: false,
        });
      }

      // Phase 4a - DAG node terminal even on failure/abort. Same hook fires;
      // it'll detect the failed dep and dispatch only nodes that don't
      // depend on this one (or none if everything cascades).
      //
      // Recovery: same gap as the success path - if the hook throws, the
      // parent would otherwise sit in `awaiting_dag_children` indefinitely.
      // Catch and mark the parent failed so the session unwedges.
      if (child.dagNodeId) {
        try {
          await onDagNodeTerminal({
            child: {
              id: childExecutionId,
              parentExecutionId: child.parentExecutionId,
              dagNodeId: child.dagNodeId,
              status: wasAborted ? 'aborted' : 'failed',
            },
            connectionId,
            logger,
          });
        } catch (hookErr) {
          const msg = hookErr instanceof Error ? hookErr.message : String(hookErr);
          logger.error('[DAG] onDagNodeTerminal failed — marking parent failed', {
            parentId: child.parentExecutionId,
            childExecutionId,
            error: msg,
          });
          if (child.parentExecutionId) {
            await agentExecutionRepository
              .markFailed(child.parentExecutionId, { message: `DAG completion hook failed: ${msg}` })
              .catch(markErr => {
                logger.error('[DAG] markFailed on parent also failed', {
                  parentId: child.parentExecutionId,
                  error: markErr instanceof Error ? markErr.message : String(markErr),
                });
              });
            await sendWs('failed', {
              executionId: child.parentExecutionId,
              reason: 'dag_hook_error',
            });
          }
        }
      }
    } finally {
      clearInterval(abortPoller);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('[SubagentDispatch] Fatal error', { error: errorMessage });
    try {
      await agentExecutionRepository.markFailed(childExecutionId, {
        message: errorMessage,
        timedOut: false,
      });
      // `parentId` is set inside the try block; if we threw before resolving
      // it (e.g., child doc missing), we don't know the real parent. Omit the
      // `executionId` field entirely rather than aliasing it to the child id -
      // clients can detect "no parent linkage" and route to a top-level error
      // handler instead of mistakenly threading this through subagent-event UI.
      await sendWs('subagent_failed', {
        ...(parentId ? { executionId: parentId } : {}),
        childExecutionId,
        agentName,
        error: 'Subagent dispatch failed',
        isTimeout: false,
      });
    } catch (cleanupErr) {
      logger.error('[SubagentDispatch] Cleanup also failed', {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
  }
}
