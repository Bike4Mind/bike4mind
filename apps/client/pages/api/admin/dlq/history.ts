import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, BadRequestError } from '@server/utils/errors';
import { dlqReplayLogRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const QuerySchema = z.object({
  queue: z.string().optional(),
  status: z.enum(['success', 'failed', 'skipped']).optional(),
  startDate: z
    .string()
    .optional()
    .refine(val => !val || !isNaN(Date.parse(val)), { message: 'Invalid startDate format' }),
  endDate: z
    .string()
    .optional()
    .refine(val => !val || !isNaN(Date.parse(val)), { message: 'Invalid endDate format' }),
  search: z.string().max(200).optional(),
  limit: z
    .string()
    .optional()
    .transform(val => {
      const parsed = val ? parseInt(val, 10) : 50;
      return Math.min(Math.max(parsed, 1), 200);
    }),
});

/**
 * GET /api/admin/dlq/history?queue=<label>&status=<status>&startDate=<iso>&endDate=<iso>&search=<text>&limit=50
 *
 * Returns DLQ replay history with optional filters.
 */
const handler = baseApi().get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const result = QuerySchema.safeParse(req.query);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid query parameters');
  }

  const { queue, status, startDate, endDate, search, limit } = result.data;
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  Logger.info(`[DLQ History] Fetching history`, { adminUserId, queue, status, startDate, endDate, search, limit });

  const history = await dlqReplayLogRepository.findRecent({
    queueLabel: queue,
    status,
    startDate: startDate ? new Date(startDate) : undefined,
    endDate: endDate ? new Date(endDate) : undefined,
    search,
    limit,
  });

  Logger.info(`[DLQ History] Returned ${history.length} entries`, { adminUserId, queue });

  return res.json({ history });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
