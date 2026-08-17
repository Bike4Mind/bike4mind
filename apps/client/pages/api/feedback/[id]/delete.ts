import { FeedbackModel } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FeedbackEvents, redactPromptMetaForViewer } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@server/utils/errors';

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

    await logEvent({ userId, type: FeedbackEvents.DELETE_FEEDBACK, metadata: { id } }, { ability: req.ability });

    // Same cross-user exposure as GET/PUT on this collection: an admin deleting another
    // reporter's feedback still sees the response body, so functionCalls[].returnValue must be
    // stripped here too. .toJSON() first - spreading a hydrated Mongoose subdocument leaks the
    // unredacted value back in through its _doc/$__ internals.
    const plain = deletedFeedbackItem.toJSON();
    return res.status(200).json({ ...plain, promptMeta: redactPromptMetaForViewer(plain.promptMeta, false) });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
