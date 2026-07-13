import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Audit trail of authenticated views of a GATED published artifact - "which
 * account viewed which shared item, and when" (issue #408). Gate-kind-agnostic
 * on purpose: today only the `domain` gate writes here (its viewers are logged-in
 * accounts), but the `passphrase` gate (Tier 2) can reuse the same model without
 * a schema change.
 *
 * This is per-account attribution, distinct from the aggregate viewCount /
 * externalViewCount counters on PublishedArtifact.
 */
export type PublishedArtifactViewGateKind = 'domain' | 'passphrase';

export interface IPublishedArtifactViewAuditDocument extends Document {
  id: string;
  /** The artifact's publicId (share-stable identifier). */
  publicId: string;
  /** The viewing account's user id. */
  viewerId: string;
  gateKind: PublishedArtifactViewGateKind;
  /** Registrable domain (eTLD+1) of the viewer's verified email, when known. */
  viewerEmailDomain?: string;
  sourceIp?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date; // Required by IMongoDocument constraint; not auto-set (timestamps.updatedAt: false)
}

export interface CreatePublishedArtifactViewAuditInput {
  publicId: string;
  viewerId: string;
  gateKind: PublishedArtifactViewGateKind;
  viewerEmailDomain?: string;
  sourceIp?: string;
  userAgent?: string;
}

const PublishedArtifactViewAuditSchema = new Schema<IPublishedArtifactViewAuditDocument>(
  {
    publicId: { type: String, required: true },
    viewerId: { type: String, required: true },
    gateKind: { type: String, required: true, enum: ['domain', 'passphrase'] },
    viewerEmailDomain: { type: String },
    sourceIp: { type: String },
    userAgent: { type: String },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

PublishedArtifactViewAuditSchema.index({ publicId: 1, createdAt: -1 });
PublishedArtifactViewAuditSchema.index({ viewerId: 1, createdAt: -1 });
// Auto-expire after 90 days, consistent with the other audit logs.
PublishedArtifactViewAuditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

class PublishedArtifactViewAuditRepository extends BaseRepository<IPublishedArtifactViewAuditDocument> {
  constructor() {
    super(PublishedArtifactViewAuditModel);
  }

  async createLog(data: CreatePublishedArtifactViewAuditInput): Promise<IPublishedArtifactViewAuditDocument> {
    const result = await this.model.create(data);
    return result.toJSON() as unknown as IPublishedArtifactViewAuditDocument;
  }
}

export const PublishedArtifactViewAuditModel: Model<IPublishedArtifactViewAuditDocument> =
  (mongoose.models.PublishedArtifactViewAudit as unknown as Model<IPublishedArtifactViewAuditDocument>) ??
  model<IPublishedArtifactViewAuditDocument>('PublishedArtifactViewAudit', PublishedArtifactViewAuditSchema);

export const publishedArtifactViewAuditRepository = new PublishedArtifactViewAuditRepository();
