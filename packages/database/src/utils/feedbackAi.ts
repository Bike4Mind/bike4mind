import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { User } from '../models/auth/UserModel';
import { FeedbackModel } from '../models/social/FeedbackModel';
import { FeedbackAiModel } from '../models/social/FeedbackAiModel';

const ReporterId = z
  .string()
  .regex(/^[a-f\d]{24}$/i)
  .transform(id => id.toLowerCase());
const BATCH_SIZE = 500;
const MAX_TIME_MS = 15000;

/** Call before deleting User, in its transaction or while the permanent purge fence is held. */
export async function deleteFeedbackAiForUser(
  userId: string,
  { session, assertLease }: { session?: ClientSession; assertLease?: () => Promise<void> } = {}
): Promise<void> {
  const canonicalUserId = ReporterId.parse(userId);
  await assertLease?.();
  const reporterQuery = User.findById(canonicalUserId).select('email').maxTimeMS(MAX_TIME_MS).lean();
  if (session) reporterQuery.session(session);
  const reporter = await reporterQuery;
  // Follow the report relation for existing preview rows too; they have no reporter field.
  const reports = FeedbackModel.find({
    $or: [
      { userId: new RegExp(`^${canonicalUserId}$`, 'i') },
      ...(reporter?.email
        ? [
            {
              userEmail: reporter.email,
              $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }],
            },
          ]
        : []),
    ],
  })
    .select('_id')
    .maxTimeMS(MAX_TIME_MS)
    .lean();
  if (session) reports.session(session);
  const deleteBatch = async (feedbackIds: readonly string[]): Promise<void> => {
    if (!feedbackIds.length) return;
    await assertLease?.();
    await FeedbackAiModel.deleteMany(
      { feedbackId: { $in: [...feedbackIds] } },
      { ...(session ? { session } : {}), maxTimeMS: MAX_TIME_MS }
    );
  };
  const feedbackIds: string[] = [];
  for await (const report of reports.cursor({ batchSize: BATCH_SIZE })) {
    feedbackIds.push(String(report._id));
    if (feedbackIds.length === BATCH_SIZE) {
      await deleteBatch(feedbackIds);
      feedbackIds.length = 0;
    }
  }
  await deleteBatch(feedbackIds);
}
