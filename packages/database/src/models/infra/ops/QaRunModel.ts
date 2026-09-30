import mongoose from 'mongoose';
import type { IQaRunDocument, QaRunSource, QaRunStatus } from '@bike4mind/common';

interface IQaRunModel extends mongoose.Model<IQaRunDocument> {}

const QaMetricSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['credits', 'latency'], required: true },
    model: { type: String, required: true },
    label: { type: String },
    value: { type: Number, required: true },
    unit: { type: String, required: true },
    threshold: { type: Number },
  },
  { _id: false }
);

const QaSuiteSummarySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    passed: { type: Number, required: true },
    ran: { type: Number, required: true },
    notRun: { type: Number, required: true },
  },
  { _id: false }
);

/** One Playwright run for the admin /status page. Written only by apps/client/server/qa/ingestRun.ts. */
const QaRunSchema = new mongoose.Schema<IQaRunDocument>(
  {
    product: { type: String, required: true },
    tenant: { type: String },
    suite: { type: String, required: true },
    env: { type: String, required: true },
    branch: { type: String, required: true },
    trigger: { type: String, required: true },
    source: { type: String, enum: ['ci', 'slack-backfill'] satisfies QaRunSource[], required: true, default: 'ci' },
    ciRunUrl: { type: String, required: true },
    sha: { type: String, default: '' },
    startedAt: { type: Date, required: true },
    durationMs: { type: Number, required: true },
    status: { type: String, enum: ['passed', 'failed', 'infra-error'] satisfies QaRunStatus[], required: true },
    counts: {
      passed: { type: Number, required: true },
      failed: { type: Number, required: true },
      skipped: { type: Number, required: true },
      notStarted: { type: Number, required: true },
      ran: { type: Number, required: true },
      total: { type: Number, required: true },
    },
    suiteSummary: { type: [QaSuiteSummarySchema], default: [] },
    metrics: { type: [QaMetricSchema], default: [] },
    reportPrefix: { type: String },
    externalRunId: { type: String, required: true, unique: true },
    // Never in the ingest payload, so a re-ingest's $set leaves them alone. See evaluateAlarm.ts.
    alarmClaimedAt: { type: Date },
    alarmEvaluatedAt: { type: Date },
  },
  { timestamps: true }
);

// State-key lookups (alarm, tiles) and the product-wide time range (charts, run list).
QaRunSchema.index({ product: 1, tenant: 1, suite: 1, env: 1, branch: 1, startedAt: -1 });
QaRunSchema.index({ product: 1, startedAt: -1 });

export const QaRun: IQaRunModel =
  (mongoose.models.QaRun as IQaRunModel) || mongoose.model<IQaRunDocument, IQaRunModel>('QaRun', QaRunSchema);
