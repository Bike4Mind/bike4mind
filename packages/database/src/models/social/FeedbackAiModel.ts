import mongoose, { Schema } from 'mongoose';
import { FEEDBACK_AI_AREAS, FEEDBACK_AI_SEVERITIES, type FeedbackAiLabels } from '@bike4mind/common';

export interface FeedbackAiRecord {
  feedbackId: string;
  inputHash: string;
  model: string;
  vector: number[];
  suggestionId?: string;
  labels?: FeedbackAiLabels;
  override?: FeedbackAiLabels;
  similar: { id: string; similarity: number }[];
  reportCreatedAt: Date;
  expiresAt: Date;
}

const labels = new Schema(
  {
    area: { type: String, enum: FEEDBACK_AI_AREAS, required: true },
    severity: { type: String, enum: FEEDBACK_AI_SEVERITIES, required: true },
    actionable: { type: Boolean, required: true },
    needsReply: { type: Boolean, required: true },
    duplicateId: { type: String, default: null },
  },
  { _id: false }
);

const schema = new Schema<FeedbackAiRecord>(
  {
    feedbackId: { type: String, required: true, unique: true },
    inputHash: { type: String, required: true },
    model: { type: String, required: true },
    vector: { type: [Number], required: true, select: false },
    suggestionId: String,
    labels: { type: labels, required: false },
    override: { type: labels, required: false },
    similar: [{ _id: false, id: String, similarity: Number }],
    reportCreatedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ model: 1, reportCreatedAt: -1 });
schema.index({ 'labels.area': 1, 'labels.severity': 1 });

export const FeedbackAiModel =
  (mongoose.models.FeedbackAi as mongoose.Model<FeedbackAiRecord> | undefined) ??
  mongoose.model<FeedbackAiRecord>('FeedbackAi', schema);
