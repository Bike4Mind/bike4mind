import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, BadRequestError } from '@server/utils/errors';
import {
  agentExecutionRepository,
  ACTIVE_AGENT_EXECUTION_STATUSES,
  type AgentExecutionStatus,
  type SerializedAgentExecutionListItem,
} from '@bike4mind/database';
import { z } from 'zod';

// Mirror the model's `sweepableStatuses` exclusion so the API doesn't accept
// `awaiting_subagent` or `awaiting_dag_children` (healthy parents in either
// state can legitimately idle for hours while children work).
const SWEEPABLE_STATUSES = ACTIVE_AGENT_EXECUTION_STATUSES.filter(
  s => s !== 'awaiting_subagent' && s !== 'awaiting_dag_children'
) as [AgentExecutionStatus, ...AgentExecutionStatus[]];

const QuerySchema = z.object({
  minutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30)
    .default(20),
  status: z.enum(SWEEPABLE_STATUSES).optional(),
  userId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type StuckExecutionsResponse = {
  items: SerializedAgentExecutionListItem[];
  olderThanMinutes: number;
};

/**
 * GET /api/admin/agent-executions/stuck?minutes=20&status=awaiting_permission&limit=100
 *
 * Lists agent executions stuck in an active status (no natural exit path)
 * older than `minutes`. Backed by {@link agentExecutionRepository.listStuck};
 * `awaiting_subagent` is deliberately excluded - see model docstring.
 */
const handler = baseApi().get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid query parameters');
  }
  const { minutes, status, userId, limit } = parsed.data;

  const olderThan = new Date(Date.now() - minutes * 60_000);
  const items = await agentExecutionRepository.listStuck({
    olderThan,
    statuses: status ? [status] : undefined,
    userId,
    limit,
  });

  const body: StuckExecutionsResponse = {
    items: items.map(item => ({
      ...item,
      startedAt: item.startedAt?.toISOString(),
      completedAt: item.completedAt?.toISOString(),
      abortedAt: item.abortedAt?.toISOString(),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    olderThanMinutes: minutes,
  };
  return res.json(body);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
