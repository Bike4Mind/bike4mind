/**
 * Transport-agnostic dispatch into the agent executor (ReAct) pipeline.
 *
 * The WebSocket `agent_execute` route (`@server/websocket/agentExecute.ts`) and the
 * public REST route (`pages/api/v1/agent-executions/index.ts`) both start a run, and
 * both must apply the SAME guards - session ownership, organization membership, the
 * stale-active sweep, the per-user concurrency cap - and create the SAME two documents
 * (AgentExecution + the dispatch-time prompt Quest) before dispatching the executor.
 * Duplicating that across two transports is how the two drift; it lives here instead.
 *
 * The function returns guard refusals and never speaks HTTP or WebSocket:
 * it returns a discriminated {@link StartAgentExecutionResult} and each caller maps the
 * `reason` onto its own wire (an `agent_error` frame, or an HTTP status).
 * Operational quota errors throw so each transport can preserve their retry metadata.
 */

import {
  agentExecutionRepository,
  organizationRepository,
  sessionRepository,
  sessionToolApprovalRepository,
  userRepository,
  Quest,
  type AgentExecutionStatus,
} from '@bike4mind/database';
import type { GenerateImageToolCall, AudioGenerationToolCall, IChatHistoryItem } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { credentialExecutionFields, type ApiKeyCredential } from '@server/dataLakes/dataLakeScopes';
import type { ApiKeyInfo } from '@server/cli/auth';
import { apiKeyBillingOrgId, resolveApiKeyBillingOrg } from '@server/billing/apiKeyBillingOrg';
import { adminRoleWithheldFor } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { MAX_CONCURRENT_EXECUTIONS_PER_USER, STALE_ACTIVE_MS } from '@server/utils/executionLimits';
import {
  dispatchAgentExecution,
  resolveAgentExecutorTarget,
  AgentExecutorRejectedError,
} from '@server/utils/dispatchAgentExecution';
import { settleStrandedQuests } from '@bike4mind/server-utils/utils/settleStrandedQuests';
import { isHeadlessConnection } from '@bike4mind/server-utils/utils/headlessConnection';
import { pinFilesToSessionKnowledge } from '@server/managers/sessionCrud';
import { admitApiKeyCompletion } from '@server/utils/untrustedCompletionQuota';
import { pinnableMessageFileIds } from '@bike4mind/server-utils/managers/pinnableMessageFileIds';

/**
 * Per-user, in-container memoization of the stale-active sweep. The sweep is an
 * `updateMany` on every start; a user firing several in quick succession would
 * otherwise pay that write each time. Module scope so it survives warm invocations.
 *
 * Pruned rather than left to grow: an entry past the TTL can no longer suppress a
 * sweep, so keeping it buys nothing. It matters now that this runs in the frontend
 * server as well as the WebSocket handler - the longer-lived and higher-cardinality of
 * the two, where the map would otherwise hold one entry per distinct caller for the
 * life of the container.
 */
const SWEEP_MEMO_TTL_MS = 60 * 1000;
const lastSweptAtByUser = new Map<string, number>();

/** Drops entries that are already past the TTL. O(size), on the sweep path only. */
function pruneSweepMemo(now: number): void {
  for (const [userId, sweptAt] of lastSweptAtByUser) {
    if (now - sweptAt > SWEEP_MEMO_TTL_MS) lastSweptAtByUser.delete(userId);
  }
}

/**
 * Exported for `startAgentExecution.test.ts`. Unbounded growth is invisible from the
 * function's return value - an expired entry no longer suppresses a sweep either way -
 * so the map's size is the only thing a test can assert on.
 */
export function sweepMemoSize(): number {
  return lastSweptAtByUser.size;
}

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
   * different id and is forwarded to the executor separately.
   */
  questId: string;
  query: string;
  model: string;
  /** `HEADLESS_CONNECTION_ID` (`@bike4mind/server-utils/utils/headlessConnection`) when there is no WS peer. */
  connectionId: string;
  /**
   * The org to bill, or omitted for the caller personally. An org-billed `apiKeyInfo` overrides it:
   * the key's org pays, and naming any other org is refused (`billing_organization_mismatch`).
   */
  organizationId?: string;
  /**
   * Persisted IAgent id. When present the executor resolves that agent's orchestration
   * profile; when absent it builds a synthetic profile from admin defaults - or, on an
   * optimizer-surface session, the surface's own profile. That surface branch is what
   * makes agent mode reproducible from any transport without a transport-specific flag.
   */
  agentId?: string;
  enabledTools?: string[];
  /**
   * Marks `enabledTools` as the caller's AMBIENT picks, to be unioned onto the resolved
   * orchestration profile rather than replacing it (`pickEffectiveEnabledTools`). Forwarded to
   * the executor only - it deliberately does NOT feed `approvedTools` below, which stays keyed
   * to the raw list a headless caller sent. Interactive chat sets it; the public REST route
   * never does.
   */
  enabledToolsAreAmbient?: boolean;
  /**
   * The authenticating API key (`req.apiKeyInfo`), never a request body; `undefined` for a signed-in
   * session. Required as a property so each door states it. The persisted `authOrigin`,
   * `scopeDeniedTools` and `apiKeyId` are all derived from it here so a door cannot forward one
   * without the others.
   */
  apiKeyInfo:
    (ApiKeyCredential & Pick<ApiKeyInfo, 'billingOwnerType' | 'organizationId' | 'ownerUntrusted'>) | undefined;
  maxIterations?: number;
  messageFileIds?: string[];
  /**
   * Pin this run's notebook-scope `messageFileIds` to the session (except `messageOnlyFileIds`), so
   * they stay in context on later turns, as the chat path does. Set by the in-app door; the public
   * REST route leaves its `file_ids` per-run.
   */
  pinMessageFiles?: boolean;
  messageOnlyFileIds?: string[];
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
  /**
   * Extra system context for this run only. Forwarded on the executor start payload and
   * kept off the execution doc's own fields and the Quest: the executor folds it into the
   * system message, carried in the server-only checkpoint so continuations keep it.
   */
  systemContext?: string;
  /**
   * Scripted per-iteration gate confidences (see `IAgentExecution.confidenceOverrides`).
   * Admin-only: any other caller is refused with `confidence_overrides_forbidden`.
   */
  confidenceOverrides?: number[];
};

/** Why a start was refused. Callers map these onto their own transport's errors. */
export type StartAgentExecutionFailureReason =
  | 'session_not_found'
  | 'organization_not_found'
  | 'billing_organization_mismatch'
  | 'billing_key_stale'
  | 'confidence_overrides_forbidden'
  | 'concurrent_limit'
  | 'dispatch_failed';

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
      /** Set only for `dispatch_failed` - the doc exists but dispatch acceptance was not confirmed. */
      executionId?: string;
    };

export async function startAgentExecution(
  input: StartAgentExecutionInput,
  logger: Logger
): Promise<StartAgentExecutionResult> {
  const { userId } = input;

  // A key without the admin scope does not carry its owner's admin role (see withholdAdminRole).
  if (input.confidenceOverrides && (adminRoleWithheldFor(input.apiKeyInfo) || !(await isAdminUser(userId)))) {
    logger.warn('[Start] Non-admin caller sent confidenceOverrides', { userId });
    return {
      ok: false,
      reason: 'confidence_overrides_forbidden',
      message: 'Only an admin can set confidence overrides',
    };
  }

  // Validate session ownership before creating anything.
  const session = await sessionRepository.findById(input.sessionId);
  if (!session || session.userId !== userId) {
    logger.warn('[Start] Session ownership validation failed', { sessionId: input.sessionId, userId });
    return { ok: false, reason: 'session_not_found', message: 'Session not found or unauthorized' };
  }

  const billing = await resolveRunBillingOrg(input, logger);
  if (!billing.ok) return billing;
  const { organizationId } = billing;

  // Queued work does not occupy a synchronous completion slot. Both transports must
  // still refuse starts while the verified personal-key owner's token window is full.
  if (input.apiKeyInfo) {
    await admitApiKeyCompletion({
      owner: userId,
      ownerUntrusted: input.apiKeyInfo.ownerUntrusted,
      billingOwnerType: input.apiKeyInfo.billingOwnerType,
      holdSlot: false,
    });
  }

  // Sweep stale active executions before counting - `pending` / `running` /
  // `continuing` / `awaiting_permission` / `paused` that the executor never
  // finished (SQS handoff dropped, executor crashed, SST live-lambda tunnel
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
    // Prune before the insert, so a container that only ever sees one-shot callers
    // still converges instead of accumulating an entry per caller.
    pruneSweepMemo(now);
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
    // Write the rejection into chat history ONLY for a transport that has a gap to
    // fill: the live UI showed a prompt bubble + toast, and without a Quest the next
    // page load shows an empty notebook with no explanation. The marker prefix keeps it
    // visually distinct from a real reply.
    //
    // A headless caller has no such gap - it gets this same text back in the 409 body -
    // so writing one would let a rejected API call permanently mutate chat history,
    // leaving a `done` Quest with a `System:` reply no model produced. A client
    // retrying against a full cap would leave one per attempt.
    //
    // Best-effort: a Quest write failure must not turn this rejection into an error.
    if (!isHeadlessConnection(input.connectionId)) {
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
    }
    return { ok: false, reason: 'concurrent_limit', message };
  }

  // Resolved BEFORE anything is created: an unlinked executor is a deployment gap,
  // and failing here leaves no orphan AgentExecution/Quest behind for a run that was
  // never going to start. Hosted function names come from different SST links depending
  // on the calling Lambda - see resolveAgentExecutorFunctionName.
  let executorTarget;
  try {
    executorTarget = resolveAgentExecutorTarget();
  } catch {
    return { ok: false, reason: 'dispatch_failed', message: 'Agent execution is not configured correctly.' };
  }
  if (!executorTarget) {
    logger.error('[Start] Agent executor is not linked to this deployment - cannot dispatch', { userId });
    return {
      ok: false,
      reason: 'dispatch_failed',
      message: 'Agent execution is not available in this deployment.',
    };
  }

  // Decisions the user asked this notebook to remember. Without this the approval the
  // permission card just collected dies with the execution, so the same tool prompts again
  // on the next message - see `handlePermissionResponse`, which writes the other half.
  const remembered = await sessionToolApprovalRepository.findByUserAndSession(userId, input.sessionId).catch(error => {
    logger.warn('[Start] Could not load remembered tool approvals - starting with none', {
      userId,
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  const execution = await agentExecutionRepository.create({
    userId,
    organizationId,
    sessionId: input.sessionId,
    questId: input.questId,
    query: input.query,
    model: input.model,
    status: 'pending' as AgentExecutionStatus,
    connectionId: input.connectionId,
    // A headless run has nobody to answer a permission prompt, so naming a tool in the
    // request IS the caller's approval - otherwise the first gated tool the agent reaches
    // for kills the run. Read-only tools no longer need that crutch (they classify as
    // allowed on their own declaration), but a side-effecting tool the caller explicitly
    // asked for still does. An interactive run ignores the dispatch payload and takes only
    // what the user chose to remember in this notebook, which is strictly better than
    // trusting a client-supplied tool list.
    approvedTools: isHeadlessConnection(input.connectionId)
      ? (input.enabledTools ?? [])
      : (remembered?.approvedTools ?? []),
    // A headless caller's explicit tool list is the approval; it must not be second-guessed by a
    // stale interactive-session denial (deny is checked first in classifyToolPermission).
    deniedTools: isHeadlessConnection(input.connectionId) ? [] : (remembered?.deniedTools ?? []),
    ...credentialExecutionFields(input.apiKeyInfo),
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
    // Snapshot the forwarded context on the doc so continuation invocations
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
    confidenceOverrides: input.confidenceOverrides,
  });

  const executionId = execution.id;

  // After the run is accepted, so a refused start pins nothing; this run carries the files itself.
  // Runs alongside the prompt Quest persist below and is awaited before dispatch, so it adds no
  // latency of its own. pinFilesToSessionKnowledge never throws.
  const messagePins = input.pinMessageFiles
    ? pinnableMessageFileIds(input.messageFileIds, input.messageOnlyFileIds)
    : [];
  const pinning =
    messagePins.length > 0
      ? userRepository
          .findById(userId)
          .catch(error => {
            logger.warn('[Start] Could not load the user for the session knowledge pin', { userId, error });
            return null;
          })
          .then(user => (user ? pinFilesToSessionKnowledge(session, messagePins, { user, logger }) : undefined))
      : Promise.resolve();

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
      // Message files only, matching the chat path (ChatCompletionInvoke): the sent message's
      // attachment chip reads them off the Quest.
      fabFileIds: input.messageFileIds ?? [],
    });
    const linkedQuestId = quest.id;
    persistedQuestId = linkedQuestId;
    // Persisted on the execution doc (not just forwarded in the start payload below) so a
    // resumed/checkpointed executor invocation still has the real Quest id available for
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

  await pinning;
  logger.info('[Start] Created execution, dispatching executor', { executionId, persistedQuestId });

  // Invoke the agent executor (async - don't wait for completion). If dispatch is
  // refused (a Lambda invoke error, or an HTTP `AgentExecutorRejectedError`), tear down
  // the dispatch-time Quest so we don't leak a `pending` bubble with no reply and no
  // iteration trace. An HTTP failure that is not a rejection (network, timeout, 5xx)
  // leaves acceptance unconfirmed, so it keeps the Quest and returns early. Either way the
  // AgentExecution doc lingers as `pending`; the stale-active sweep above reaps it on
  // the next start by the same user.
  try {
    await dispatchAgentExecution(
      {
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
        organizationId,
        agentId: input.agentId,
        enabledTools: input.enabledTools,
        enabledToolsAreAmbient: input.enabledToolsAreAmbient,
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
        // Start-payload only (see `systemContext` on the input type). Spread so a run
        // without it dispatches the same payload as before.
        ...(input.systemContext ? { systemContext: input.systemContext } : {}),
      },
      executorTarget
    );
  } catch (invokeErr) {
    if (executorTarget.kind === 'http' && !(invokeErr instanceof AgentExecutorRejectedError)) {
      return {
        ok: false,
        reason: 'dispatch_failed',
        message: `Execution ${executionId} dispatch could not be confirmed. Check it before starting another run.`,
        executionId,
      };
    }
    logger.error('[Start] Executor rejected dispatch - cleaning up dispatch-time Quest', {
      executionId,
      persistedQuestId,
      error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
    });
    if (persistedQuestId) {
      await Quest.deleteOne({ _id: persistedQuestId }).catch(deleteErr => {
        logger.warn('[Start] Failed to clean up dispatch-time Quest after executor rejection', {
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

  logger.info('[Start] Executor dispatched', { executionId });
  return { ok: true, executionId, questId: persistedQuestId };
}

async function isAdminUser(userId: string): Promise<boolean> {
  const user = await userRepository.findById(userId);
  return user?.isAdmin === true;
}

type RunBillingOrg =
  { ok: true; organizationId: string | undefined } | Extract<StartAgentExecutionResult, { ok: false }>;

/**
 * The org a run bills, or undefined for the caller personally.
 *
 * An org-billed API key bills its own org on every transport, whether or not the start names one, by
 * the same rule as the v1 media routes (resolveApiKeyBillingOrg). Anyone else bills the org they
 * name, which must be one they belong to: without this, a caller could pass another tenant's
 * organizationId and bill that org's credit pool.
 */
async function resolveRunBillingOrg(input: StartAgentExecutionInput, logger: Logger): Promise<RunBillingOrg> {
  const { userId } = input;

  // Also decides whether the user read below is needed: only an org-billed key can fail on billing
  // before the membership check, and resolveApiKeyBillingOrg applies the same key test.
  if (apiKeyBillingOrgId(input.apiKeyInfo)) {
    const user = await userRepository.findById(userId);
    const billing = await resolveApiKeyBillingOrg({
      apiKeyInfo: input.apiKeyInfo,
      user: { id: userId, isAdmin: user?.isAdmin ?? false },
      requestedOrgId: input.organizationId,
    });
    switch (billing.kind) {
      case 'org':
        return { ok: true, organizationId: billing.organizationId };
      case 'mismatch':
        return { ok: false, reason: 'billing_organization_mismatch', message: billing.message };
      case 'stale':
        logger.warn('[Start] Org-billed API key no longer speaks for its organization', {
          userId,
          keyId: input.apiKeyInfo?.keyId,
        });
        return { ok: false, reason: 'billing_key_stale', message: billing.message };
      case 'not_org_billed':
        break;
    }
  }

  if (!input.organizationId) return { ok: true, organizationId: undefined };

  const org = await organizationRepository.findById(input.organizationId);
  const isOwner = org?.userId === userId;
  const isMember = org?.users?.some(u => u.userId === userId) ?? false;
  if (!org || (!isOwner && !isMember)) {
    logger.warn('[Start] Organization membership validation failed', {
      organizationId: input.organizationId,
      userId,
    });
    return { ok: false, reason: 'organization_not_found', message: 'Organization not found or unauthorized' };
  }
  return { ok: true, organizationId: input.organizationId };
}
