import mongoose, { Document, Model, Schema, model } from 'mongoose';
import type { ISkillListingVersion } from '@bike4mind/common';

/**
 * An immutable snapshot of a skill submitted to the Skill Market, plus its scan verdict and review
 * outcome. The scan uses the claim-stamp shape of file moderation (apps/client/server/s3/
 * moderationScan.ts): `scanClaimedAt` is the claim's identity and the verdict write is guarded on
 * it, so a retried or concurrent scan can never overwrite another's verdict.
 */
export interface ISkillListingVersionDocument extends Omit<ISkillListingVersion, 'id'>, Document {
  id: string;
}

const FindingSchema = new Schema(
  {
    rule: { type: String, required: true },
    severity: { type: String, required: true, enum: ['critical', 'high', 'medium', 'low'] },
    message: { type: String, required: true, maxlength: 500 },
    excerpt: { type: String, maxlength: 300 },
    source: { type: String, required: true, enum: ['rules', 'classifier'] },
  },
  { _id: false }
);

const SkillListingVersionSchema = new Schema<ISkillListingVersionDocument>(
  {
    listingId: { type: String, required: true },
    version: { type: Number, required: true },
    snapshot: {
      name: { type: String, required: true, maxlength: 64 },
      description: { type: String, required: true, maxlength: 500 },
      body: { type: String, required: true, maxlength: 50_000 },
      argumentHint: { type: String, maxlength: 200 },
      allowedTools: { type: [String], default: undefined },
      disableModelInvocation: { type: Boolean },
    },
    contentHash: { type: String, required: true },

    scanStatus: { type: String, required: true, enum: ['scanning', 'passed', 'failed', 'error'] },
    scanClaimedAt: { type: Date, default: null },
    scanFindings: { type: [FindingSchema], default: [] },
    scanModel: { type: String },
    scanError: { type: String, maxlength: 500 },
    riskTier: { type: String, enum: ['clean', 'review', 'high'] },
    honestSummary: {
      type: new Schema(
        {
          whatItDoes: { type: String, maxlength: 1000 },
          toolsUsed: { type: [String], default: [] },
          dataItTouches: { type: String, maxlength: 500 },
          riskNotes: { type: [String], default: [] },
          descriptionMatches: { type: Boolean },
          mismatchNote: { type: String, maxlength: 500 },
        },
        { _id: false }
      ),
      default: undefined,
    },

    reviewStatus: {
      type: String,
      required: true,
      enum: ['not_required', 'pending', 'auto_approved', 'approved', 'rejected', 'superseded'],
      default: 'not_required',
    },
    reviewerUserId: { type: String },
    reviewNote: { type: String, maxlength: 2000 },
    reviewedAt: { type: Date },
    reviewAckMismatch: { type: Boolean },
    reviewAckHighRisk: { type: Boolean },

    auditSample: { type: Boolean, default: false },
    auditedAt: { type: Date, default: null },
    auditedByUserId: { type: String },
    reminderSentAt: { type: Date, default: null },
    reminderCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: 'skill_listing_versions',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SkillListingVersionSchema.index({ listingId: 1, version: 1 }, { unique: true });
SkillListingVersionSchema.index({ reviewStatus: 1, createdAt: 1 });
SkillListingVersionSchema.index({ auditSample: 1, auditedAt: 1 });
SkillListingVersionSchema.index({ contentHash: 1 });

export const SkillListingVersion: Model<ISkillListingVersionDocument> =
  (mongoose.models.SkillListingVersion as Model<ISkillListingVersionDocument>) ??
  model<ISkillListingVersionDocument>('SkillListingVersion', SkillListingVersionSchema);

export type SkillScanVerdictPatch = Pick<ISkillListingVersion, 'scanStatus' | 'scanFindings' | 'reviewStatus'> &
  Partial<Pick<ISkillListingVersion, 'riskTier' | 'honestSummary' | 'scanModel' | 'scanError' | 'auditSample'>>;

/**
 * Re-claim a version for scanning (the rescan path). Only an `error` verdict, or a `scanning`
 * claim older than `staleBefore` (its request died mid-scan), can be re-claimed.
 */
export async function claimSkillVersionScan(versionId: string, claimedAt: Date, staleBefore: Date) {
  return SkillListingVersion.findOneAndUpdate(
    {
      _id: versionId,
      $or: [{ scanStatus: 'error' }, { scanStatus: 'scanning', scanClaimedAt: { $lt: staleBefore } }],
    },
    { $set: { scanStatus: 'scanning', scanClaimedAt: claimedAt, scanFindings: [] }, $unset: { scanError: 1 } },
    { new: true }
  );
}

/** Write the scan verdict only if `claimedAt` is still this version's claim. Returns whether it landed. */
export async function writeSkillVersionScanVerdict(
  versionId: string,
  claimedAt: Date,
  patch: SkillScanVerdictPatch
): Promise<boolean> {
  const res = await SkillListingVersion.updateOne(
    { _id: versionId, scanStatus: 'scanning', scanClaimedAt: claimedAt },
    { $set: { ...patch, scanClaimedAt: null } }
  );
  return res.modifiedCount > 0;
}

export default SkillListingVersion;
