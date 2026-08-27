import mongoose, { Schema } from 'mongoose';
import type { IFeedbackTextDocument } from '@bike4mind/common';

const ModelName = 'FeedbackText';

// A Mongo TTL index deletes the whole document it is declared on, so a report's free text
// (90-day retention) and its structured signal (permanent) cannot share one document - see
// LakeAccessQueryTextModel.ts for the same shape applied to a different collection.
//
// `_id` is supplied explicitly by the create handler (the owning Feedback's `_id`), not
// auto-generated - a shared-`_id` join is a plain `findById`/`$in`, needs no extra index, and
// makes "more than one text per report" structurally impossible rather than merely disallowed.
const feedbackTextSchema = new Schema<IFeedbackTextDocument>(
  {
    // No explicit `_id` path - the create handler supplies it (see the shared-`_id` note above);
    // declaring it here would conflict with Schema<T>'s definition type.
    content: { type: String, required: true },
    contentTruncated: { type: Boolean, default: false },
    // immutable so an admin edit (apps/client/pages/api/feedback/[id]/update.ts) can extend
    // this row's content but never its retention window - swept text cannot be resurrected by
    // editing it back in.
    expiresAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

feedbackTextSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'feedback_text_ttl' });

export const FeedbackTextModel =
  (mongoose.models[ModelName] as unknown as mongoose.Model<IFeedbackTextDocument>) ||
  mongoose.model<IFeedbackTextDocument>(ModelName, feedbackTextSchema);

export default FeedbackTextModel;
