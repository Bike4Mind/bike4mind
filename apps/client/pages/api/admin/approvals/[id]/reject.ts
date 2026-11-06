import { stepUpGate } from '@server/auth/stepUp';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason } from '@server/utils/adminAudit';
import { rejectApproval } from '@server/admin/approvals/service';

/** Rejects, or lets the requester withdraw, a pending request. */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'support:read' } })
  .use(stepUpGate())
  .post(async (req, res) => {
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);
    const approval = await rejectApproval(req, String(req.query.id), reason);
    return res.json({ approval });
  });

export default handler;
