import mongoose, { Model, model, Schema } from 'mongoose';
import {
  FEEDBACK_SUBJECTS,
  HELP_FEEDBACK_REPORT_TYPES,
  HELP_FEEDBACK_SURFACES,
  IFeedbackDocument,
} from '@bike4mind/common';

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
    // Context, not subject: the turn in view when a session-subject report was written.
    contextQuestId: { type: String, required: false },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: false, default: null },
    subject: { type: String, enum: FEEDBACK_SUBJECTS, required: true, default: 'product' },
    // Typed rather than folded into promptMeta's unschema'd Object: eventId is the join key the
    // help read path stitches on, so a silent shape drift here empties a user-facing panel.
    helpContext: {
      type: new Schema(
        {
          eventId: { type: String, required: true },
          surface: { type: String, enum: HELP_FEEDBACK_SURFACES, required: true },
          slug: { type: String, required: false },
          // No `rating`: the thumbs verdict rides `type` on the parent document, which is what the
          // admin list renders and filters on. See IHelpFeedbackContext.
          reportType: { type: String, required: false, enum: HELP_FEEDBACK_REPORT_TYPES },
        },
        { _id: false }
      ),
      required: false,
    },
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
// `subject` has no standalone index - 4 values means a scan would touch ~1/4 of the collection
// anyway, so it rides as this compound index's second key instead.
feedbackSchema.index({ organizationId: 1, subject: 1, createdAt: -1 }, { name: 'feedback_org_subject_createdAt' });
// Only help-routed reports carry this key, and the help read path looks a report up by the
// HelpEvent it annotates on every panel load.
//
// Unique rather than merely indexed: the help router finds-or-creates the one report attached to
// a help event, and two submissions racing that read would otherwise both insert. A help event
// belongs to a single user, so the event alone is the right uniqueness key.
//
// partialFilterExpression, NOT sparse: sparse would still index every non-help report under a
// null key and collide them all against each other.
//
// Pre-built by 20260916000000_ensure-feedback-helpcontext-index rather than left to autoIndex:
// the router's correctness depends on this constraint existing before the first write, and on
// DocumentDB an autoIndex build would take a foreground lock on whichever Lambda cold-boots
// first. Note that neither autoIndex nor createIndexes can change the options of an index that
// already exists - narrowing or widening this one later needs a migration that drops it first.
feedbackSchema.index(
  { 'helpContext.eventId': 1 },
  {
    name: 'feedback_helpContext_eventId',
    unique: true,
    partialFilterExpression: { 'helpContext.eventId': { $exists: true } },
  }
);

// Org rollup: every report stamped to an org, newest-first over a date range. The compound above
// cannot serve it - `createdAt` sits behind `subject` there and DocumentDB has no skip-scan, so a
// query that does not pin a subject gets no range bound on the date. Not sparse: `organizationId`
// defaults to null, so the key is present on unstamped rows too, and a compound sparse index skips
// a document only when every one of its keys is absent.
feedbackSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'feedback_org_createdAt' });

export const FeedbackModel: Model<IFeedbackDocument> =
  mongoose.models.Feedback ?? model<IFeedbackDocument>('Feedback', feedbackSchema);

export default FeedbackModel;
