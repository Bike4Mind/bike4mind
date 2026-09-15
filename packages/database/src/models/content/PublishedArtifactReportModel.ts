import mongoose, { Schema, model, Document, Model } from 'mongoose';
import type { PublishedArtifactReport as PublishedArtifactReportData } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * PublishedArtifactReport - abuse reports filed against a public `/p/...` page.
 * Each report is its own row (an audit trail), while the
 * aggregate `reportCount` / `moderationStatus` live on the PublishedArtifact so
 * the admin queue can sort without a join. Reporter id is nullable to allow
 * unauthenticated reports if the intake ever opens up; today the route requires
 * auth and dedupes per (artifact, reporter).
 *
 * Retention: resolved reports are kept indefinitely on purpose (moderation audit
 * trail), so there is deliberately no TTL index. Growth is a long-horizon,
 * low-volume concern (reports are admin-actioned, not high-traffic); archival or
 * rollup can be added later if the collection ever warrants it.
 */
export interface IPublishedArtifactReportDocument
  extends Omit<PublishedArtifactReportData, 'createdAt' | 'updatedAt'>, Document {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

const PublishedArtifactReportSchema = new Schema(
  {
    publicId: { type: String, required: true },
    artifactId: { type: String, required: true },
    reporterId: { type: String, default: null },
    reason: {
      type: String,
      required: true,
      enum: ['spam', 'phishing', 'malware', 'abuse', 'copyright', 'other'],
    },
    details: { type: String, maxlength: 2000 },
    status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open' },
    resolvedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'published_artifact_reports',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes (per MongoDB Index Guidelines)
// One open report per (artifact, reporter) - dedupes repeat flagging without
// blocking a fresh report after the prior one is resolved.
PublishedArtifactReportSchema.index(
  { publicId: 1, reporterId: 1 },
  { unique: true, partialFilterExpression: { status: 'open', reporterId: { $type: 'string' } } }
);
PublishedArtifactReportSchema.index({ status: 1, createdAt: -1 }); // moderation queue
PublishedArtifactReportSchema.index({ publicId: 1, createdAt: -1 }); // reports for one artifact

export const PublishedArtifactReport =
  (mongoose.models.PublishedArtifactReport as mongoose.Model<IPublishedArtifactReportDocument>) ||
  model<IPublishedArtifactReportDocument>('PublishedArtifactReport', PublishedArtifactReportSchema);

export class PublishedArtifactReportRepository extends BaseRepository<IPublishedArtifactReportDocument> {
  constructor(model: Model<IPublishedArtifactReportDocument>) {
    super(model);
  }

  /** Open reports for one artifact, newest first. */
  async findOpenByPublicId(publicId: string) {
    return this.find({ publicId, status: 'open' });
  }
}

export const publishedArtifactReportRepository = new PublishedArtifactReportRepository(PublishedArtifactReport);
export default PublishedArtifactReport;
