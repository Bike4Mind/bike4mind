import mongoose, { Model, model, Schema } from 'mongoose';
import { IFeedbackDocument } from '@bike4mind/common';

const feedbackSchema = new Schema<IFeedbackDocument>(
  {
    userId: { type: String, required: true },
    /**
     * LEGACY, pre-#1864 rows only. New records never write this - the reporter's free text goes to
     * the TTL'd `FeedbackText` sibling so it can expire on its own (Mongo cannot TTL one field of a
     * document). Kept declared, and optional, so rows written before the split still surface their
     * text through the read-join's fallback arm until the backfill migration has moved them. Drop
     * it once the backfill has run everywhere AND one retention window has passed.
     */
    content: { type: String, required: false },
    status: { type: String, required: true },
    tags: { type: Array<string>, required: false },
    username: { type: String, required: true },
    userEmail: { type: String, required: false },
    customerService: { type: String, required: false },
    // Free-text org NAME, kept for display continuity with pre-#1864 rows. `organizationId` below
    // is the authorization-grade key; prefer it for any filter or aggregation.
    organization: { type: String, required: false },
    promptMeta: { type: Object, required: false },
    type: { type: String, required: false },
    /**
     * Server-derived foreign keys (#1864). Written ONLY from the authenticated identity and a
     * re-read of the referenced quest - never from the request body, since a scoped reader (#1866)
     * filters on them, which makes a client-supplied value an authorization bypass.
     *
     * `organizationId` is an ObjectId while the quest side (`promptMeta.session.organizationId`) is
     * a String: an aggregation `$match` across the two without an explicit cast matches zero
     * documents and throws nothing, rendering as "no reports" - which reads as good news.
     */
    sessionId: { type: String, required: false },
    questId: { type: String, required: false },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: false },
    // 'turn' | 'session' | 'product' - see FeedbackSubject. Derived from which keys resolved.
    subject: { type: String, required: true, default: 'product' },
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

// Performance indexes declared together (repo convention: never `index: true` on a field).
feedbackSchema.index({ userId: 1, createdAt: -1 }); // personal rollup (#1874)
feedbackSchema.index({ questId: 1 }); // turn-scoped lookups and the diagnosis panel
feedbackSchema.index({ sessionId: 1, createdAt: -1 }); // session-scoped reads
feedbackSchema.index({ organizationId: 1, createdAt: -1 }); // org group-analysis report (#1875)
feedbackSchema.index({ subject: 1, createdAt: -1 }); // rollups that slice by what the report is about

export const FeedbackModel: Model<IFeedbackDocument> =
  mongoose.models.Feedback ?? model<IFeedbackDocument>('Feedback', feedbackSchema);

export default FeedbackModel;
