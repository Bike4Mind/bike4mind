import { FeedbackTextModel } from '@bike4mind/database';
import { IFeedbackDocument, feedbackContentExpiresAt } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * The two halves of writing a Feedback report and its TTL'd text sibling, shared by every
 * producer of Feedback rows (the create handler and both help-center routes). Extracted because
 * the ordering and the rollback below are the whole correctness argument for the split, and three
 * hand-copies of it would drift.
 *
 * Text-first (mirrors LakeAccessEventModel.record()): a FeedbackText write failure just leaves
 * `contentStored` false rather than failing the submission, but a Feedback save failure after a
 * successful text write must not leave an orphaned, unattributable text row behind.
 */

/**
 * Writes the sibling text row under the owning report's `_id`. Returns whether it landed, which
 * is exactly what `contentStored` must be set to.
 *
 * `content` must already be through `truncateFeedbackContent`, so the caller can echo the same
 * string it persisted rather than the raw request body. Skipping a blank submission is the
 * caller's call and must be decided on the RAW text: truncation can turn a non-blank submission
 * (whitespace past the cap, then words) into a blank one, and a check here would silently drop it.
 */
export async function writeFeedbackText({
  feedbackId,
  content,
  contentTruncated,
  logger,
}: {
  feedbackId: mongoose.Types.ObjectId;
  content: string;
  contentTruncated: boolean;
  logger: Pick<Logger, 'error'>;
}): Promise<boolean> {
  try {
    await FeedbackTextModel.create({
      _id: feedbackId,
      content,
      contentTruncated,
      expiresAt: feedbackContentExpiresAt(new Date()),
    });
    return true;
  } catch (error) {
    logger.error('Failed to write FeedbackText sibling', error);
    return false;
  }
}

/**
 * Replaces the text of a report whose sibling already exists, leaving its retention window alone.
 * Returns whether the sibling was still there to revise.
 *
 * Writes no `expiresAt` at all, and does not upsert. Both halves are the same rule the other
 * writer of this collection states inline (`pages/api/feedback/[id]/update.ts`): `expiresAt` is
 * immutable, so a report whose text has already expired must not be resurrected by editing it
 * back in - an insert here would mint a fresh 90-day window from now, which is precisely the
 * retention extension the permanent/TTL split exists to make impossible. Two writers of one
 * collection have to agree on that, or retention depends on which path a caller happened to take.
 *
 * Every caller revises inside a short dedup window where the sibling is minutes old, so a `false`
 * return means that assumption has stopped holding - worth a log line at the call site rather than
 * a silent no-op. A real write failure is left to throw: a revision the user cannot see fail is a
 * revision they believe was saved.
 */
export async function reviseFeedbackText({
  feedbackId,
  content,
  contentTruncated,
}: {
  feedbackId: mongoose.Types.ObjectId;
  content: string;
  contentTruncated: boolean;
}): Promise<boolean> {
  const result = await FeedbackTextModel.updateOne({ _id: feedbackId }, { $set: { content, contentTruncated } });
  return result.matchedCount > 0;
}

/**
 * Saves the report, deleting the already-written text sibling if the save fails. Rethrows the
 * original save error either way: a report that did not persist must not return success, and the
 * cleanup failing on top of it is a log line, not a second thrown error that would mask the first.
 */
export async function saveFeedbackOrRollbackText({
  feedback,
  contentStored,
  logger,
}: {
  feedback: HydratedDocument<IFeedbackDocument>;
  contentStored: boolean;
  logger: Pick<Logger, 'warn'>;
}): Promise<void> {
  try {
    await feedback.save();
  } catch (error) {
    if (contentStored) {
      await FeedbackTextModel.deleteOne({ _id: feedback._id }).catch(cleanupError => {
        logger.warn('Failed to delete orphaned FeedbackText sibling after a failed save', cleanupError);
      });
    }
    throw error;
  }
}
