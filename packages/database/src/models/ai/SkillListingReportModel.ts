import mongoose, { Document, Model, Schema, model } from 'mongoose';
import type { ISkillListingReport } from '@bike4mind/common';

/**
 * Abuse reports against a Skill Market listing. Same shape as PublishedArtifactReport: one open
 * report per (listing, reporter), resolved rows kept as the moderation audit trail.
 */
export interface ISkillListingReportDocument extends Omit<ISkillListingReport, 'id'>, Document {
  id: string;
}

export const SKILL_LISTING_REPORT_REASONS = ['malicious', 'spam', 'misleading', 'abuse', 'copyright', 'other'] as const;

const SkillListingReportSchema = new Schema<ISkillListingReportDocument>(
  {
    listingId: { type: String, required: true },
    reporterId: { type: String, required: true },
    reason: { type: String, required: true, enum: SKILL_LISTING_REPORT_REASONS },
    details: { type: String, maxlength: 2000 },
    status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open' },
    resolvedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'skill_listing_reports',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

SkillListingReportSchema.index(
  { listingId: 1, reporterId: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);
SkillListingReportSchema.index({ status: 1, createdAt: -1 });

export const SkillListingReport: Model<ISkillListingReportDocument> =
  (mongoose.models.SkillListingReport as Model<ISkillListingReportDocument>) ??
  model<ISkillListingReportDocument>('SkillListingReport', SkillListingReportSchema);

export default SkillListingReport;
