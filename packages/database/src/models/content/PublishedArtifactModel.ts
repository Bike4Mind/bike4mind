import mongoose, { Schema, model, Document, Model } from 'mongoose';
import type { PublishedArtifact as PublishedArtifactData } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * PublishedArtifact - B4M's instantiation of the `artifact-publishing` blueprint.
 * One record backs all three share surfaces (bundle / reply / fabfile) via the
 * `source` discriminator. Primary key is the compound triple { tier, scopeId, slug },
 * unique among non-deleted rows; `publicId` is the short id used in `/p/...` URLs.
 *
 * Mongoose's default `id` virtual (hex of `_id`) satisfies IMongoDocument, so no
 * custom `id` field is needed. Indexes are declared via schema.index() per the
 * repo's MongoDB Index Guidelines (no `index: true` on fields).
 */
export interface IPublishedArtifactDocument extends Omit<PublishedArtifactData, 'createdAt' | 'updatedAt'>, Document {
  id: string; // required by IMongoDocument (Mongoose's Document.id is optional)
  createdAt: Date;
  updatedAt: Date;
  softDelete(deletedBy?: string): Promise<IPublishedArtifactDocument>;
  restore(): Promise<IPublishedArtifactDocument>;
}

const ArtifactFileSubSchema = new Schema(
  {
    path: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    mimeType: { type: String, required: true },
    sha256: { type: String, required: true },
  },
  { _id: false }
);

const SizeSubSchema = new Schema(
  {
    totalBytes: { type: Number, required: true, min: 0, default: 0 },
    fileCount: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false }
);

const VersionMetaSubSchema = new Schema(
  {
    publishedAt: { type: Date, required: true },
    publishedBy: { type: String, required: true },
    size: { type: SizeSubSchema, required: true },
    sha256Index: { type: String, required: true },
  },
  { _id: false }
);

const SourceSubSchema = new Schema(
  {
    kind: { type: String, required: true, enum: ['bundle', 'reply', 'fabfile'] },
    artifactId: { type: String },
    sessionId: { type: String },
    messageId: { type: String },
    fabFileId: { type: String },
  },
  { _id: false }
);

const PublishedArtifactSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },

    // Compound primary key
    tier: { type: String, required: true, enum: ['user', 'project', 'organization'] },
    scopeId: { type: String, required: true },
    slug: { type: String, required: true },

    title: { type: String, required: true, maxlength: 200 },
    description: { type: String, maxlength: 1000 },

    visibility: {
      type: String,
      enum: ['private', 'project', 'organization', 'public'],
      default: 'private',
    },
    gatedToGroupId: { type: String },

    /** Collaboration gate: who (among viewers) may annotate. Orthogonal to
     *  `visibility` (who may view). Defaults to `none` so existing artifacts
     *  stay read-only until the owner opts in. */
    commentPolicy: {
      type: String,
      enum: ['none', 'open', 'restricted'],
      default: 'none',
    },

    ownerId: { type: String, required: true },
    lastPublishedBy: { type: String },

    source: { type: SourceSubSchema, required: true },

    storageKeyPrefix: { type: String, default: '' },
    size: { type: SizeSubSchema, required: true, default: () => ({ totalBytes: 0, fileCount: 0 }) },
    sha256Index: { type: String },
    manifest: { type: [ArtifactFileSubSchema], default: [] },
    declaredApiEndpoints: { type: [String], default: [] },

    /** Body snapshot for reply/fabfile viewer pages (markdown/text). */
    renderedBody: { type: String },

    publishedAt: { type: Date, default: Date.now },
    previousVersionMeta: { type: VersionMetaSubSchema },
    /** Full version history (oldest -> newest), appended on every publish/revise/
     *  restore. Each entry's bytes are archived at `{storageKeyPrefix}versions/
     *  {sha256Index}.html`. Enables walking across versions + restore-to-any. */
    versions: { type: [VersionMetaSubSchema], default: [] },
    viewCount: { type: Number, default: 0, min: 0 },

    /** Concurrency lock for AI revise - set while a revision is in flight,
     *  cleared when it finishes (or expires). Prevents two concurrent revisions
     *  from clobbering each other's version. */
    revisingAt: { type: Date, default: null },

    // Moderation
    moderationStatus: {
      type: String,
      enum: ['active', 'reported', 'taken_down'],
      default: 'active',
    },
    reportCount: { type: Number, default: 0, min: 0 },
    takedownReason: { type: String, default: null },

    // Soft-delete markers (default null so the partial unique index applies cleanly)
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'published_artifacts',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes (all declared here per MongoDB Index Guidelines)
// Compound primary key, unique among non-deleted rows so a soft-deleted artifact
// does not block re-publishing the same slug.
PublishedArtifactSchema.index(
  { tier: 1, scopeId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);
PublishedArtifactSchema.index({ ownerId: 1, deletedAt: 1 }); // a user's published artifacts
PublishedArtifactSchema.index({ visibility: 1, deletedAt: 1 }); // public listing / gate
PublishedArtifactSchema.index({ 'source.kind': 1, 'source.sessionId': 1 }); // reply lookups
PublishedArtifactSchema.index({ 'source.fabFileId': 1 }); // fabfile lookups
// "Is this notebook artifact already published?" drives the publish dialog's
// update-existing-vs-new choice. Scoped by owner so the lookup matches the
// caller's own publication of that artifact.
PublishedArtifactSchema.index({ 'source.artifactId': 1, ownerId: 1, deletedAt: 1 });
PublishedArtifactSchema.index({ publishedAt: -1 }); // recency
PublishedArtifactSchema.index({ moderationStatus: 1, reportCount: -1 }); // admin moderation queue
PublishedArtifactSchema.index({ tier: 1, scopeId: 1, deletedAt: 1 }); // org-scope quota aggregation

PublishedArtifactSchema.virtual('isDeleted').get(function () {
  return this.deletedAt != null;
});

PublishedArtifactSchema.methods.softDelete = function (deletedBy?: string) {
  this.deletedAt = new Date();
  if (deletedBy) this.deletedBy = deletedBy;
  return this.save();
};

PublishedArtifactSchema.methods.restore = function () {
  this.deletedAt = null;
  this.deletedBy = null;
  return this.save();
};

export const PublishedArtifact =
  (mongoose.models.PublishedArtifact as mongoose.Model<IPublishedArtifactDocument>) ||
  model<IPublishedArtifactDocument>('PublishedArtifact', PublishedArtifactSchema);

export class PublishedArtifactRepository extends BaseRepository<IPublishedArtifactDocument> {
  constructor(model: Model<IPublishedArtifactDocument>) {
    super(model);
  }

  async findByPublicId(publicId: string) {
    return this.findOne({ publicId, deletedAt: null });
  }

  /** Look up by the compound key, non-deleted only. */
  async findByKey(tier: string, scopeId: string, slug: string) {
    return this.findOne({ tier, scopeId, slug, deletedAt: null });
  }

  async findActive(filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, deletedAt: null });
  }

  async findByOwner(ownerId: string, filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, ownerId, deletedAt: null });
  }

  async softDeleteByPublicId(publicId: string, deletedBy?: string): Promise<boolean> {
    const query = this.model.findOne({ publicId, deletedAt: null });
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity.
    if (this._txn) {
      query.session(this._txn);
    }
    const doc = await query;
    if (!doc) return false;
    await doc.softDelete(deletedBy);
    return true;
  }
}

export const publishedArtifactRepository = new PublishedArtifactRepository(PublishedArtifact);
export default PublishedArtifact;
