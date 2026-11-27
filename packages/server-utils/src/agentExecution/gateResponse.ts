import { adminSettingsRepository, agentExecutionRepository } from '@bike4mind/database';
import type { AgentCheckpoint } from '@bike4mind/agents';
import type { Logger } from '@bike4mind/observability';
import { endAgentRunLiveActivity } from '../utils/liveActivityPush';
import { persistRunAsQuest } from '../utils/persistRunAsQuest';
import { startEventBriefForCompletedRun } from '../briefs/eventBriefTrigger';
import { reopenLowConfidenceAnswer } from '../utils/reopenLowConfidenceAnswer';
import { extractFinalAnswer } from '../utils/extractFinalAnswer';
import { resolveAndPublishMementoCompletion } from '../utils/publishMementoCompletion';
import {
  dispatchAgentExecution,
  resolveAgentExecutorTarget,
  AgentExecutorRejectedError,
} from '../utils/dispatchAgentExecution';
import { sendAgentEvent } from './sendAgentEvent';

// The `agent_execute` WebSocket route (apps/client/server/websocket/agentExecute.ts) dispatches
// `gate_response` messages here; passing its parsed GateResponseSchema value to handleGateResponse is
// what keeps that schema assignable to GateResponseCommand at compile time.

/** Fields `handleGateResponse` reads from the validated `gate_response` WebSocket message. */
export type GateResponseCommand = {
  executionId: string;
  decision: 'continue' | 'stop';
};

/**
 * Handle a client response to a confidence-gate pause. Two outcomes:
 * - `continue` -> clear `pendingGate`, transition `paused -> continuing`,
 *   re-invoke the executor. Mirrors the structural template of
 *   `handlePermissionResponse` so the CAS contract on the executor side
 *   (`['continuing'] -> 'running'`) is satisfied identically.
 * - `stop` -> mark the execution complete with the partial answer captured
 *   in the checkpoint so far, and emit a `completed` event. The user keeps
 *   whatever the agent had produced before the gate fired.
 *
 * A completion-time pause (`pendingCompletion` set, see `low_confidence_completion` in the
 * executor) holds a finished answer instead: Stop accepts it and finalizes the executor's
 * snapshot exactly as a normal completion would, and Continue reopens the answer with a verify
 * nudge (`reopenLowConfidenceAnswer`) before resuming. Continue also accepts when there is no
 * answer step to reopen or no iteration left to reconsider in, rather than lose the answer.
 *
 * Validates `executionId` ownership and current status. Silently ignores
 * gate responses for executions not in `paused` to defend against stale
 * client retries.
 */
export async function handleGateResponse(
  cmd: GateResponseCommand,
  userId: string,
  connectionId: string,
  endpoint: string,
  logger: Logger
): Promise<void> {
  const execution = await agentExecutionRepository.findById(cmd.executionId);
  if (!execution || execution.userId !== userId) return;
  if (execution.status !== 'paused') {
    logger.warn('[Gate] gate_response received for non-paused execution \u2014 ignoring', {
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
    const cleared = await agentExecutionRepository.clearPendingGate(
      cmd.executionId,
      execution.pendingCompletion ? { keepCompletion: true } : undefined
    );
    if (!cleared) {
      logger.warn('[Gate] Stop ignored \u2014 clearPendingGate matched 0 docs (likely aborted concurrently)', {
        executionId: cmd.executionId,
      });
      return;
    }
    const checkpoint = execution.checkpoint as AgentCheckpoint | undefined;
    if (execution.pendingCompletion) {
      await acceptHeldCompletion(execution, connectionId, endpoint, logger);
      return;
    }
    const finalAnswer = checkpoint ? extractFinalAnswer(checkpoint.steps) : undefined;
    await agentExecutionRepository.markComplete(cmd.executionId, {
      answer: finalAnswer,
      steps: checkpoint?.steps ?? [],
      totalTokens: checkpoint?.totalTokens ?? 0,
      totalIterations: checkpoint?.iteration ?? 0,
      stoppedByGate: true,
    });
    await endAgentRunLiveActivity(execution, { status: 'completed' }, logger);
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
    await startEventBriefForCompletedRun(cmd.executionId, execution, logger);
    logger.info('[Gate] Stopped execution with partial answer', { executionId: cmd.executionId });
    return;
  }

  const executorTarget = resolveAgentExecutorTarget();
  if (!executorTarget) throw new Error('Agent execution is not configured');

  // decision === 'continue' - clear the gate and resume.
  const reopened =
    execution.pendingCompletion?.canReconsider && execution.checkpoint
      ? reopenLowConfidenceAnswer(execution.checkpoint as AgentCheckpoint)
      : null;
  if (execution.pendingCompletion && !reopened) {
    if (await agentExecutionRepository.clearPendingGate(cmd.executionId, { keepCompletion: true })) {
      await acceptHeldCompletion(execution, connectionId, endpoint, logger);
    } else {
      logger.warn('[Gate] Continue ignored - clearPendingGate matched 0 docs', { executionId: cmd.executionId });
    }
    return;
  }
  const cleared = await agentExecutionRepository.clearPendingGate(
    cmd.executionId,
    reopened ? { checkpoint: reopened } : undefined
  );
  if (!cleared) {
    // Either the doc no longer exists or the execution was aborted between
    // the status check above and now. Bail rather than re-invoke into a
    // state the executor's CAS will reject.
    logger.warn('[Gate] clearPendingGate matched 0 docs \u2014 likely aborted concurrently', {
      executionId: cmd.executionId,
    });
    return;
  }
  await agentExecutionRepository.updateStatus(cmd.executionId, 'continuing');

  // Note: checkpointDepth is not carried here - same limitation as the permission_response path in
  // apps/client/server/websocket/agentExecute.ts. Gate resumes are user-driven and cannot cause a
  // runaway loop on their own, so like a permission resume this click does not spend the executor's
  // MAX_LAMBDA_HANDOFFS budget (`resumedBy: 'user'`); a timeout self-dispatch after it still does.
  try {
    await dispatchAgentExecution({ executionId: cmd.executionId, connectionId, resumedBy: 'user' }, executorTarget);
  } catch (error) {
    // A lost ACK may still have queued work. Only an explicit rejection permits rollback.
    if (error instanceof AgentExecutorRejectedError) {
      await agentExecutionRepository.restoreRejectedResume(cmd.executionId, {
        status: 'paused',
        pendingGate: execution.pendingGate,
        ...(execution.pendingCompletion && { pendingCompletion: execution.pendingCompletion }),
        ...(reopened && { checkpoint: execution.checkpoint }),
      });
    }
    throw error;
  }

  logger.info('[Gate] Continue - executor re-invoked', { executionId: cmd.executionId });
}

/**
 * Finalize the result a completion-time `block` pause held back, with the same result shape,
 * `completed` event, Quest write and memento publish as the executor's normal completion.
 * Caller must have won `clearPendingGate` first.
 */
async function acceptHeldCompletion(
  execution: NonNullable<Awaited<ReturnType<typeof agentExecutionRepository.findById>>>,
  connectionId: string,
  endpoint: string,
  logger: Logger
): Promise<void> {
  const completion = execution.pendingCompletion;
  if (!completion) return;
  const checkpoint = execution.checkpoint as AgentCheckpoint | undefined;
  // Absent optionals in the Mixed snapshot read back as null; the completion path passes undefined.
  const answer = completion.answer ?? undefined;
  await agentExecutionRepository.markComplete(execution.id, {
    answer,
    steps: checkpoint?.steps ?? [],
    totalTokens: completion.totalTokens,
    totalIterations: completion.totalIterations,
    reachedMaxIterations: completion.reachedMaxIterations,
    lowConfidence: completion.lowConfidence,
  });
  await endAgentRunLiveActivity(execution, { status: 'completed' }, logger);
  await persistRunAsQuest(
    execution.id,
    completion.replyText,
    logger,
    completion.generatedImages,
    completion.finishReason ?? undefined,
    completion.allSideEffects,
    completion.retrievalSummary ?? undefined
  );
  await resolveAndPublishMementoCompletion(execution, { db: { adminSettings: adminSettingsRepository } }, logger);
  try {
    await sendAgentEvent(connectionId, endpoint, {
      action: 'completed',
      executionId: execution.id,
      answer,
      totalIterations: completion.totalIterations,
      totalCreditsUsed: execution.totalCreditsUsed,
      mementoIds: execution.usedMementoIds ?? [],
    });
  } catch (error) {
    logger.warn('[Gate] Completed event not delivered', {
      executionId: execution.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await startEventBriefForCompletedRun(execution.id, execution, logger);
  logger.info('[Gate] Accepted low-confidence completion', { executionId: execution.id });
}
