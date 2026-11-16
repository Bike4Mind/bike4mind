import { adminAccessReviewRepository } from '@bike4mind/database';
import { isAccessReviewOverdue, reviewQuarter } from '@bike4mind/server-utils/security/accessReview/accessReview';
import { collectAccessReview } from '@bike4mind/server-utils/security/accessReview/accessReviewData';
import { adminApi } from '@server/middlewares/adminApi';
import { assertAccessReviewer, parseDormantDays, toAccessReviewRows } from '@server/admin/accessReview';

/** The current quarter's admin access review: only the admin rows of the snapshot leave the server. */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'settings:manage' } }).get(async (req, res) => {
  assertAccessReviewer(req.user);
  const dormantDays = parseDormantDays(req.query.dormantDays);
  const now = new Date();
  const quarter = reviewQuarter(now);
  const [snapshot, record, latestCompleted] = await Promise.all([
    collectAccessReview({ now }),
    adminAccessReviewRepository.findByQuarter(quarter),
    adminAccessReviewRepository.findLatestCompleted(),
  ]);
  return res.json({
    quarter,
    generatedAt: snapshot.generatedAt,
    dormantDays,
    overdue: isAccessReviewOverdue(latestCompleted?.completedAt ?? null, now),
    admins: toAccessReviewRows(snapshot.admins, record, now, dormantDays),
    record,
  });
});

export default handler;
