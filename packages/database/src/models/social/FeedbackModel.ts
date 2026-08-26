import mongoose, { Model, model, Schema } from 'mongoose';
import { FEEDBACK_SUBJECTS, IFeedbackDocument } from '@bike4mind/common';

const feedbackSchema = new Schema<IFeedbackDocument>(
  {
    userId: { type: String, required: true },
    // Optional: moved to the FeedbackText TTL sibling 90 days after creation. `contentStored`
    // below is what tells a reader "expired" apart from "never had text".
    content: { type: String, required: false },
    status: { type: String, required: true },
    tags: { type: Array<string>, required: false },
    username: { type: String, required: true },
    userEmail: { type: String, required: false },
    customerService: { type: String, required: false },
    // Display name only, resolved from the same User lookup as organizationId below - kept
    // as-is (not a reference) so a renamed/deleted org doesn't blank out historical reports.
    organization: { type: String, required: false },
    promptMeta: { type: Object, required: false },
    type: { type: String, required: false },
    // Server-derived only - see the create handler's resolveFeedbackContext. Never populated
    // from client-supplied promptMeta, since these become authorization keys for scoped readers.
    sessionId: { type: String, required: false },
    questId: { type: String, required: false },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: false, default: null },
    subject: { type: String, enum: FEEDBACK_SUBJECTS, required: true, default: 'product' },
    contentStored: { type: Boolean, required: true, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Personal rollup: newest-first per user.
feedbackSchema.index({ userId: 1, createdAt: -1 }, { name: 'feedback_userId_createdAt' });
feedbackSchema.index({ questId: 1, createdAt: -1 }, { name: 'feedback_questId_createdAt' });
feedbackSchema.index({ sessionId: 1, createdAt: -1 }, { name: 'feedback_sessionId_createdAt' });
// `subject` has no standalone index - 3 values means a scan would touch ~1/3 of the collection
// anyway, so it rides as this compound index's second key instead.
feedbackSchema.index({ organizationId: 1, subject: 1, createdAt: -1 }, { name: 'feedback_org_subject_createdAt' });

export const FeedbackModel: Model<IFeedbackDocument> =
  mongoose.models.Feedback ?? model<IFeedbackDocument>('Feedback', feedbackSchema);

export default FeedbackModel;
