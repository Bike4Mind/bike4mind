import { FeedbackModel } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { hydrateFeedbackText, toRedactedFeedback } from '@server/utils/redactedFeedback';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const id = req.query.id;
    if (!id) throw new BadRequestError('Invalid ID');

    if (!req.ability) {
      throw new NotFoundError('Ability not found');
    }

    const feedback = await FeedbackModel.findById(id);

    if (!feedback) {
      throw new NotFoundError('Feedback not found');
    }

    // Authorize against the document instance, not the model class: the non-admin `read` grant
    // carries a { userId } ownership condition that a by-class check does not evaluate, so a
    // by-class check here would hand every logged-in user any reporter's record. Same
    // NotFoundError as the missing-document case above, so a probe cannot use the status to
    // confirm an id exists.
    if (!req.ability.can('read', feedback)) {
      throw new NotFoundError('Feedback not found');
    }

    const [hydrated] = await hydrateFeedbackText([toRedactedFeedback(feedback)]);
    return res.json(hydrated);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
