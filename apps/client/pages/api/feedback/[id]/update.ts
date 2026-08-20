import { FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FeedbackEvents, feedbackContentExpiresAt, truncateFeedbackContent } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { hydrateFeedbackText, toRedactedFeedback } from '@server/utils/redactedFeedback';
import { z } from 'zod';

const UpdateFeedbackRequestSchema = z.object({
  userId: z.string(),
  // Optional: content now lives in a TTL'd sibling document. Omit to leave it untouched.
  content: z.string().optional(),
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

    // Resolve the sibling write BEFORE the Feedback update, so contentStored (if it changes) can
    // ride in the same $set as status/username - one write to the permanent document, not two.
    // contentApplied stays true when the caller didn't touch content at all - false only signals
    // a genuine no-op (the sibling had already expired under the 90-day TTL).
    let contentApplied = true;
    let contentStoredChange: boolean | undefined;
    if (content !== undefined) {
      const { content: truncated, contentTruncated } = truncateFeedbackContent(content);
      if (feedback.contentStored) {
        // upsert:false is deliberate: expiresAt is immutable, so a report whose text already
        // expired must not be resurrected by editing it back in.
        const result = await FeedbackTextModel.updateOne(
          { _id: id },
          { $set: { content: truncated, contentTruncated } }
        );
        contentApplied = result.matchedCount > 0;
      } else {
        // This report never had text (e.g. a placeholder submission) - originating it now is a
        // fresh write, not a resurrection, so it gets its own full retention window.
        await FeedbackTextModel.create({
          _id: id,
          content: truncated,
          contentTruncated,
          expiresAt: feedbackContentExpiresAt(new Date()),
        });
        contentStoredChange = true;
      }
    }

    const updatedFeedback = await FeedbackModel.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status,
          username,
          ...(contentStoredChange !== undefined ? { contentStored: contentStoredChange } : {}),
        },
        // Originating a fresh sibling can happen on a pre-migration document that still carries
        // its content directly on the permanent doc - unset it there too, or it survives forever
        // on a field the 90-day TTL can never reach.
        ...(contentStoredChange === true ? { $unset: { content: '' } } : {}),
      },
      { new: true }
    );
    if (!updatedFeedback) throw new NotFoundError('Feedback not found');

    // Never log the verbatim report text: CounterLog carries no TTL of its own, and doing so
    // would defeat the 90-day retention this route otherwise enforces.
    await logEvent(
      { userId, type: FeedbackEvents.UPDATE_FEEDBACK, metadata: { id, status, username } },
      { ability: req.ability }
    );

    const [hydrated] = await hydrateFeedbackText([toRedactedFeedback(updatedFeedback)]);
    return res.json({ ...hydrated, contentApplied });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
