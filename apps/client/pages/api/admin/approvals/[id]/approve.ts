import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { stepUpGate } from '@server/auth/stepUp';
import { adminApi } from '@server/middlewares/adminApi';
import { approveApproval } from '@server/admin/approvals/service';

/** The record's own permission is enforced by the service; API keys never decide an approval. */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'support:read' } })
  .use(stepUpGate())
  // Shared with the sibling approve/reject route so one bucket caps an admin's decisions.
  .use(rateLimit({ limit: 20, windowMs: 60 * 1000, bucket: 'admin-approval-decision' }))
  .post(async (req, res) => {
    const { approval, result } = await approveApproval(req, String(req.query.id));
    return res.json({ approval, result });
  });

export default handler;
