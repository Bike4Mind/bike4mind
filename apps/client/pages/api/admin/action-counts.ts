import type { AdminActionCounts } from '@client/app/components/admin/adminActionCounts';
import { adminApi } from '@server/middlewares/adminApi';
import { computeAdminActionCounts } from '@server/admin/actionCounts';

/**
 * GET /api/admin/action-counts: how many items wait in each admin queue the caller may act on,
 * for the admin sidebar badges. Keys the caller may not act on are absent; a failed count is null.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  // Polled by the admin sidebar; API keys have no sidebar.
  auth: 'jwtOnly',
}).get(async (req, res) => {
  // Under impersonation req.user is the impersonated account; the real admin's own requests stay out of the counts.
  const viewerUserId = (req.user as { impersonatedBy?: string }).impersonatedBy ?? req.user.id;
  const counts: AdminActionCounts = await computeAdminActionCounts(req.user, viewerUserId);

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ counts });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
