import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'OrgFeedbackSummaryJob';

export type OrgFeedbackSummaryJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** The two states in which a job still owns its window, so a second request must join it. */
export const ORG_FEEDBACK_SUMMARY_ACTIVE_STATUSES: OrgFeedbackSummaryJobStatus[] = ['pending', 'processing'];

/** The `activeKey` value every in-flight job carries. See the field's own note. */
export const ORG_FEEDBACK_SUMMARY_ACTIVE_KEY = 'active';

/**
 * One request for an LLM summary of an organization's feedback over a date window.
 *
 * Requests are deduplicated on (organization, window) while a job is still running: the summary is
 * an LLM pass, so two owners dragging the same date picker must not buy it twice. That is enforced
 * by a plain unique index rather than a partial one - `partialFilterExpression` admits only
 * equality and a handful of comparison operators, so "unique while status is pending OR
 * processing" is not expressible, and DocumentDB restricts partial indexes further still. Instead
 * `activeKey` holds a constant while the job is in flight and switches to the job's own id when it
 * reaches a terminal state, which makes every finished row unique on its own and frees the window
 * for a re-run. Keep the field in lockstep with `status`; nothing else may write it.
 */
export interface IOrgFeedbackSummaryJobDoc {
  _id: string;
  summaryJobId: string;
  organizationId: string;
  requestedBy: string;
  startDate: Date;
  endDate: Date;
  status: OrgFeedbackSummaryJobStatus;
  activeKey: string;
  /** Set once the artifact is written; the signed URL is minted per read, never stored. */
  s3Key?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IOrgFeedbackSummaryJobModel extends Model<IOrgFeedbackSummaryJobDoc> {}

const OrgFeedbackSummaryJobSchema = new Schema<IOrgFeedbackSummaryJobDoc>(
  {
    summaryJobId: { type: String, required: true, unique: true }, // unique: the job's identity
    organizationId: { type: String, required: true },
    requestedBy: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], required: true },
    activeKey: { type: String, required: true },
    s3Key: { type: String },
    errorMessage: { type: String },
  },
  { timestamps: true }
);

// The in-flight dedup key. Unique because a duplicate here is the request we mean to refuse.
OrgFeedbackSummaryJobSchema.index(
  { organizationId: 1, startDate: 1, endDate: 1, activeKey: 1 },
  { unique: true, name: 'org_feedback_summary_active' }
);
OrgFeedbackSummaryJobSchema.index({ organizationId: 1, createdAt: -1 });
// Long enough to outlive any redelivery of the message that created the row.
OrgFeedbackSummaryJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 1209600 });

export const OrgFeedbackSummaryJob: IOrgFeedbackSummaryJobModel =
  (mongoose.models[ModelName] as IOrgFeedbackSummaryJobModel) ||
  model<IOrgFeedbackSummaryJobDoc, IOrgFeedbackSummaryJobModel>(ModelName, OrgFeedbackSummaryJobSchema);
