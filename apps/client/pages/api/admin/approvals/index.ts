import { ADMIN_APPROVAL_STATUSES, BadRequestError } from '@bike4mind/common';
import { z } from 'zod';
import { adminApi } from '@server/middlewares/adminApi';
import { APPROVAL_LIST_MAX, listApprovals } from '@server/admin/approvals/service';

const ListQuerySchema = z.object({
  status: z.enum([...ADMIN_APPROVAL_STATUSES, 'all']).default('pending'),
  before: z.coerce.date().optional(),
  beforeId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
  limit: z.coerce.number().int().min(1).max(APPROVAL_LIST_MAX).default(50),
});

/** The approval queue. The floor is any admin; each row says whether this caller may decide it. */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } }).get(async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid query');
  const { status, before, beforeId, limit } = parsed.data;
  if (beforeId && !before) throw new BadRequestError('before is required with beforeId');
  const records = await listApprovals(req, {
    status: status === 'all' ? undefined : status,
    before,
    beforeId,
    limit: limit + 1,
  });
  const approvals = records.slice(0, limit);
  const last = approvals.at(-1);
  const nextCursor = records.length > limit && last ? { before: last.createdAt, beforeId: last.id } : null;
  return res.json({ approvals, nextCursor });
});

export default handler;
