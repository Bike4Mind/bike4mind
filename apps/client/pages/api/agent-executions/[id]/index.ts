/**
 * GET /api/agent-executions/[id] - return the iteration trace for an agent run.
 *
 * Used by the "Show reasoning" disclosure on Quest bubbles in chat history:
 * the Quest carries `agentExecutionId`, the client fetches this endpoint on
 * disclosure expand, and the returned steps are hydrated into the Zustand
 * store so an `IterationStream` can be mounted read-only.
 *
 * SPA-internal. The public twin is `GET /api/v1/agent-executions/{id}`; both load and
 * authorize through `loadAgentExecutionTrace`, and this one additionally returns child
 * snapshots for nested rendering. We do not return billing details (token counts,
 * credits) since they're not relevant to the user-facing trace.
 */

import type { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@server/utils/errors';
import { loadAgentExecutionTrace } from '@server/utils/loadAgentExecutionTrace';
import { buildChildExecutionSnapshots } from '@server/utils/childExecutionSnapshot';

const handler = baseApi().get(async (req: Request<{ id: string }>, res) => {
  const { id } = req.query as { id: string };
  const userId = req.user?.id;

  if (!id) {
    throw new BadRequestError('Execution ID is required');
  }
  if (!userId) {
    throw new UnauthorizedError('Authentication required');
  }

  const trace = await loadAgentExecutionTrace(id, userId);
  if (!trace) {
    throw new NotFoundError('Execution not found');
  }

  // Child subagent snapshots for the "Show reasoning" disclosure to re-render
  // nested step traces under their parent's `delegate_to_agent` action. Also
  // serves as the REST fallback for the WS reconnect path when the inline
  // payload would exceed the API Gateway frame budget. Background children are
  // filtered out by query: they surface via the header badge, not inline
  // nesting.
  const children = await buildChildExecutionSnapshots(id);

  return res.json({
    id,
    status: trace.status,
    answer: trace.answer,
    steps: trace.steps,
    totalIterations: trace.totalIterations,
    children,
  });
});

export default handler;
