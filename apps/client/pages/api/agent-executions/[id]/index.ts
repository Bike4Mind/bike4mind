/**
 * GET /api/agent-executions/[id] - return the iteration trace for an agent run.
 *
 * Used by the "Show reasoning" disclosure on Quest bubbles in chat history:
 * the Quest carries `agentExecutionId`, the client fetches this endpoint on
 * disclosure expand, and the returned steps are hydrated into the Zustand
 * store so an `IterationStream` can be mounted read-only.
 *
 * Ownership is verified through the AgentExecution's session - the same
 * pattern as `/api/quests/[id]`. We do not return billing details (token
 * counts, credits) since they're not relevant to the user-facing trace.
 */

import type { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { agentExecutionRepository, sessionRepository } from '@bike4mind/database';
import type { IAgentStep } from '@bike4mind/common';
import { buildChildExecutionSnapshots } from '@server/utils/childExecutionSnapshot';

const handler = baseApi().get(async (req: Request<{ id: string }>, res) => {
  const { id } = req.query as { id: string };
  const userId = req.user?.id;

  if (!id) {
    throw new BadRequestError('Execution ID is required');
  }

  const execution = await agentExecutionRepository.findById(id);
  if (!execution) {
    throw new NotFoundError('Execution not found');
  }

  // Ownership via the session - mirrors the access check on /api/quests/[id].
  // The execution.userId field would also work but session-based check stays
  // consistent with shared-session semantics if that ever applies here.
  if (execution.sessionId) {
    const session = await sessionRepository.findById(execution.sessionId);
    if (!session) {
      throw new NotFoundError('Execution not found');
    }
    const userHasAccess = session.userId === userId || session.users?.some(share => share.userId === userId);
    if (!userHasAccess) {
      throw new NotFoundError('Execution not found');
    }
  } else if (execution.userId !== userId) {
    // Fallback: no session linkage (legacy/edge cases) - fall back to direct
    // owner check so we never leak another user's reasoning trace.
    throw new NotFoundError('Execution not found');
  }

  // `result` is stored as Mongoose Mixed; `markComplete` writes
  // `{ answer, steps, totalTokens, totalIterations, reachedMaxIterations }`.
  // We only surface the fields the client needs to render the trace.
  const result = execution.result as
    | { answer?: string; steps?: IAgentStep[]; totalIterations?: number }
    | null
    | undefined;

  // Fall back to the live checkpoint for non-terminal executions: `result` is
  // only populated on `markComplete`, so an in-flight run reconnect reads empty
  // steps without this. The checkpoint carries the same shape (AgentStep[]) and
  // is the source `markComplete` itself snapshots.
  const checkpoint = execution.checkpoint as { steps?: IAgentStep[]; iteration?: number } | null | undefined;
  const steps = result?.steps ?? checkpoint?.steps ?? [];
  const totalIterations = result?.totalIterations ?? checkpoint?.iteration ?? null;

  // Child subagent snapshots for the "Show reasoning" disclosure to re-render
  // nested step traces under their parent's `delegate_to_agent` action. Also
  // serves as the REST fallback for the WS reconnect path when the inline
  // payload would exceed the API Gateway frame budget. Background children are
  // filtered out by query: they surface via the header badge, not inline
  // nesting.
  const children = await buildChildExecutionSnapshots(id);

  return res.json({
    id,
    status: execution.status,
    answer: result?.answer ?? null,
    steps,
    totalIterations,
    children,
  });
});

export default handler;
