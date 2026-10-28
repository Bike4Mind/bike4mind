import { SupportAccess } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, BadRequestError } from '@server/utils/errors';
import { customerSupportAccess } from '@server/auth/impersonation';
import { ApiKeyScope } from '@bike4mind/common';

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !/^[0-9a-f]{24}$/i.test(userId)) throw new BadRequestError('Invalid user id');
  const rows = await SupportAccess.find({ userId })
    .select('+reason +escalationReason')
    .sort({ startedAt: -1 })
    .limit(50)
    .maxTimeMS(5000);
  return res.json({
    items: rows.map(row => ({
      ...customerSupportAccess(row),
      adminId: row.adminId,
      reason: row.reason,
      escalated: !!row.escalatedAt,
      escalationReason: row.escalationReason,
    })),
  });
});
export default handler;
