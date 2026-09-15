import mongoose, { Schema, model, Document, Model } from 'mongoose';
import type { Annotation as AnnotationData } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * Annotation - the collaboration layer on top of PublishedArtifact. One record
 * per comment/approval/vote/signature, joined to its artifact by `publicId`.
 * The `kind` discriminator is generic (v1 writes only `comment`); annotations
 * are immutable except for body edits and resolution, and soft-deleted (never
 * hard-deleted) so the collection doubles as an audit trail for the future
 * approval/signature surfaces.
 *
 * Indexes are declared via schema.index() per the repo's MongoDB Index
 * Guidelines (no `index: true` on fields).
 */
export interface IAnnotationDocument extends Omit<AnnotationData, 'id' | 'createdAt' | 'updatedAt'>, Document {
  id: string; // required by IMongoDocument (Mongoose's Document.id is optional)
  createdAt: Date;
  updatedAt: Date;
  softDelete(deletedBy?: string): Promise<IAnnotationDocument>;
  restore(): Promise<IAnnotationDocument>;
}

const AnchorSubSchema = new Schema(
  {
    x: { type: Number, min: 0, max: 1 },
    y: { type: Number, min: 0, max: 1 },
    selector: { type: String, maxlength: 1024 },
    scrollSection: { type: String, maxlength: 256 },
  },
  { _id: false }
);

const PayloadSubSchema = new Schema(
  {
    decision: { type: String, enum: ['approve', 'reject'] },
    choice: { type: String, maxlength: 256 },
    signedName: { type: String, maxlength: 200 },
    signatureHash: { type: String, maxlength: 128 },
  },
  { _id: false }
);

const AnnotationSchema = new Schema(
  {
    /** FK -> PublishedArtifact.publicId. */
    publicId: { type: String, required: true },
    /** PublishedArtifact.sha256Index at the time the annotation was made. */
    artifactVersionSha: { type: String },

    kind: { type: String, required: true, enum: ['comment', 'approval', 'vote', 'signature'], default: 'comment' },

    authorId: { type: String, required: true },
    authorDisplayName: { type: String, required: true, maxlength: 200 },

    body: { type: String, required: true, maxlength: 5000 },
    anchor: { type: AnchorSubSchema },

    threadRootId: { type: String, default: null },
    payload: { type: PayloadSubSchema },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'annotations',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes (all declared here per MongoDB Index Guidelines).
// Render a thread: every non-deleted annotation on an artifact, oldest first.
AnnotationSchema.index({ publicId: 1, deletedAt: 1, createdAt: 1 });
// Filter an artifact's annotations by kind (comments vs approvals vs signatures).
AnnotationSchema.index({ publicId: 1, kind: 1, deletedAt: 1 });
// A user's authored annotations, recency-ordered - backs the per-author
// anti-spam throttle ({ authorId, createdAt: { $gte } }) and recent-activity.
AnnotationSchema.index({ authorId: 1, createdAt: -1 });
// Threaded replies under a root.
AnnotationSchema.index({ threadRootId: 1 });

AnnotationSchema.virtual('isDeleted').get(function () {
  return this.deletedAt != null;
});

AnnotationSchema.methods.softDelete = function (deletedBy?: string) {
  this.deletedAt = new Date();
  if (deletedBy) this.deletedBy = deletedBy;
  return this.save();
};

AnnotationSchema.methods.restore = function () {
  this.deletedAt = null;
  this.deletedBy = null;
  return this.save();
};

export const Annotation =
  (mongoose.models.Annotation as mongoose.Model<IAnnotationDocument>) ||
  model<IAnnotationDocument>('Annotation', AnnotationSchema);

export class AnnotationRepository extends BaseRepository<IAnnotationDocument> {
  constructor(model: Model<IAnnotationDocument>) {
    super(model);
  }

  /** All non-deleted annotations on an artifact, oldest first (thread order). */
  async findByArtifact(publicId: string, filter: Record<string, unknown> = {}) {
    return this.model
      .find({ ...filter, publicId, deletedAt: null })
      .sort({ createdAt: 1 })
      .session(this._txn ?? null);
  }

  async countByArtifact(publicId: string): Promise<number> {
    return this.model.countDocuments({ publicId, deletedAt: null }).session(this._txn ?? null);
  }

  async findActiveById(id: string) {
    return this.findOne({ _id: id, deletedAt: null });
  }
}

export const annotationRepository = new AnnotationRepository(Annotation);
export default Annotation;
