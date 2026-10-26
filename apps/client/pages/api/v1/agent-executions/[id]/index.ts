/**
 * GET /api/v1/agent-executions/{id} - poll a run started by POST /api/v1/agent-executions.
 *
 * The job resource for the async start (CONVENTIONS.md section 4). Loading and
 * authorization are shared with the SPA-internal route via `loadAgentExecutionTrace`;
 * this handler only projects the trace onto the published snake_case shape.
 */

import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { getAgentExecutionContract, visibleReplyText, type AgentExecutionStep } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { loadAgentExecutionTrace } from '@server/utils/loadAgentExecutionTrace';

// `visibleReplyText` keeps interior whitespace for slot joining, so whatever follows a
// stripped </think> would otherwise lead the published text.
const publicText = (text: string): string => visibleReplyText(text).trim();

const handler = nextRouteForContract(getAgentExecutionContract, {
  // Polling a single run should cost one daily slot, not one per poll. Only safe
  // methods are exempted, and the per-minute burst limit still applies.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const trace = await loadAgentExecutionTrace(req.validatedParams.id, req.user.id);
  if (!trace) {
    throw new NotFoundError('Execution not found');
  }

  const answer = trace.answer === null ? null : publicText(trace.answer);
  const finalText = (content: string): string =>
    answer !== null && content === trace.answer ? answer : publicText(content);

  // Public projection of the internal step shape: the published trace is deliberately
  // narrower than `IAgentStep` (no token usage, no confidence telemetry) so those stay
  // free to change without a breaking API change.
  //
  // The stored answer and final_answer step carry the adapter's inlined reasoning
  // (<think> spans), which the UI hides with the same `visibleReplyText` rule. Thought
  // steps are reasoning by design and stay raw.
  const steps: AgentExecutionStep[] = trace.steps.map(step => ({
    type: step.type,
    content: step.type === 'final_answer' ? finalText(step.content) : step.content,
    ...(step.metadata?.iteration != null ? { iteration: step.metadata.iteration } : {}),
    ...(step.metadata?.toolName ? { tool_name: step.metadata.toolName } : {}),
  }));

  return res.json({
    id: trace.id,
    status: trace.status,
    session_id: trace.sessionId,
    answer,
    error: trace.error,
    steps,
    total_iterations: trace.totalIterations,
    created_at: trace.createdAt.toISOString(),
    updated_at: trace.updatedAt.toISOString(),
  });
});

export default handler;
