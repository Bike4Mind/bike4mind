import { FeedbackModel } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FeedbackEvents } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { z } from 'zod';

const UpdateFeedbackRequestSchema = z.object({
  userId: z.string(),
  content: z.string(),
  username: z.string(),
  status: z.string(),
  promptMeta: z.object({}).optional(),
  type: z.string().optional(),
});

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.user.id;

    const id = req.query.id;
    if (!id) throw new BadRequestError('Invalid ID');

    if (!req.ability) {
      throw new NotFoundError('Ability not found');
    }

    const updateData = UpdateFeedbackRequestSchema.parse(req.body);

    const feedback = await FeedbackModel.findById(id);

    if (!feedback) {
      throw new NotFoundError('Feedback not found');
    }
    const { content, status, username } = updateData;

    // Authorize against the document instance, not the model class: a by-class
    // CASL check does not evaluate the { userId } ownership condition, so
    // ownership is only enforced when checked against the instance. Admins keep
    // their unconditional update rule and still pass.
    if (!req.ability.can('update', feedback)) {
      throw new NotFoundError('Permission denied');
    }

    const updatedFeedback = await FeedbackModel.findOneAndUpdate(
      { _id: id },
      { $set: { content, status, username } },
      { new: true }
    );

    await logEvent(
      { userId, type: FeedbackEvents.UPDATE_FEEDBACK, metadata: { id, content, status, username } },
      { ability: req.ability }
    );

    return res.json(updatedFeedback);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
