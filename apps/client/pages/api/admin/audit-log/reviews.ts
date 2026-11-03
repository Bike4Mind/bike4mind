import { adminAuditLogRepository, adminAuditReviewRepository } from '@bike4mind/database';
import {
  ApiKeyScope,
  BadRequestError,
  ForbiddenError,
  MarkAuditReviewedRequestSchema,
  UnmarkAuditReviewedRequestSchema,
  isFullAdmin,
  type AuditReviewLookup,
  type MarkAuditReviewedResult,
  type MarkAuditReviewedSkipReason,
  type UnmarkAuditReviewedResult,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { isSameUserId } from '@server/utils/adminAudit';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;

type ReviewingUser = { id: string; name?: string | null; username?: string | null; isAdmin?: boolean | null };

// Reviews are meta: the review document is the record, so nothing is written to the audit log.
const assertCanReview = (user: ReviewingUser): void => {
  if ((user as { impersonatedBy?: string }).impersonatedBy) {
    throw new ForbiddenError('Stop impersonating to review audit entries.');
  }
  if (!isFullAdmin(user)) throw new ForbiddenError('Only full administrators can review audit entries.');
};

const reviewerName = (user: ReviewingUser): string => user.name || user.username || 'Admin';

const handler = adminApi({
  adminPermissions: { GET: 'support:read', POST: 'support:read', DELETE: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(async (req, res) => {
    const { entryId } = req.query;
    if (typeof entryId !== 'string' || !OBJECT_ID_PATTERN.test(entryId)) {
      throw new BadRequestError('entryId must be a valid audit entry id');
    }
    const [review = null] = await adminAuditReviewRepository.findByEntryIds([entryId]);
    const lookup: AuditReviewLookup = { review };
    return res.json(lookup);
  })
  .post(async (req, res) => {
    assertCanReview(req.user);
    const { entryIds, note } = parseOrBadRequest(MarkAuditReviewedRequestSchema, req.body);
    const uniqueIds = [...new Set(entryIds)];

    const [entries, existingReviews] = await Promise.all([
      Promise.all(uniqueIds.map(id => adminAuditLogRepository.findById(id))),
      adminAuditReviewRepository.findByEntryIds(uniqueIds),
    ]);
    const alreadyReviewed = new Set(existingReviews.map(review => review.auditEntryId));

    const skipped: MarkAuditReviewedResult['skipped'] = [];
    const eligible: string[] = [];
    uniqueIds.forEach((id, index) => {
      const entry = entries[index];
      const skip = (reason: MarkAuditReviewedSkipReason) => skipped.push({ id, reason });
      if (!entry) return skip('not_found');
      if (entry.severity !== 'critical') return skip('not_critical');
      if (entry.actor.userId && isSameUserId(entry.actor.userId, req.user.id)) return skip('own_action');
      if (alreadyReviewed.has(id)) return skip('already_reviewed');
      eligible.push(id);
    });

    const reviewer = { userId: req.user.id, name: reviewerName(req.user) };
    const trimmedNote = note?.trim();
    const reviewed = await adminAuditReviewRepository.createMany(
      eligible.map(auditEntryId => ({ auditEntryId, reviewer, ...(trimmedNote ? { note: trimmedNote } : {}) }))
    );
    // A concurrent review can win the unique index between the check and the insert.
    const inserted = new Set(reviewed);
    for (const id of eligible) if (!inserted.has(id)) skipped.push({ id, reason: 'already_reviewed' });

    Logger.info('[Admin] Reviewed audit entries', {
      reviewerId: req.user.id,
      reviewed: reviewed.length,
      skipped: skipped.length,
    });
    const result: MarkAuditReviewedResult = { reviewed, skipped };
    return res.json(result);
  })
  .delete(async (req, res) => {
    assertCanReview(req.user);
    const { entryIds } = parseOrBadRequest(UnmarkAuditReviewedRequestSchema, req.body);
    const uniqueIds = [...new Set(entryIds)];

    const existingReviews = await adminAuditReviewRepository.findByEntryIds(uniqueIds);
    const reviewById = new Map(existingReviews.map(review => [review.auditEntryId, review]));
    const mine = uniqueIds.filter(id => {
      const reviewerId = reviewById.get(id)?.reviewer.userId;
      return reviewerId ? isSameUserId(reviewerId, req.user.id) : false;
    });
    const unreviewed = await adminAuditReviewRepository.deleteByReviewer(mine, req.user.id);

    const deleted = new Set(unreviewed);
    const skipped: UnmarkAuditReviewedResult['skipped'] = [];
    for (const id of uniqueIds) {
      if (deleted.has(id)) continue;
      skipped.push({ id, reason: reviewById.has(id) ? 'not_reviewer' : 'not_reviewed' });
    }

    Logger.info('[Admin] Unreviewed audit entries', {
      reviewerId: req.user.id,
      unreviewed: unreviewed.length,
      skipped: skipped.length,
    });
    const result: UnmarkAuditReviewedResult = { unreviewed, skipped };
    return res.json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
