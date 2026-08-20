import { FeedbackModel } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FeedbackEvents } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { toRedactedFeedback } from '@server/utils/redactedFeedback';
import { attachFeedbackText } from '@server/utils/attachFeedbackText';
import { FeedbackTextModel } from '@bike4mind/database';
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
    // their unconditional update rule and still pass. Reuse the same "not found"
    // response as a missing id so a non-owner cannot distinguish the two.
    if (!req.ability.can('update', feedback)) {
      throw new NotFoundError('Feedback not found');
    }

    const updatedFeedback = await FeedbackModel.findOneAndUpdate(
      { _id: id },
      // `content` is deliberately NOT set here (#1864). Writing it back onto this document would
      // put the prose on the permanent record and silently defeat the retention split for every
      // edited row - the one path that would quietly undo the whole change. It goes to the TTL'd
      // sibling below instead.
      { $set: { status, username } },
      { new: true }
    );

    await logEvent(
      { userId, type: FeedbackEvents.UPDATE_FEEDBACK, metadata: { id, content, status, username } },
      { ability: req.ability }
    );

    if (!updatedFeedback) return res.json(updatedFeedback);

    // Upsert rather than update: a row written before the split (or one whose text has already
    // expired) has no sibling document to modify, and an edit should not fail on that.
    try {
      await FeedbackTextModel.updateOne(
        { feedbackId: String(updatedFeedback.id) },
        { $set: { content } },
        { upsert: true }
      );
    } catch (error) {
      req.logger?.error('Failed to persist edited feedback text', error);
    }
    // Join the free text back from its TTL'd sibling so the response shape matches the read route.
    const [withText] = await attachFeedbackText([toRedactedFeedback(updatedFeedback)]);
    return res.json(withText);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
