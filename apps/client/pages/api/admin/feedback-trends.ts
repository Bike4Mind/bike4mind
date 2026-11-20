import { ForbiddenError, isFullAdmin } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { adminApi } from '@server/middlewares/adminApi';
import { computeFeedbackTrends } from '@server/admin/feedbackTrends';

/**
 * GET /api/admin/feedback-trends: open, last-24-hour, thumbs-down-share and 30-day-by-type counts
 * for the strip above the admin feedback table. Full admins only, like the Feedback tab and its
 * sidebar count (server/admin/actionCounts.ts).
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  // Read by the admin page only; API keys have no page.
  auth: 'jwtOnly',
})
  // Each figure click, refresh, status change and delete refetches, so a quick triage pass runs well past 30/min.
  .use(rateLimit({ limit: 120, windowMs: 60_000, bucket: 'admin-feedback-trends' }))
  .get(async (req, res) => {
    // support:read alone is not enough: the Feedback tab is full-admin only.
    if (!isFullAdmin(req.user)) throw new ForbiddenError('Admin access required');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(await computeFeedbackTrends());
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
