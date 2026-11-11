import { FeedbackModel, FeedbackTextModel, withTransaction } from '@bike4mind/database';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FeedbackEvents } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { toRedactedFeedback } from '@server/utils/redactedFeedback';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import {
  isSameUserId,
  parseAdminActionReason,
  recordAdminActionFromRequest,
  userAuditTarget,
} from '@bike4mind/server-utils/utils/adminAudit';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.user.id;

    const id = req.query.id;
    if (!id) throw new BadRequestError('Invalid ID');

    // Matches read.ts/update.ts in this directory; see the note in ../index.ts.
    if (!req.ability) {
      throw new NotFoundError('Ability not found');
    }

    // Read before deleting so the ownership condition can be evaluated. Authorizing by class
    // (`can('delete', FeedbackModel)`) does NOT evaluate the non-admin grant's { userId }
    // condition, so a by-class check would let any logged-in user hard-delete any reporter's
    // record. A reporter retracting their own report and an admin deleting any report are the
    // same route; the ability rules are what separate them.
    const feedback = isValidObjectId(id) ? await FeedbackModel.findById(id) : null;
    if (!feedback) throw new NotFoundError('Feedback not found');

    // Same NotFoundError as above: a probe must not be able to distinguish "not yours" from
    // "does not exist".
    if (!req.ability.can('delete', feedback)) {
      throw new NotFoundError('Feedback not found');
    }

    // A reporter retracting their own report is not an admin action. Anyone else's report (or any
    // report while impersonating) is deleted by an admin, which takes a reason and is audited in the
    // same transaction as the delete, matching feedbackReadAudit.ts's notion of an own report. An
    // own report deleted with a reason came through the admin dialog, so it is audited too.
    const isOwnReport = !req.user.impersonatedBy && !!feedback.userId && isSameUserId(feedback.userId, userId);
    const reasonValue = (req.body as { reason?: unknown } | undefined)?.reason;
    if (isOwnReport && reasonValue === undefined) {
      await FeedbackModel.deleteOne({ _id: id });
    } else {
      const reason = parseAdminActionReason(reasonValue);
      const target = await userAuditTarget(feedback.userId);
      await withTransaction(async () => {
        await FeedbackModel.deleteOne({ _id: id });
        await recordAdminActionFromRequest(req, {
          action: 'feedback.deleted',
          target,
          summary: `deleted a ${feedback.type ?? 'feedback'} report (${feedback.status})`,
          reason,
          details: { feedbackId: id, status: feedback.status, type: feedback.type ?? null },
        });
      });
    }

    // Mongo has no cascade: without this, a deleted report's free text survives up to 90 days,
    // inverting the retention promise. Best-effort - the report is already gone either way.
    await FeedbackTextModel.deleteOne({ _id: id }).catch(err => {
      req.logger?.error('Failed to delete FeedbackText sibling on report deletion', err);
    });

    await logEvent({ userId, type: FeedbackEvents.DELETE_FEEDBACK, metadata: { id } }, { ability: req.ability });

    return res.status(200).json(toRedactedFeedback(feedback));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
