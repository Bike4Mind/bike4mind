import { BadRequestError, NotFoundError } from '@bike4mind/common';
import { adminAccessReviewRepository } from '@bike4mind/database';
import {
  ACCESS_REVIEW_DEFAULT_DORMANT_DAYS,
  reviewQuarter,
} from '@bike4mind/server-utils/security/accessReview/accessReview';
import { collectAccessReview } from '@bike4mind/server-utils/security/accessReview/accessReviewData';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { toCsv } from '@client/app/utils/csv';
import { adminApi } from '@server/middlewares/adminApi';
import { assertAccessReviewer, toAccessReviewCsvRows, toAccessReviewRows } from '@server/admin/accessReview';

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

/**
 * CSV of a quarter's review. The current quarter lists the live admin rows plus decisions on accounts
 * that no longer hold access; an earlier quarter has only its recorded decisions.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'settings:manage' } }).get(async (req, res) => {
  assertAccessReviewer(req.user);
  const now = new Date();
  const current = reviewQuarter(now);
  const requested = req.query.quarter ?? current;
  if (typeof requested !== 'string' || !QUARTER_RE.test(requested)) {
    throw new BadRequestError('quarter must look like 2026-Q1');
  }
  const record = await adminAccessReviewRepository.findByQuarter(requested);
  if (requested !== current && !record) throw new NotFoundError(`No access review was recorded for ${requested}`);

  const rows =
    requested === current
      ? toAccessReviewRows(
          (await collectAccessReview({ now })).admins,
          record,
          now,
          record?.dormantDays ?? ACCESS_REVIEW_DEFAULT_DORMANT_DAYS
        )
      : [];
  const csv = toCsv(toAccessReviewCsvRows(requested, rows, record));

  await recordAdminActionFromRequest(req, {
    action: 'access_review.exported',
    target: { kind: 'system', id: `access-review-${requested}`, displayName: `Access review ${requested}` },
    summary: `exported the ${requested} access review`,
    details: { quarter: requested },
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="access-review-${requested}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(csv);
});

export default handler;
