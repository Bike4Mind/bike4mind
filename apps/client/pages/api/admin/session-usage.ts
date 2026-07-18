import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, agentExecutionRepository } from '@bike4mind/database';
import type { ISessionAgentExecution, ISessionAgentModelUsage, ISessionUsageResponse } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

const QuerySchema = z.object({
  sessionId: z.string().min(1),
});

/**
 * Admin endpoint: one session's usage detail - spend rolled up by quest and by
 * model (from UsageEventModel, which carries frozen COGS), plus each agent
 * execution that ran in the session with its per-model iteration billing.
 * Answers "why did this session cost what it did?".
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { sessionId } = QuerySchema.parse(req.query);

  const [usage, execDocs] = await Promise.all([
    usageEventRepository.sessionUsageSummary(sessionId),
    agentExecutionRepository.findBillingBySessionId(sessionId),
  ]);

  const executions: ISessionAgentExecution[] = execDocs.map(exec => {
    const byModel = new Map<string, ISessionAgentModelUsage>();
    for (const ib of exec.iterationBilling ?? []) {
      const row = byModel.get(ib.model) ?? {
        model: ib.model,
        iterations: 0,
        credits: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      row.iterations += 1;
      row.credits += ib.credits;
      row.inputTokens += ib.inputTokens;
      row.outputTokens += ib.outputTokens;
      row.cacheReadTokens += ib.cacheReadTokens;
      row.cacheWriteTokens += ib.cacheWriteTokens;
      byModel.set(ib.model, row);
    }
    return {
      executionId: String(exec.id),
      status: exec.status,
      parentExecutionId: exec.parentExecutionId,
      totalCreditsUsed: exec.totalCreditsUsed ?? 0,
      iterationCount: exec.iterationBilling?.length ?? 0,
      byModel: [...byModel.values()].sort((a, b) => b.credits - a.credits),
    };
  });

  const response: ISessionUsageResponse = { sessionId, usage, executions };
  return res.json(response);
});

export default handler;
