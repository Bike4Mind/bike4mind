import { FeedbackModel } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { toRedactedFeedback } from '@server/utils/redactedFeedback';
import { attachFeedbackText } from '@server/utils/attachFeedbackText';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const id = req.query.id;
    if (!id) throw new BadRequestError('Invalid ID');

    if (!req.ability) {
      throw new NotFoundError('Ability not found');
    }

    if (!req.ability.can('read', FeedbackModel)) {
      throw new NotFoundError('Permission denied');
    }

    const feedback = await FeedbackModel.findById(id);

    if (!feedback) {
      throw new NotFoundError('Feedback not found');
    }

    const [withText] = await attachFeedbackText([toRedactedFeedback(feedback)]);
    return res.json(withText);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
