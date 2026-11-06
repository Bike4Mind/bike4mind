import { ADMIN_APPROVAL_STATUSES, BadRequestError } from '@bike4mind/common';
import { z } from 'zod';
import { adminApi } from '@server/middlewares/adminApi';
import { APPROVAL_LIST_MAX, listApprovals } from '@server/admin/approvals/service';

const ListQuerySchema = z.object({
  status: z.enum([...ADMIN_APPROVAL_STATUSES, 'all']).default('pending'),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(APPROVAL_LIST_MAX).optional(),
});

/** The approval queue. The floor is any admin; each row says whether this caller may decide it. */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } }).get(async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid query');
  const { status, before, limit } = parsed.data;
  const approvals = await listApprovals(req, { status: status === 'all' ? undefined : status, before, limit });
  return res.json({ approvals });
});

export default handler;
