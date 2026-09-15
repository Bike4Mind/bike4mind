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

    // Read before deleting so the ownership condition can be evaluated. Authorizing by class
    // (`can('delete', FeedbackModel)`) does NOT evaluate the non-admin grant's { userId }
    // condition, so a by-class check would let any logged-in user hard-delete any reporter's
    // record. A reporter retracting their own report and an admin deleting any report are the
    // same route; the ability rules are what separate them.
    const feedback = await FeedbackModel.findById(id);
    if (!feedback) throw new NotFoundError('Feedback not found');

    // Same NotFoundError as above: a probe must not be able to distinguish "not yours" from
    // "does not exist".
    if (!req.ability.can('delete', feedback)) {
      throw new NotFoundError('Feedback not found');
    }

    await FeedbackModel.deleteOne({ _id: id });

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
