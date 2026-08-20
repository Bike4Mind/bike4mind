import mongoose, { Model, model, Schema } from 'mongoose';
import { IFeedbackTextDocument } from '@bike4mind/common';

/** 90 days, matching HelpEventModel's TTL and the context-telemetry retention window. */
export const FEEDBACK_TEXT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * The reporter's free text, split out of `Feedback` (#1864).
 *
 * WHY A SEPARATE COLLECTION: the retention policy is 90 days on free text and permanent on the
 * structured signal, and Mongo cannot TTL a single field of a document. Giving the text its own
 * document is what makes that policy expressible at all. Everything an aggregation or rollup needs
 * - the foreign keys, the triage status, the diagnostic snapshot - stays on `Feedback` and never
 * expires, so a report's existence and its verdict remain countable long after its prose is gone.
 *
 * A TTL INDEX, NOT A SCHEDULED JOB: context telemetry expires via a cron `$unset` only because its
 * payload is embedded inside Quest documents where a TTL cannot reach. That constraint does not
 * apply here, and a TTL index is self-maintaining - no job to own, and no failure mode where
 * retention silently stops working.
 *
 * NO CONSENT FLAG, deliberately: telemetry is collected passively, so opt-in is the precondition
 * for collecting it at all. Feedback is deliberately submitted, and gating it would add friction to
 * the exact action this epic exists to encourage.
 */
const feedbackTextSchema = new Schema<IFeedbackTextDocument>(
  {
    // The `Feedback` document this text belongs to. Unique: one text document per record, so an
    // upsert on resubmission cannot fan out into duplicates the read-join would have to pick from.
    feedbackId: { type: String, required: true, unique: true },
    content: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// TTL: Mongo drops the document ~90 days after creation. `createdAt` comes from `timestamps: true`.
feedbackTextSchema.index({ createdAt: 1 }, { expireAfterSeconds: FEEDBACK_TEXT_RETENTION_SECONDS });

export const FeedbackTextModel: Model<IFeedbackTextDocument> =
  mongoose.models.FeedbackText ?? model<IFeedbackTextDocument>('FeedbackText', feedbackTextSchema);

export default FeedbackTextModel;
