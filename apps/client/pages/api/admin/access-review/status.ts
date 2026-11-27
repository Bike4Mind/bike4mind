import { adminAccessReviewRepository } from '@bike4mind/database';
import { accessReviewOverdueSince, reviewQuarter } from '@bike4mind/server-utils/security/accessReview/accessReview';
import { adminApi } from '@server/middlewares/adminApi';
import { assertAccessReviewer } from '@server/admin/accessReview';

/** Whether this quarter's review is overdue; reads only the review records, so the banner stays cheap. */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'settings:manage' } }).get(async (req, res) => {
  assertAccessReviewer(req.user);
  const now = new Date();
  const quarter = reviewQuarter(now);
  const latest = await adminAccessReviewRepository.findLatestCompleted();
  const overdueSince = accessReviewOverdueSince(latest?.completedAt ?? null, now);
  return res.json({
    quarter,
    overdue: overdueSince !== null,
    overdueSince,
    completedAt: latest?.quarter === quarter ? latest.completedAt : null,
  });
});

export default handler;
