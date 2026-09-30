import mongoose from 'mongoose';
import type { IQaTestResultDocument, QaTestStatus } from '@bike4mind/common';

interface IQaTestResultModel extends mongoose.Model<IQaTestResultDocument> {}

const QaArtifactSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['screenshot', 'video', 'trace'], required: true },
    key: { type: String, required: true },
    bytes: { type: Number, required: true },
  },
  { _id: false }
);

const QaTestResultSchema = new mongoose.Schema<IQaTestResultDocument>(
  {
    runId: { type: String, required: true },
    testKey: { type: String, required: true },
    title: { type: String, required: true },
    status: {
      type: String,
      enum: ['passed', 'failed', 'flaky', 'skipped', 'notStarted'] satisfies QaTestStatus[],
      required: true,
    },
    durationMs: { type: Number, required: true },
    retries: { type: Number, required: true },
    error: { type: String },
    artifacts: { type: [QaArtifactSchema], default: [] },
  },
  { timestamps: true }
);

// ~1M rows a year. runId + testKey: a run's tests, one row each, so a concurrent re-ingest of
// the same run cannot double them (ingestRun.ts tolerates the duplicate-key errors). testKey +
// _id desc: a test's recent history.
QaTestResultSchema.index({ runId: 1, testKey: 1 }, { unique: true });
QaTestResultSchema.index({ testKey: 1, _id: -1 });

export const QaTestResult: IQaTestResultModel =
  (mongoose.models.QaTestResult as IQaTestResultModel) ||
  mongoose.model<IQaTestResultDocument, IQaTestResultModel>('QaTestResult', QaTestResultSchema);
