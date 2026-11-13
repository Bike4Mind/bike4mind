import mongoose, { Schema, model } from 'mongoose';
import { ADMIN_AI_FEATURES, ADMIN_AI_MODES, type AdminAiAttempt, type AdminAiClassEvidence } from '@bike4mind/common';

const attemptSchema = new Schema<AdminAiAttempt>(
  {
    feature: { type: String, enum: ADMIN_AI_FEATURES, required: true },
    policyVersion: { type: String, required: true },
    outcome: { type: String, enum: ['running', 'suggestion', 'cached', 'skip'], required: true },
    skipReason: String,
    suggestionId: String,
    calls: { type: Number, min: 0, required: true },
    knownCostUsd: { type: Number, min: 0, required: true },
    costUnknown: { type: Boolean, required: true },
    startedAt: { type: Date, required: true },
    finishedAt: Date,
  },
  { collection: 'AdminAiAttempt', versionKey: false }
);
attemptSchema.index({ startedAt: -1, feature: 1 });
attemptSchema.index({ startedAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60, name: 'admin_ai_attempt_retention' });
attemptSchema.index({ suggestionId: 1 });
export const AdminAiAttemptModel =
  (mongoose.models.AdminAiAttempt as mongoose.Model<AdminAiAttempt> | undefined) ??
  model<AdminAiAttempt>('AdminAiAttempt', attemptSchema);

export type AdminAiClassState = Pick<
  AdminAiClassEvidence,
  'feature' | 'actionClass' | 'policyVersion' | 'mode' | 'replayCases' | 'replayAgreed' | 'replayArtifact'
> & {
  lastDemotedDecision: Date | null;
  lastDemotedAt: Date | null;
};
const classSchema = new Schema<AdminAiClassState>(
  {
    feature: { type: String, enum: ADMIN_AI_FEATURES, required: true },
    actionClass: { type: String, required: true },
    policyVersion: { type: String, required: true },
    mode: { type: String, enum: ADMIN_AI_MODES, default: 'shadow' },
    replayCases: { type: Number, min: 0, default: 0 },
    replayAgreed: { type: Number, min: 0, default: 0 },
    replayArtifact: { type: String, default: '' },
    lastDemotedDecision: { type: Date, default: null },
    lastDemotedAt: { type: Date, default: null },
  },
  { collection: 'AdminAiClass', versionKey: false }
);
classSchema.index({ feature: 1, actionClass: 1, policyVersion: 1 }, { unique: true });
export const AdminAiClassModel =
  (mongoose.models.AdminAiClass as mongoose.Model<AdminAiClassState> | undefined) ??
  model<AdminAiClassState>('AdminAiClass', classSchema);
