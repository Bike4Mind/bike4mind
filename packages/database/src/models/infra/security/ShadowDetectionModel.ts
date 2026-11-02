import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import {
  SHADOW_DETECTION_ACTIONS,
  SHADOW_DETECTION_VERDICTS,
  SHADOW_DETECTORS,
  type ShadowDetectionAction,
  type ShadowDetectionItem,
  type ShadowDetectionNetwork,
  type ShadowDetectionSignal,
  type ShadowDetectionSummaryRow,
  type ShadowDetectionVerdict,
  type ShadowDetectionVerdictEntry,
  type ShadowDetector,
} from '@bike4mind/common';

/**
 * What an abuse detector would have done, recorded without acting (contract and rationale in
 * b4m-core/common/src/schemas/shadowDetection.ts). Admins grade each record; verdicts append, so a
 * correction never rewrites the history the precision numbers were taken from.
 */
export interface IShadowDetectionDocument extends Document {
  detector: ShadowDetector;
  policyVersion: number;
  wouldAction: ShadowDetectionAction;
  summary: string;
  userIds: string[];
  network: ShadowDetectionNetwork | null;
  signals: ShadowDetectionSignal[];
  windowMinutes: number | null;
  detectedAt: Date;
  verdict: ShadowDetectionVerdict | null;
  verdicts: ShadowDetectionVerdictEntry[];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const RETENTION_SECONDS = 365 * 24 * 60 * 60;

const NetworkSchema = new Schema<ShadowDetectionNetwork>(
  {
    ip: { type: String, default: null },
    asn: { type: Number, default: null },
    asnOrg: { type: String, default: null },
    country: { type: String, default: null },
    hosting: { type: Boolean, default: null },
  },
  { _id: false }
);

const SignalSchema = new Schema<ShadowDetectionSignal>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    observed: { type: Number, default: null },
    threshold: { type: Number, default: null },
  },
  { _id: false }
);

const VerdictEntrySchema = new Schema<ShadowDetectionVerdictEntry>(
  {
    verdict: { type: String, enum: SHADOW_DETECTION_VERDICTS, required: true },
    reason: { type: String, required: true },
    reviewerId: { type: String, required: true },
    reviewedAt: { type: Date, required: true },
  },
  { _id: false }
);

export const ShadowDetectionSchema = new Schema<IShadowDetectionDocument>(
  {
    detector: { type: String, enum: SHADOW_DETECTORS, required: true },
    policyVersion: { type: Number, required: true },
    wouldAction: { type: String, enum: SHADOW_DETECTION_ACTIONS, required: true },
    summary: { type: String, required: true },
    userIds: { type: [String], default: [] },
    network: { type: NetworkSchema, default: null },
    signals: { type: [SignalSchema], default: [] },
    windowMinutes: { type: Number, default: null },
    detectedAt: { type: Date, required: true },
    verdict: { type: String, enum: [...SHADOW_DETECTION_VERDICTS, null], default: null },
    verdicts: { type: [VerdictEntrySchema], default: [] },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'ShadowDetection' }
);

// Retention: the record carries a raw IP, so it does not outlive a year. The unfiltered newest-first
// list ({ detectedAt: -1, _id: -1 }) gets no index of its own: volume is low, and the sort is cheap.
ShadowDetectionSchema.index({ detectedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
ShadowDetectionSchema.index({ detector: 1, verdict: 1, detectedAt: -1 });
ShadowDetectionSchema.index({ userIds: 1 });

export const ShadowDetectionModel: Model<IShadowDetectionDocument> =
  (mongoose.models.ShadowDetection as unknown as Model<IShadowDetectionDocument>) ??
  model<IShadowDetectionDocument>('ShadowDetection', ShadowDetectionSchema);

export type RecordShadowDetectionInput = Omit<ShadowDetectionItem, 'id' | 'verdict' | 'verdicts' | 'revision'>;

export type AddShadowDetectionVerdictResult =
  | { status: 'updated'; item: ShadowDetectionItem }
  | { status: 'conflict'; item: ShadowDetectionItem }
  | { status: 'not_found' };

type LeanShadowDetection = Omit<IShadowDetectionDocument, keyof Document> & { _id: Types.ObjectId };

const VERDICT_COUNT_FIELDS = {
  confirmed_abuse: 'confirmedAbuse',
  legitimate_human: 'legitimateHuman',
  legitimate_automation: 'legitimateAutomation',
  insufficient_evidence: 'insufficientEvidence',
} as const satisfies Record<ShadowDetectionVerdict, keyof ShadowDetectionSummaryRow>;

const toItem = (doc: LeanShadowDetection): ShadowDetectionItem => ({
  id: doc._id.toString(),
  detector: doc.detector,
  policyVersion: doc.policyVersion,
  wouldAction: doc.wouldAction,
  summary: doc.summary,
  userIds: doc.userIds ?? [],
  network: doc.network
    ? {
        ip: doc.network.ip ?? null,
        asn: doc.network.asn ?? null,
        asnOrg: doc.network.asnOrg ?? null,
        country: doc.network.country ?? null,
        hosting: doc.network.hosting ?? null,
      }
    : null,
  signals: (doc.signals ?? []).map(signal => ({
    key: signal.key,
    label: signal.label,
    observed: signal.observed ?? null,
    threshold: signal.threshold ?? null,
  })),
  windowMinutes: doc.windowMinutes ?? null,
  detectedAt: doc.detectedAt,
  verdict: doc.verdict ?? null,
  verdicts: (doc.verdicts ?? []).map(entry => ({
    verdict: entry.verdict,
    reason: entry.reason,
    reviewerId: entry.reviewerId,
    reviewedAt: entry.reviewedAt,
  })),
  revision: doc.revision ?? 0,
});

class ShadowDetectionRepository {
  async record(input: RecordShadowDetectionInput): Promise<string> {
    const doc = await ShadowDetectionModel.create(input);
    return doc._id.toString();
  }

  /** Newest first; `truncated` is true when more than `limit` records match. */
  async list(query: {
    detector?: ShadowDetector;
    verdict?: ShadowDetectionVerdict | 'unreviewed';
    limit: number;
  }): Promise<{ data: ShadowDetectionItem[]; truncated: boolean }> {
    const filter: Record<string, unknown> = {};
    if (query.detector) filter.detector = query.detector;
    if (query.verdict) filter.verdict = query.verdict === 'unreviewed' ? null : query.verdict;
    const docs = await ShadowDetectionModel.find(filter)
      .sort({ detectedAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<LeanShadowDetection[]>();
    return { data: docs.slice(0, query.limit).map(toItem), truncated: docs.length > query.limit };
  }

  /**
   * Appends a verdict when the record is still at `expectedRevision`, in one atomic update, so two
   * reviewers grading the same record cannot overwrite each other: the loser gets the current record
   * back as a conflict.
   */
  async addVerdict(input: {
    id: string;
    expectedRevision: number;
    verdict: ShadowDetectionVerdict;
    reason: string;
    reviewerId: string;
  }): Promise<AddShadowDetectionVerdictResult> {
    if (!Types.ObjectId.isValid(input.id)) return { status: 'not_found' };
    const entry: ShadowDetectionVerdictEntry = {
      verdict: input.verdict,
      reason: input.reason,
      reviewerId: input.reviewerId,
      reviewedAt: new Date(),
    };
    const updated = await ShadowDetectionModel.findOneAndUpdate(
      { _id: input.id, revision: input.expectedRevision },
      { $push: { verdicts: entry }, $set: { verdict: input.verdict }, $inc: { revision: 1 } },
      { new: true }
    ).lean<LeanShadowDetection>();
    if (updated) return { status: 'updated', item: toItem(updated) };

    const current = await ShadowDetectionModel.findById(input.id).lean<LeanShadowDetection>();
    return current ? { status: 'conflict', item: toItem(current) } : { status: 'not_found' };
  }

  /** Counts per detector and policy version; verdict counts are on each record's latest verdict. */
  async summarize(): Promise<ShadowDetectionSummaryRow[]> {
    const rows = await ShadowDetectionModel.aggregate<{
      _id: { detector: ShadowDetector; policyVersion: number; verdict: ShadowDetectionVerdict | null };
      count: number;
    }>([
      {
        $group: {
          _id: { detector: '$detector', policyVersion: '$policyVersion', verdict: { $ifNull: ['$verdict', null] } },
          count: { $sum: 1 },
        },
      },
    ]);

    const byPolicy = new Map<string, ShadowDetectionSummaryRow>();
    for (const { _id, count } of rows) {
      const key = `${_id.detector}:${_id.policyVersion}`;
      const row = byPolicy.get(key) ?? {
        detector: _id.detector,
        policyVersion: _id.policyVersion,
        recorded: 0,
        confirmedAbuse: 0,
        legitimateHuman: 0,
        legitimateAutomation: 0,
        insufficientEvidence: 0,
      };
      row.recorded += count;
      if (_id.verdict) row[VERDICT_COUNT_FIELDS[_id.verdict]] += count;
      byPolicy.set(key, row);
    }
    return [...byPolicy.values()].sort(
      (left, right) => left.detector.localeCompare(right.detector) || right.policyVersion - left.policyVersion
    );
  }
}

export const shadowDetectionRepository = new ShadowDetectionRepository();
