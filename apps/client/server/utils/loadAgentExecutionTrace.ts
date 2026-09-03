/**
 * Load one agent execution's trace, authorized for a given caller.
 *
 * Shared by the SPA-internal route (`pages/api/agent-executions/[id]`) and the public
 * one (`pages/api/v1/agent-executions/[id]`), so the two cannot disagree about who may
 * read a run or about where `answer` / `steps` come from. The public route projects
 * this onto its snake_case wire shape; the internal one adds child-execution snapshots.
 */

import { agentExecutionRepository, sessionRepository, type AgentExecutionStatus } from '@bike4mind/database';
import type { IAgentStep } from '@bike4mind/common';
import { isSessionOwnedByUser } from '@server/utils/sessionOwnership';
import { toUserFacingFailureMessage } from '@server/queueHandlers/agentExecutor.failureMessage';

export type AgentExecutionTrace = {
  id: string;
  status: AgentExecutionStatus;
  sessionId: string | null;
  answer: string | null;
  /**
   * Failure reason, already safe to hand an external caller; null unless the run
   * failed. See `toCallerSafeError` for what that guarantee rests on.
   */
  error: string | null;
  steps: IAgentStep[];
  totalIterations: number | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Reduce a stored failure to something publishable.
 *
 * `markFailed` stores whatever the executor threw, and most call sites hand it a raw
 * exception message. Those routinely carry infrastructure identifiers - a Bedrock
 * denial names the assumed role ARN, i.e. the AWS account id, the role and the stage -
 * and this trace feeds a public, API-key-reachable route. The WebSocket transport
 * sanitizes at send time (`toUserFacingFailureMessage` in the executor's catch-all);
 * nothing sanitized this path.
 *
 * Only a message a writer explicitly flagged `callerSafe` is published verbatim. That
 * flag exists because a blanket sanitize is not sufficient either: the two
 * permission-gate messages the contract promises will name the gated tool match none
 * of the recognized categories and would collapse to "Agent execution failed",
 * breaking the documented `tools` pre-approval remedy. Unflagged is the default, so a
 * new failure path leaks nothing until someone deliberately opts it in.
 */
function toCallerSafeError(error: { message?: string; callerSafe?: boolean } | null | undefined): string | null {
  if (!error?.message) return null;
  return error.callerSafe ? error.message : toUserFacingFailureMessage(error.message);
}

/**
 * Returns null for "not found OR not yours" - the caller turns that into a 404 either
 * way, so an execution id cannot be probed for existence.
 */
export async function loadAgentExecutionTrace(id: string, userId: string): Promise<AgentExecutionTrace | null> {
  const execution = await agentExecutionRepository.findById(id);
  if (!execution) return null;

  // Ownership via the session - mirrors the access check on /api/quests/[id], and lets
  // a shared session's members read the run.
  if (execution.sessionId) {
    const session = await sessionRepository.findById(execution.sessionId);
    if (!session) return null;
    if (!isSessionOwnedByUser(session, userId)) return null;
  } else if (execution.userId !== userId) {
    // No session linkage (legacy/edge cases): fall back to a direct owner check so we
    // never leak another user's reasoning trace.
    return null;
  }

  // `result` is stored as Mongoose Mixed; `markComplete` writes
  // `{ answer, steps, totalTokens, totalIterations, reachedMaxIterations }`.
  const result = execution.result as
    { answer?: string; steps?: IAgentStep[]; totalIterations?: number } | null | undefined;

  // Fall back to the live checkpoint for non-terminal executions: `result` is only
  // populated on `markComplete`, so an in-flight run would otherwise read as empty.
  // The checkpoint carries the same shape and is what `markComplete` snapshots.
  const checkpoint = execution.checkpoint as { steps?: IAgentStep[]; iteration?: number } | null | undefined;

  return {
    id,
    status: execution.status,
    sessionId: execution.sessionId ?? null,
    answer: result?.answer ?? null,
    error: toCallerSafeError(execution.error),
    steps: result?.steps ?? checkpoint?.steps ?? [],
    totalIterations: result?.totalIterations ?? checkpoint?.iteration ?? null,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  };
}
