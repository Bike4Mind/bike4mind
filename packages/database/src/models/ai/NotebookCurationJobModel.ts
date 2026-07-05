import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'NotebookCurationJob';

export type NotebookCurationJobStatus = 'completed';

/**
 * Idempotency record for the notebookCuration SQS handler.
 *
 * SQS guarantees at-least-once delivery, so a redelivered curation message
 * must not re-run the (expensive, credit-deducting) LLM curation. The handler
 * writes one record per `curationJobId` once curation completes successfully,
 * and skips on redelivery if such a record already exists.
 *
 * Only successful completions are recorded. Failures are intentionally NOT
 * recorded so that SQS's native retry + dead-letter-queue machinery still
 * protects against transient failures (LLM timeout, storage blip, DB hiccup).
 *
 * `curationJobId` is a per-request UUID (minted in pages/api/notebooks/curate.ts),
 * so it uniquely identifies a single curation request - the natural idempotency
 * key. Records are garbage-collected via TTL.
 */
export interface INotebookCurationJobDoc {
  _id: string;
  curationJobId: string;
  sessionId: string;
  userId?: string;
  status: NotebookCurationJobStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface INotebookCurationJobModel extends Model<INotebookCurationJobDoc> {}

const NotebookCurationJobSchema = new Schema<INotebookCurationJobDoc>(
  {
    curationJobId: { type: String, required: true, unique: true }, // unique: idempotency key (data constraint)
    sessionId: { type: String, required: true },
    userId: { type: String },
    status: { type: String, enum: ['completed'], required: true },
  },
  { timestamps: true }
);

// TTL: auto-delete idempotency records after 14 days. SQS retains messages for
// at most 14 days, so a record only needs to outlive the window in which the
// same message could be redelivered.
NotebookCurationJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 1209600 });

export const NotebookCurationJob: INotebookCurationJobModel =
  (mongoose.models[ModelName] as INotebookCurationJobModel) ||
  model<INotebookCurationJobDoc, INotebookCurationJobModel>(ModelName, NotebookCurationJobSchema);
