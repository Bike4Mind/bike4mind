import { FeedbackModel } from '@bike4mind/database';
import { redactPromptMetaForViewer } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';

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

    // Same cross-user exposure as GET /api/feedback: this route serves any admin, not just the
    // reporter, so functionCalls[].returnValue must be stripped here too. .toJSON() first -
    // spreading a hydrated Mongoose subdocument leaks the unredacted value back in through its
    // _doc/$__ internals.
    const plain = feedback.toJSON();
    return res.json({ ...plain, promptMeta: redactPromptMetaForViewer(plain.promptMeta, false) });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
