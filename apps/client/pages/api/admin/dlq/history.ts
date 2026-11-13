import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { dlqReplayLogRepository, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const QuerySchema = z.object({
  queue: z.string().optional(),
  status: z.enum(['success', 'failed', 'skipped', 'discarded', 'pending']).optional(),
  startDate: z
    .string()
    .optional()
    .refine(val => !val || !isNaN(Date.parse(val)), { message: 'Invalid startDate format' }),
  endDate: z
    .string()
    .optional()
    .refine(val => !val || !isNaN(Date.parse(val)), { message: 'Invalid endDate format' }),
  search: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/admin/dlq/history?queue=<label>&status=<status>&startDate=<iso>&endDate=<iso>&search=<text>&limit=50
 *
 * Returns DLQ replay history with optional filters.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const result = QuerySchema.safeParse(req.query);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid query parameters');
  }

  const { queue, status, startDate, endDate, search, limit, cursor } = result.data;
  let before: { createdAt: Date; id: string } | undefined;
  if (cursor) {
    try {
      const decoded = z
        .object({ createdAt: z.iso.datetime(), id: z.string().regex(/^[a-f\d]{24}$/i) })
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      before = { createdAt: new Date(decoded.createdAt), id: decoded.id };
    } catch {
      throw new BadRequestError('Invalid history cursor');
    }
  }
  const adminUserId = req.user?.id;
  if (!adminUserId) throw new BadRequestError('Admin user ID is required');

  Logger.info(`[DLQ History] Fetching history`, { adminUserId, queue, status, startDate, endDate, search, limit });

  const rows = await dlqReplayLogRepository.findRecent({
    queueLabel: queue,
    status,
    startDate: startDate ? new Date(startDate) : undefined,
    endDate: endDate ? new Date(endDate) : undefined,
    search,
    limit: limit + 1,
    before,
    includeBody: false,
  });
  const history = rows.slice(0, limit);
  const last = history.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: String(last.id) })).toString(
          'base64url'
        )
      : null;

  Logger.info(`[DLQ History] Returned ${history.length} entries`, { adminUserId, queue });

  // replayedBy stores the admin's user id; resolve it to something a person can read.
  const admins = await userRepository.findByIds([...new Set(history.map(entry => entry.replayedBy))]);
  const nameById = new Map(admins.map(user => [String(user.id), user.email ?? user.username]));

  return res.json({
    nextCursor,
    history: history.map(entry => ({ ...entry, replayedByName: nameById.get(entry.replayedBy) ?? entry.replayedBy })),
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
