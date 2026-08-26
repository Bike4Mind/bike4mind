import { FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FeedbackEvents } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { toRedactedFeedback } from '@server/utils/redactedFeedback';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.user.id;

    const id = req.query.id;
    if (!id) throw new BadRequestError('Invalid ID');

    if (!req.ability) {
      throw new Error('Ability not found');
    }

    if (!req.ability.can('delete', FeedbackModel)) {
      throw new Error('Permission denied');
    }

    const deletedFeedbackItem = await FeedbackModel.findOneAndDelete({ _id: id });
    if (!deletedFeedbackItem) throw new NotFoundError('Feedback not found');

    // Mongo has no cascade: without this, a deleted report's free text survives up to 90 days,
    // inverting the retention promise. Best-effort - the report is already gone either way.
    await FeedbackTextModel.deleteOne({ _id: id }).catch(err => {
      req.logger?.error('Failed to delete FeedbackText sibling on report deletion', err);
    });

    await logEvent({ userId, type: FeedbackEvents.DELETE_FEEDBACK, metadata: { id } }, { ability: req.ability });

    return res.status(200).json(toRedactedFeedback(deletedFeedbackItem));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
