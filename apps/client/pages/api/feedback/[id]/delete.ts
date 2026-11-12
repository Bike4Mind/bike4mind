import { FeedbackModel, FeedbackTextModel, FeedbackNoteModel, withTransaction } from '@bike4mind/database';
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

    const feedback = await withTransaction(async () => {
      const current = isValidObjectId(id) ? await FeedbackModel.findById(id) : null;
      if (!current || !req.ability!.can('delete', current)) throw new NotFoundError('Feedback not found');

      const isOwnReport = !req.user.impersonatedBy && isSameUserId(current.userId, userId);
      const reasonValue = (req.body as { reason?: unknown } | undefined)?.reason;
      const reason = isOwnReport && reasonValue === undefined ? null : parseAdminActionReason(reasonValue);
      const { deletedCount } = await FeedbackModel.deleteOne({ _id: id });
      if (deletedCount !== 1) throw new NotFoundError('Feedback not found');
      await FeedbackNoteModel.deleteMany({ feedbackId: id.toLowerCase() });

      if (reason !== null) {
        await recordAdminActionFromRequest(req, {
          action: 'feedback.deleted',
          target: await userAuditTarget(current.userId),
          summary: `deleted a ${current.type ?? 'feedback'} report (${current.status})`,
          reason,
          details: { feedbackId: id, status: current.status, type: current.type ?? null },
        });
      }
      return current;
    });

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
