import { FeedbackModel } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FeedbackEvents } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { toRedactedFeedback } from '@server/utils/redactedFeedback';
import { FeedbackTextModel } from '@bike4mind/database';

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

    // Cascade to the free text (#1864). Without this the prose survives in the TTL'd sibling for
    // up to its full retention window after an admin deleted the report - the opposite of what
    // deleting a report means. Guarded: the parent is already gone, so a failure here must not turn
    // a successful delete into a 500. It leaves an orphan row that expires on its own.
    try {
      await FeedbackTextModel.deleteOne({ feedbackId: String(deletedFeedbackItem.id) });
    } catch (error) {
      req.logger?.error('Failed to delete feedback text after deleting its parent record', error);
    }

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
